/**
 * src/expansion.js
 *
 * Animated morphological expansion engine — the key feature of the app.
 *
 * ── Fixes in this version ────────────────────────────────────────────────────
 *
 *  1. SEA CLIPPING
 *     After rasterising the trail, if ANY disk center is on a static-path fill
 *     (land), all trail pixels outside land fills are zeroed out before seeds
 *     are identified.  If ALL centers are on sea, the trail is left untouched
 *     (allows drawing sea-based regions).
 *
 *  2. ZOOM / NEW-DRAW INTERRUPTION
 *     Expansion.stop()   — finalize + push to undoStack (zoom, new draw start)
 *     Expansion.cancel() — discard + restore pre-draw snapshot (Ctrl+Z during
 *                          expansion, or any other abort-without-commit path)
 *     Both cancel the rAF before the viewport changes, so tracing always runs
 *     under the same viewport that was active when drawing started.
 *
 *  3. UNDO SEMANTICS  (coordinated with drawTool.js)
 *     undoStack.push() is called ONCE per gesture, inside _finalize()/_finalizeImmediate(),
 *     AFTER the polygons have been applied to UserObjects.
 *     drawTool.mouseup no longer pushes.
 *     Ctrl+Z during expansion calls cancel() (restores pre-draw snapshot without
 *     popping the undo stack) — the in-progress gesture is simply discarded.
 *
 *  4. ERASE RIND
 *     Before building the final canvas, the erase _addedMask is dilated by 1px
 *     (within _baseMask) so the traced polygon covers the full raster boundary
 *     and Clipper difference leaves no thin outline.
 *
 *  5. ORGANIC SHAPES
 *     Each boundary pixel's advance is multiplied by _pixelNoise(px): a
 *     spatially-coherent, per-gesture-randomised sine noise in [0.6, 1.4].
 *     Nearby pixels share similar noise (coherent blobs), but the pattern is
 *     different every gesture (randomised offset).
 *
 *  6. RESISTANCE IN ENEMY TERRITORY
 *     A separate _otherObjMask is built (does NOT block; expansion still
 *     crosses into other objects).  When a frontier pixel is inside another
 *     object, the effective advance is multiplied by EXPANSION_RESISTANCE_FACTOR
 *     (see config.js), slowing but not stopping the encroachment.
 *
 * ── Raster arrays (W×H screen pixels) ────────────────────────────────────────
 *  _addedMask   Uint8Array    pixels added by seeds + expansion
 *  _baseMask    Uint8Array    original target-object pixels (fixed)
 *  _blocked     Uint8Array    pixels that hard-stop expansion
 *  _otherObjMask Uint8Array   pixels of other objects (resistance, not block)
 *  _edgeWeight  Float32Array  tentacle taper: 1.0 at base, ~0 at tip
 *  _accum       Float32Array  fractional expansion pressure per boundary px
 *  _boundary    Map<int,float> frontier: index → distFactor (1 or √2)
 */

