/**
 * src/expansion.js
 *
 * Animated morphological expansion engine.
 *
 * ── Bug fixes in this version ────────────────────────────────────────────────
 *  • Static path strokes are hard blockers (coastlines stop expansion).
 *  • Other user objects do NOT hard-block in add mode — A expands into B's
 *    territory; B gets subtracted afterward by DrawTool.applyPolygonsToTarget.
 *    Erase mode still hard-blocks outside the target object.
 *  • Circular expansion: _boundary is now Map<px, distFactor> where
 *    distFactor = 1.0 (cardinal) or √2 (diagonal).  Each boundary pixel
 *    accumulates (advance × weight / distFactor) per frame, so diagonal
 *    pixels advance √2× slower → the frontier is approximately circular.
 *  • Overlay is near-opaque (alpha 240) in the object's own colour for add
 *    mode, so new growth blends visually with the existing shape.
 *    Erase mode keeps a semi-transparent red.
 *
 * ── Lifecycle ────────────────────────────────────────────────────────────────
 *  drawTool.mouseup → Expansion.start(targetObjId, mode, isNew)
 *  rAF loop advances BFS frontier each frame.
 *  Stops when speed < threshold, boundary empty, or Space pressed.
 *  _finalize() traces mask → world polys → DrawTool.applyPolygonsToTarget().
 *
 * ── Raster arrays (all W×H, screen pixels) ───────────────────────────────────
 *  _addedMask   Uint8Array   — pixels added by seeds + expansion
 *  _baseMask    Uint8Array   — original target-object pixels (fixed)
 *  _blocked     Uint8Array   — pixels that stop expansion
 *  _edgeWeight  Float32Array — per-pixel max expansion speed (0..1)
 *  _accum       Float32Array — fractional pressure for each boundary pixel
 *  _boundary    Map<int,float>— frontier: pixel index → distance factor
 */

(function (MapEditor) {
  'use strict';

  const SQRT2  = Math.SQRT2;   // ≈ 1.4142

  // ── Module state ─────────────────────────────────────────────────────────

  let _active      = false;
  let _mode        = 'add';
  let _targetObjId = null;
  let _targetIsNew = false;

  let _W = 0, _H = 0;

  let _addedMask;    // Uint8Array
  let _baseMask;     // Uint8Array
  let _blocked;      // Uint8Array
  let _edgeWeight;   // Float32Array
  let _accum;        // Float32Array
  let _boundary;     // Map<int, float>  — pixel index → distFactor (1 or √2)

  // Overlay canvas rendered on top each frame.
  let _overlayCanvas  = null;
  let _overlayCtx     = null;
  let _overlayImgData = null;
  let _overlayR = 0, _overlayG = 0, _overlayB = 0, _overlayAlpha = 240;

  let _startTime     = 0;
  let _lastFrameTime = 0;
  let _rafHandle     = null;

  // ── Public API ────────────────────────────────────────────────────────────

  const Expansion = {};

  Expansion.init = function () {
    _overlayCanvas = document.createElement('canvas');
    _overlayCtx    = _overlayCanvas.getContext('2d');
    window.addEventListener('resize', () => { if (!_active) _syncSize(); });
    _syncSize();
  };

  Expansion.isActive = () => _active;

  /** Draw live expansion overlay onto the main canvas (screen space). */
  Expansion.drawOverlay = function (ctx) {
    if (!_active || !_overlayCanvas) return;
    // No extra globalAlpha — the overlay manages its own per-pixel alpha.
    ctx.drawImage(_overlayCanvas, 0, 0);
  };

  /**
   * Begin expansion from the current trail canvas.
   * Called by drawTool on mouseup (when Space is NOT held).
   *
   * @param {string}          targetObjId
   * @param {'add'|'erase'}   mode
   * @param {boolean}         targetIsNew
   */
  Expansion.start = function (targetObjId, mode, targetIsNew) {
    if (_active) _cancel();

    _syncSize();
    if (_W === 0 || _H === 0) return;

    _mode        = mode;
    _targetObjId = targetObjId;
    _targetIsNew = targetIsNew;

    const viewport    = MapEditor.viewport;
    const trailCanvas = MapEditor.RasterOps.getTrailCanvas();
    const trailData   = _readAlpha(trailCanvas);
    const n           = _W * _H;

    // ── Rasterise target object ───────────────────────────────────────────
    const objCanvas = MapEditor.RasterOps.renderObjectMask(
      MapEditor.UserObjects.getById(targetObjId) || { shapes: [] }, viewport
    );
    _baseMask = _readAlpha(objCanvas);

    // ── Build blocked mask ────────────────────────────────────────────────
    _blocked = _buildBlockedMask(viewport);

    // ── Identify seeds ────────────────────────────────────────────────────
    // Add:   trail pixels OUTSIDE the target object (will be union-ed in)
    // Erase: trail pixels INSIDE  the target object (will be subtracted)
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
      // Trail entirely inside (add) or outside (erase) — commit raw trail.
      _finalizeImmediate();
      return;
    }

    // ── Compute edge weights (BFS through seeds from object boundary) ─────
    _computeEdgeWeights(trailData);

    // ── Build initial frontier (Map with distance factors) ───────────────
    for (let px = 0; px < n; px++) {
      if (!_addedMask[px]) continue;
      _forEachNeighbor8(px, (npx, df) => {
        if (_addedMask[npx] || _blocked[npx]) return;
        if (!_boundary.has(npx) || _boundary.get(npx) > df) {
          _boundary.set(npx, df);
        }
      });
    }

    // ── Overlay colour ────────────────────────────────────────────────────
    if (mode === 'add') {
      const obj  = MapEditor.UserObjects.getById(targetObjId);
      const rgb  = MapEditor.ColorUtils.hexToRgb(obj ? obj.color : '#ffffff');
      _overlayR = rgb.r; _overlayG = rgb.g; _overlayB = rgb.bv;
      _overlayAlpha = 240;   // near-opaque → blends with existing object fill
    } else {
      _overlayR = 210; _overlayG = 45; _overlayB = 45;
      _overlayAlpha = 150;
    }

    // Paint seed pixels into overlay.
    _overlayCtx.clearRect(0, 0, _W, _H);
    _overlayImgData = _overlayCtx.createImageData(_W, _H);
    _paintMaskToOverlay(_addedMask);

    // ── Start animation ───────────────────────────────────────────────────
    _active        = true;
    _startTime     = performance.now();
    _lastFrameTime = _startTime;
    _rafHandle     = requestAnimationFrame(_frame);
  };

  /** Stop expansion immediately and finalise (Space key). */
  Expansion.stop = function () {
    if (!_active) return;
    _finalize();
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

    const speed   = MapEditor.Config.EXPANSION_INIT_SPEED_PX * Math.exp(-decay * t);

    if (speed < MapEditor.Config.EXPANSION_STOP_THRESHOLD_PX || _boundary.size === 0) {
      _finalize();
      return;
    }

    const advance = speed * dt;
    const newPixels = [];

    for (const [px, distFactor] of _boundary) {
      if (_addedMask[px] || _blocked[px]) continue;

      // Best edge weight from any in-mask neighbour.
      let w = 0;
      _forEachNeighbor8(px, (npx) => {
        if (_addedMask[npx] && _edgeWeight[npx] > w) w = _edgeWeight[npx];
        // The existing object boundary always expands at full speed.
        if (_mode === 'add' && _baseMask[npx] && w < 1.0) w = 1.0;
      });
      if (w <= 0) continue;

      // Divide by distFactor: diagonal pixels accumulate √2× slower → circular frontier.
      _accum[px] += (advance * w) / distFactor;

      if (_accum[px] >= 1.0) {
        _addedMask[px]  = 1;
        _edgeWeight[px] = w;   // inherit weight → tentacle continues at same width
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

    if (newPixels.length > 0) _paintNewPixels(newPixels);

    _rafHandle = requestAnimationFrame(_frame);
  }

  // ── Finalisation ──────────────────────────────────────────────────────────

  function _finalize() {
    if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }

    // Build final canvas: addedMask pixels + trail-inside-object pixels (add mode only,
    // so the traced polygon closes seamlessly against the existing shape boundary).
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

    if (_mode === 'add') {
      // Also include trail pixels that were inside the object so the traced
      // polygon closes across the existing boundary without gaps.
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

    _cleanup();
  }

  /** Commit the raw trail without any expansion (no seeds, or Space was held). */
  function _finalizeImmediate() {
    const trailCanvas = MapEditor.RasterOps.getTrailCanvas();
    const worldPolys  = MapEditor.Tracing.traceCanvas(trailCanvas, MapEditor.viewport);

    if (!worldPolys || worldPolys.length === 0) {
      if (_targetIsNew) MapEditor.UserObjects.remove(_targetObjId);
    } else {
      MapEditor.DrawTool.applyPolygonsToTarget(
        worldPolys, _targetObjId, _mode, _targetIsNew
      );
    }
  }

  function _cancel() {
    if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
    _active = false;
    _cleanup();
  }

  function _cleanup() {
    _addedMask = _baseMask = _blocked = _edgeWeight = _accum = null;
    _boundary  = new Map();
    if (_overlayCtx) _overlayCtx.clearRect(0, 0, _W, _H);
    _overlayImgData = null;
  }

  // ── Blocked mask ──────────────────────────────────────────────────────────

  /**
   * Build the blocked-pixel mask.
   *
   * ── Add mode ──────────────────────────────────────────────────────────────
   *   • Static path STROKES (coastlines, rivers) — hard stop.
   *   • Other user objects — NOT blocked.  A can expand into B; B's area is
   *     subtracted from B after expansion by applyPolygonsToTarget.
   *   • Canvas edge — implicit (array bounds).
   *
   * ── Erase mode ────────────────────────────────────────────────────────────
   *   • Static path strokes — hard stop.
   *   • Pixels outside the target object — hard stop (can't erase past the edge).
   *
   * @param {MapEditor.Viewport} viewport
   * @returns {Uint8Array}
   */
  function _buildBlockedMask(viewport) {
    const n       = _W * _H;
    const blocked = new Uint8Array(n);

    // ── Static path strokes ─────────────────────────────────────────────
    // Coastlines, river edges etc. are hard stops regardless of mode.
    const strokeCanvas = MapEditor.RasterOps.renderStaticPathStrokeMask(viewport);
    const strokeData   = _readAlpha(strokeCanvas);
    for (let px = 0; px < n; px++) {
      if (strokeData[px]) blocked[px] = 1;
    }

    // ── Erase mode: outside-object boundary ─────────────────────────────
    // _baseMask was already built before this call.
    if (_mode === 'erase') {
      for (let px = 0; px < n; px++) {
        if (!_baseMask[px]) blocked[px] = 1;
      }
    }

    return blocked;
  }

  // ── Edge weight computation ───────────────────────────────────────────────

  /**
   * Assign _edgeWeight[px] ∈ [FLOOR, 1.0] to every seed pixel.
   *
   * BFS through seed pixels starting from those that touch the object boundary
   * (distance 0 = base of tentacle = weight 1.0).  Seeds at the far tip of the
   * trail get weight ≈ FLOOR.
   *
   * Result: expansion is wide and fast at the trail base, narrow and slow
   * at the trail tip — the natural "tentacle" shape described in the spec.
   *
   * @param {Uint8Array} trailData
   */
  function _computeEdgeWeights(trailData) {
    const n    = _W * _H;
    const dist = new Float32Array(n).fill(Infinity);
    const queue = [];

    if (_mode === 'add') {
      // BFS starts from seed pixels that are adjacent to the existing object.
      for (let px = 0; px < n; px++) {
        if (!_addedMask[px]) continue;
        let adjacent = false;
        for (const npx of _n4(px)) {
          if (_baseMask[npx]) { adjacent = true; break; }
        }
        if (adjacent) { dist[px] = 0; queue.push(px); }
      }
    } else {
      // Erase: BFS from seeds adjacent to the object's inner boundary
      // (where the object meets non-object space).
      for (let px = 0; px < n; px++) {
        if (!_addedMask[px]) continue;
        let adjacent = false;
        for (const npx of _n4(px)) {
          if (!_baseMask[npx]) { adjacent = true; break; }
        }
        if (adjacent) { dist[px] = 0; queue.push(px); }
      }
    }

    // Fallback: if no seeds touch the object boundary, treat all seeds as dist=0.
    if (queue.length === 0) {
      for (let px = 0; px < n; px++) {
        if (_addedMask[px]) { dist[px] = 0; queue.push(px); }
      }
    }

    // BFS through seeds only (don't cross into non-seed territory).
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
      if (_addedMask[px] && dist[px] !== Infinity && dist[px] > maxDist) {
        maxDist = dist[px];
      }
    }

    const FLOOR = 0.05;
    for (let px = 0; px < n; px++) {
      if (!_addedMask[px]) continue;
      _edgeWeight[px] = dist[px] === Infinity
        ? FLOOR
        : Math.max(FLOOR, maxDist > 0 ? 1.0 - dist[px] / maxDist : 1.0);
    }
  }

  // ── Overlay helpers ───────────────────────────────────────────────────────

  function _paintMaskToOverlay(mask) {
    if (!_overlayImgData) return;
    const d = _overlayImgData.data;
    const n = _W * _H;
    for (let px = 0; px < n; px++) {
      if (!mask[px]) continue;
      const i = px * 4;
      d[i]   = _overlayR;
      d[i+1] = _overlayG;
      d[i+2] = _overlayB;
      d[i+3] = _overlayAlpha;
    }
    _overlayCtx.putImageData(_overlayImgData, 0, 0);
  }

  function _paintNewPixels(newPixels) {
    if (!_overlayImgData || newPixels.length === 0) return;
    const d = _overlayImgData.data;
    for (const px of newPixels) {
      const i = px * 4;
      d[i]   = _overlayR;
      d[i+1] = _overlayG;
      d[i+2] = _overlayB;
      d[i+3] = _overlayAlpha;
    }
    _overlayCtx.putImageData(_overlayImgData, 0, 0);
  }

  // ── Neighbour helpers ─────────────────────────────────────────────────────

  /**
   * Call cb(neighborPx, distFactor) for each 8-connected in-bounds neighbor.
   * distFactor = 1.0 for cardinal, SQRT2 for diagonal.
   * Inline for performance — avoids array allocation per call.
   */
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

  /** 4-connected neighbour array (used only in edge-weight BFS). */
  function _n4(px) {
    const x = px % _W, y = (px / _W) | 0;
    const r = [];
    if (x > 0)      r.push(px - 1);
    if (x < _W - 1) r.push(px + 1);
    if (y > 0)      r.push(px - _W);
    if (y < _H - 1) r.push(px + _W);
    return r;
  }

  // ── Utility ───────────────────────────────────────────────────────────────

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
    if (_overlayCanvas) {
      _overlayCanvas.width  = _W;
      _overlayCanvas.height = _H;
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.Expansion = Expansion;

})(window.MapEditor = window.MapEditor || {});