(function (MapEditor) {
  'use strict';

  const SQRT2 = Math.SQRT2;

  // ── Module state ─────────────────────────────────────────────────────────

  let _active           = false;
  let _mode             = 'add';
  let _targetObjId      = null;
  let _targetIsNew      = false;
  let _preDrawSnapshot  = null;   // for cancel() recovery

  let _W = 0, _H = 0;

  let _addedMask;      // Uint8Array
  let _baseMask;       // Uint8Array
  let _blocked;        // Uint8Array
  let _otherObjMask;   // Uint8Array  (resistance, not hard-block)
  let _edgeWeight;     // Float32Array
  let _accum;          // Float32Array
  let _boundary;       // Map<int, float>

  let _overlayCanvas  = null;
  let _overlayCtx     = null;
  let _overlayImgData = null;
  let _overlayR = 0, _overlayG = 0, _overlayB = 0, _overlayAlpha = 240;

  let _startTime     = 0;
  let _lastFrameTime = 0;
  let _rafHandle     = null;

  let _noiseOffset   = 0;   // randomised per gesture

  // ── Public API ────────────────────────────────────────────────────────────

  const Expansion = {};

  Expansion.init = function () {
    _overlayCanvas = document.createElement('canvas');
    _overlayCtx    = _overlayCanvas.getContext('2d');
    window.addEventListener('resize', () => { if (!_active) _syncSize(); });
    _syncSize();
  };

  Expansion.isActive = () => _active;

  /** Composite live expansion overlay (screen space, no extra alpha). */
  Expansion.drawOverlay = function (ctx) {
    if (!_active || !_overlayCanvas) return;
    ctx.drawImage(_overlayCanvas, 0, 0);
  };

  /**
   * Begin expansion from the current trail canvas.
   *
   * @param {string}                      targetObjId
   * @param {'add'|'erase'}               mode
   * @param {boolean}                     targetIsNew
   * @param {Array<{sx:number,sy:number}>} diskCenters   screen-space disk centers
   * @param {object}                      preDrawSnapshot snapshot for cancel()
   */
  Expansion.start = function (targetObjId, mode, targetIsNew, diskCenters, preDrawSnapshot) {
    if (_active) _cancel();   // shouldn't normally happen

    _syncSize();
    if (_W === 0 || _H === 0) return;

    _mode            = mode;
    _targetObjId     = targetObjId;
    _targetIsNew     = targetIsNew;
    _preDrawSnapshot = preDrawSnapshot || null;
    _noiseOffset     = Math.random() * 1000;

    const viewport = MapEditor.viewport;
    const n        = _W * _H;

    // ── Get trail ──────────────────────────────────────────────────────
    const trailCanvas = MapEditor.RasterOps.getTrailCanvas();
    const trailData   = _readAlpha(trailCanvas);   // mutable copy

    // ── Sea clipping ───────────────────────────────────────────────────
    // If ANY disk center lands on a static fill (land), clip the trail
    // so that pixels outside land fills are removed.  This prevents
    // over-water expansion when the user draws near a coastline.
    // Exception: if ALL centers are on sea, allow the full trail (sea region).
    const landCanvas = MapEditor.RasterOps.renderStaticPathFillMask(viewport);
    const landData   = _readAlpha(landCanvas);
    const hasAnyLand = landData.indexOf(1) >= 0;

    if (hasAnyLand && diskCenters && diskCenters.length > 0) {
      let anyOnLand = false;
      for (const { sx, sy } of diskCenters) {
        const ix = Math.round(sx), iy = Math.round(sy);
        if (ix >= 0 && ix < _W && iy >= 0 && iy < _H) {
          if (landData[iy * _W + ix]) { anyOnLand = true; break; }
        }
      }
      if (anyOnLand) {
        // Remove trail pixels that are outside all land fills.
        for (let px = 0; px < n; px++) {
          if (!landData[px]) trailData[px] = 0;
        }
      }
    }

    // ── Rasterise target object ────────────────────────────────────────
    const objCanvas = MapEditor.RasterOps.renderObjectMask(
      MapEditor.UserObjects.getById(targetObjId) || { shapes: [] }, viewport
    );
    _baseMask = _readAlpha(objCanvas);

    // ── Other-object mask (resistance, NOT hard-block) ─────────────────
    _otherObjMask = _buildOtherObjMask(targetObjId, viewport);

    // ── Blocked mask (static strokes + erase-mode boundary) ───────────
    _blocked = _buildBlockedMask(viewport);

    // ── Identify seeds ─────────────────────────────────────────────────
    _addedMask  = new Uint8Array(n);
    _edgeWeight = new Float32Array(n);
    _accum      = new Float32Array(n);
    _boundary   = new Map();

    let hasSeeds = false;
    for (let px = 0; px < n; px++) {
      if (!trailData[px]) continue;
      const inObj = !!_baseMask[px];
      if (mode === 'add'   && !inObj) { _addedMask[px] = 1; hasSeeds = true; }
      if (mode === 'erase' && inObj)  { _addedMask[px] = 1; hasSeeds = true; }
    }

    if (!hasSeeds) {
      // Trail entirely inside (add) or outside (erase) → commit immediately.
      _finalizeImmediate(trailData);
      return;
    }

    // ── Edge weights (tentacle taper) ──────────────────────────────────
    _computeEdgeWeights(trailData);

    // ── Build initial frontier ─────────────────────────────────────────
    for (let px = 0; px < n; px++) {
      if (!_addedMask[px]) continue;
      _forEachNeighbor8(px, (npx, df) => {
        if (_addedMask[npx] || _blocked[npx]) return;
        if (!_boundary.has(npx) || _boundary.get(npx) > df) {
          _boundary.set(npx, df);
        }
      });
    }

    // ── Overlay colour ─────────────────────────────────────────────────
    if (mode === 'add') {
      const obj = MapEditor.UserObjects.getById(targetObjId);
      const rgb = MapEditor.ColorUtils.hexToRgb(obj ? obj.color : '#ffffff');
      _overlayR = rgb.r; _overlayG = rgb.g; _overlayB = rgb.bv;
      _overlayAlpha = 245;   // near-opaque → growth blends with existing fill
    } else {
      _overlayR = 210; _overlayG = 45; _overlayB = 45;
      _overlayAlpha = 150;
    }

    _overlayCtx.clearRect(0, 0, _W, _H);
    _overlayImgData = _overlayCtx.createImageData(_W, _H);
    _paintMask(_addedMask);

    // ── Start animation ────────────────────────────────────────────────
    _active        = true;
    _startTime     = performance.now();
    _lastFrameTime = _startTime;
    _rafHandle     = requestAnimationFrame(_frame);
  };

  /**
   * Finalize with current mask (stop animation, commit polygons, push undo).
   * Called from: zoom wheel, new draw mousedown, Space key.
   */
  Expansion.stop = function () {
    if (!_active) return;
    _finalize();
  };

  /**
   * Discard the in-progress expansion and restore the pre-draw state.
   * Called from: Ctrl+Z during expansion.
   * Does NOT push to undoStack.
   */
  Expansion.cancel = function () {
    if (!_active) return;
    if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
    _active = false;

    // Restore state to what it was before the draw gesture began.
    if (_preDrawSnapshot) {
      MapEditor.UserObjects.applySnapshot(_preDrawSnapshot);
    }
    _cleanup();

    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) {
      MapEditor.UI.refreshUndoButtons();
    }
  };

  // ── rAF frame ─────────────────────────────────────────────────────────────

  function _frame(now) {
    if (!_active) return;

    const dt = Math.min((now - _lastFrameTime) / 1000, 0.1);
    _lastFrameTime = now;
    const t = (now - _startTime) / 1000;

    const decayBase = MapEditor.expansionDecay || MapEditor.Config.EXPANSION_DECAY_DEFAULT;
    const decay     = _mode === 'erase'
      ? decayBase * MapEditor.Config.EXPANSION_ERASE_PENALTY
      : decayBase;

    const speed = MapEditor.Config.EXPANSION_INIT_SPEED_PX * Math.exp(-decay * t);

    if (speed < MapEditor.Config.EXPANSION_STOP_THRESHOLD_PX || _boundary.size === 0) {
      _finalize();
      return;
    }

    const advance    = speed * dt;
    const newPixels  = [];
    const resistance = MapEditor.Config.EXPANSION_RESISTANCE_FACTOR;

    for (const [px, distFactor] of _boundary) {
      if (_addedMask[px] || _blocked[px]) continue;

      // Best edge-weight from any in-mask / base-object neighbour.
      let w = 0;
      _forEachNeighbor8(px, (npx) => {
        if (_addedMask[npx] && _edgeWeight[npx] > w) w = _edgeWeight[npx];
        if (_mode === 'add' && _baseMask[npx] && w < 1.0) w = 1.0;
      });
      if (w <= 0) continue;

      // Resistance when crossing into another object's territory.
      const res = (_mode === 'add' && _otherObjMask && _otherObjMask[px])
        ? resistance : 1.0;

      // Organic noise (spatially coherent, per-gesture unique).
      const noise = _pixelNoise(px);

      // Diagonal pixels (distFactor = √2) accumulate slower → circular frontier.
      _accum[px] += (advance * w * res * noise) / distFactor;

      if (_accum[px] >= 1.0) {
        _addedMask[px]  = 1;
        _edgeWeight[px] = w;   // inherit → tentacle continues
        newPixels.push(px);
      }
    }

    // Update frontier.
    for (const px of newPixels) {
      _boundary.delete(px);
      _forEachNeighbor8(px, (npx, df) => {
        if (_addedMask[npx] || _blocked[npx]) return;
        if (!_boundary.has(npx) || _boundary.get(npx) > df) {
          _boundary.set(npx, df);
        }
      });
    }

    if (newPixels.length > 0) _paintPixels(newPixels);

    _rafHandle = requestAnimationFrame(_frame);
  }

  // ── Finalisation ──────────────────────────────────────────────────────────

  /**
   * Convert current _addedMask → world polygons → apply boolean op →
   * push to undoStack.  Called by stop() and the auto-stop at end of animation.
   */
  function _finalize() {
    if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }

    // ── Erase rind fix: dilate erase mask 1px within _baseMask ────────────
    // The marching-squares tracer produces a polygon that is ~0.5px inside
    // the raster boundary.  Dilating by 1px ensures the Clipper difference
    // covers the full boundary, leaving no thin outline.
    if (_mode === 'erase') {
      const n    = _W * _H;
      const extra = new Uint8Array(n);
      for (let px = 0; px < n; px++) {
        if (!_addedMask[px]) continue;
        const x = px % _W, y = (px / _W) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < _W && ny >= 0 && ny < _H) {
              const npx = ny * _W + nx;
              if (_baseMask[npx]) extra[npx] = 1;
            }
          }
        }
      }
      for (let px = 0; px < n; px++) if (extra[px]) _addedMask[px] = 1;
    }

    // ── Build final canvas ────────────────────────────────────────────────
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width  = _W;
    finalCanvas.height = _H;
    const fCtx = finalCanvas.getContext('2d');
    const imgd = fCtx.createImageData(_W, _H);
    const d    = imgd.data;

    for (let px = 0; px < _W * _H; px++) {
      if (_addedMask[px]) {
        const i = px * 4;
        d[i] = d[i+1] = d[i+2] = d[i+3] = 255;
      }
    }

    // For add mode: also include trail pixels that were inside the object so
    // the traced polygon closes seamlessly against the existing shape.
    if (_mode === 'add') {
      const trailData = _readAlpha(MapEditor.RasterOps.getTrailCanvas());
      for (let px = 0; px < _W * _H; px++) {
        if (trailData[px] && _baseMask[px]) {
          const i = px * 4;
          d[i] = d[i+1] = d[i+2] = d[i+3] = 255;
        }
      }
    }

    fCtx.putImageData(imgd, 0, 0);

    const worldPolys = MapEditor.Tracing.traceCanvas(finalCanvas, MapEditor.viewport);
    _active = false;

    if (!worldPolys || worldPolys.length === 0) {
      if (_targetIsNew) MapEditor.UserObjects.remove(_targetObjId);
    } else {
      MapEditor.DrawTool.applyPolygonsToTarget(
        worldPolys, _targetObjId, _mode, _targetIsNew
      );
    }

    // ── Push to undo stack AFTER applying ─────────────────────────────────
    MapEditor.undoStack.push(MapEditor.UserObjects.snapshot());
    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) {
      MapEditor.UI.refreshUndoButtons();
    }

    _cleanup();
  }

  /**
   * No seeds → commit the raw (clipped) trail immediately.
   * @param {Uint8Array} trailData  already sea-clipped
   */
  function _finalizeImmediate(trailData) {
    // Build a canvas from the clipped trail data.
    const canvas = document.createElement('canvas');
    canvas.width  = _W;
    canvas.height = _H;
    const ctx  = canvas.getContext('2d');
    const imgd = ctx.createImageData(_W, _H);
    const d    = imgd.data;
    for (let px = 0; px < _W * _H; px++) {
      if (trailData[px]) {
        const i = px * 4;
        d[i] = d[i+1] = d[i+2] = d[i+3] = 255;
      }
    }
    ctx.putImageData(imgd, 0, 0);

    const worldPolys = MapEditor.Tracing.traceCanvas(canvas, MapEditor.viewport);

    if (!worldPolys || worldPolys.length === 0) {
      if (_targetIsNew) MapEditor.UserObjects.remove(_targetObjId);
    } else {
      MapEditor.DrawTool.applyPolygonsToTarget(
        worldPolys, _targetObjId, _mode, _targetIsNew
      );
    }

    // Push after (consistent with _finalize).
    MapEditor.undoStack.push(MapEditor.UserObjects.snapshot());
    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) {
      MapEditor.UI.refreshUndoButtons();
    }
  }

  function _cancel() {
    if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
    _active = false;
    _cleanup();
  }

  function _cleanup() {
    _addedMask = _baseMask = _blocked = _otherObjMask = _edgeWeight = _accum = null;
    _boundary  = new Map();
    _preDrawSnapshot = null;
    if (_overlayCtx) _overlayCtx.clearRect(0, 0, _W, _H);
    _overlayImgData = null;
  }

  // ── Blocked mask ──────────────────────────────────────────────────────────

  /**
   * Hard-stop pixels.
   *
   * Add mode:   static path strokes (coastlines) only.
   *             Other user objects are NOT blocked — A can expand into B;
   *             B gets trimmed by applyPolygonsToTarget afterward.
   *
   * Erase mode: static path strokes + pixels outside the target object.
   */
  function _buildBlockedMask(viewport) {
    const n       = _W * _H;
    const blocked = new Uint8Array(n);

    // Static path strokes — always hard stop.
    const strokeCanvas = MapEditor.RasterOps.renderStaticPathStrokeMask(viewport);
    const strokeData   = _readAlpha(strokeCanvas);
    for (let px = 0; px < n; px++) {
      if (strokeData[px]) blocked[px] = 1;
    }

    // Erase: also block pixels outside the target object.
    if (_mode === 'erase') {
      for (let px = 0; px < n; px++) {
        if (!_baseMask[px]) blocked[px] = 1;
      }
    }

    return blocked;
  }

  /**
   * Build a mask of all OTHER user objects' pixels.
   * Used for the resistance calculation (slows expansion; does not stop it).
   */
  function _buildOtherObjMask(excludeId, viewport) {
    const aggregate = { shapes: [] };
    for (const obj of MapEditor.UserObjects.getAll()) {
      if (obj.id === excludeId) continue;
      for (const s of obj.shapes) aggregate.shapes.push(s);
    }
    if (aggregate.shapes.length === 0) return null;

    const canvas = MapEditor.RasterOps.renderObjectMask(aggregate, viewport);
    return _readAlpha(canvas);
  }

  // ── Edge weight computation (tentacle taper) ──────────────────────────────

  function _computeEdgeWeights(trailData) {
    const n    = _W * _H;
    const dist = new Float32Array(n).fill(Infinity);
    const queue = [];

    if (_mode === 'add') {
      for (let px = 0; px < n; px++) {
        if (!_addedMask[px]) continue;
        let adj = false;
        for (const npx of _n4(px)) { if (_baseMask[npx]) { adj = true; break; } }
        if (adj) { dist[px] = 0; queue.push(px); }
      }
    } else {
      for (let px = 0; px < n; px++) {
        if (!_addedMask[px]) continue;
        let adj = false;
        for (const npx of _n4(px)) { if (!_baseMask[npx]) { adj = true; break; } }
        if (adj) { dist[px] = 0; queue.push(px); }
      }
    }

    if (queue.length === 0) {
      for (let px = 0; px < n; px++) {
        if (_addedMask[px]) { dist[px] = 0; queue.push(px); }
      }
    }

    let head = 0;
    while (head < queue.length) {
      const px = queue[head++];
      for (const npx of _n4(px)) {
        if (_addedMask[npx] && dist[npx] === Infinity) {
          dist[npx] = dist[px] + 1;
          queue.push(npx);
        }
      }
    }

    let maxDist = 0;
    for (let px = 0; px < n; px++) {
      if (_addedMask[px] && dist[px] !== Infinity && dist[px] > maxDist) maxDist = dist[px];
    }

    const FLOOR = 0.05;
    for (let px = 0; px < n; px++) {
      if (!_addedMask[px]) continue;
      _edgeWeight[px] = dist[px] === Infinity
        ? FLOOR
        : Math.max(FLOOR, maxDist > 0 ? 1.0 - dist[px] / maxDist : 1.0);
    }
  }

  // ── Organic noise ─────────────────────────────────────────────────────────

  /**
   * Spatially-coherent noise in [0.6, 1.4].
   *
   * Multi-frequency sine functions give smooth, organic blobs at the expansion
   * frontier.  _noiseOffset is randomised each gesture so the pattern varies.
   *
   * The three frequencies (0.23, 0.51, 0.11) have no common divisor, avoiding
   * repeating grid artefacts.
   */
  function _pixelNoise(px) {
    const x = px % _W;
    const y = (px / _W) | 0;
    const s1 = Math.sin(x * 0.23 + y * 0.41 + _noiseOffset)            * 0.5 + 0.5;
    const s2 = Math.sin(x * 0.51 - y * 0.37 + _noiseOffset * 1.7 + 2.1) * 0.5 + 0.5;
    const s3 = Math.sin(x * 0.11 + y * 0.83 + _noiseOffset * 0.9 + 4.3) * 0.5 + 0.5;
    return 0.6 + s1 * 0.27 + s2 * 0.27 + s3 * 0.26;   // [0.6, 1.4]
  }

  // ── Overlay helpers ───────────────────────────────────────────────────────

  function _paintMask(mask) {
    if (!_overlayImgData) return;
    const d = _overlayImgData.data;
    const n = _W * _H;
    for (let px = 0; px < n; px++) {
      if (!mask[px]) continue;
      const i = px * 4;
      d[i] = _overlayR; d[i+1] = _overlayG; d[i+2] = _overlayB; d[i+3] = _overlayAlpha;
    }
    _overlayCtx.putImageData(_overlayImgData, 0, 0);
  }

  function _paintPixels(pixels) {
    if (!_overlayImgData || pixels.length === 0) return;
    const d = _overlayImgData.data;
    for (const px of pixels) {
      const i = px * 4;
      d[i] = _overlayR; d[i+1] = _overlayG; d[i+2] = _overlayB; d[i+3] = _overlayAlpha;
    }
    _overlayCtx.putImageData(_overlayImgData, 0, 0);
  }

  // ── Neighbour helpers ─────────────────────────────────────────────────────

  function _forEachNeighbor8(px, cb) {
    const x = px % _W, y = (px / _W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= _H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= _W) continue;
        cb(ny * _W + nx, (dx !== 0 && dy !== 0) ? SQRT2 : 1.0);
      }
    }
  }

  function _n4(px) {
    const x = px % _W, y = (px / _W) | 0;
    const r = [];
    if (x > 0)      r.push(px - 1);
    if (x < _W - 1) r.push(px + 1);
    if (y > 0)      r.push(px - _W);
    if (y < _H - 1) r.push(px + _W);
    return r;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  function _readAlpha(canvas) {
    const ctx  = canvas.getContext('2d');
    const idat = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const src  = idat.data;
    const n    = canvas.width * canvas.height;
    const out  = new Uint8Array(n);
    const thr  = MapEditor.Config.TRACE_ALPHA_THRESHOLD;
    for (let i = 0; i < n; i++) out[i] = src[i * 4 + 3] > thr ? 1 : 0;
    return out;
  }

  function _syncSize() {
    _W = MapEditor.canvas ? MapEditor.canvas.width  : 0;
    _H = MapEditor.canvas ? MapEditor.canvas.height : 0;
    if (_overlayCanvas) { _overlayCanvas.width = _W; _overlayCanvas.height = _H; }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.Expansion = Expansion;

})(window.MapEditor = window.MapEditor || {});
