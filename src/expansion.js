/**
 * src/expansion.js
 *
 * Animated morphological expansion engine — live mode rewrite.
 *
 * ── New lifecycle ────────────────────────────────────────────────────────────
 *
 *  mousedown  → Expansion.startLive(objId, mode, isNew, preSnap)
 *                 initialise masks, start constant-speed rAF loop
 *  mousemove  → Expansion.addSeeds(sx, sy, radius)
 *                 paint disk pixels into _addedMask, extend frontier
 *  mouseup    → Expansion.finishLive()
 *                 switch rAF loop to exponential-decay mode
 *  auto-stop  → _finalize() when speed < threshold
 *  Space/zoom → Expansion.stop()   (finalize immediately)
 *  Ctrl+Z     → Expansion.cancel() (discard, restore preSnap)
 *
 * ── Removed ──────────────────────────────────────────────────────────────────
 *  • _edgeWeight / tentacle taper  — triangle profile now emerges naturally
 *    because the base of the stroke starts expanding earlier than the tip.
 *  • diskCenters parameter on start() — sea-clipping now happens per-disk in
 *    addSeeds(), so each disk is checked as it arrives.
 *
 * ── Kept ─────────────────────────────────────────────────────────────────────
 *  • Resistance in enemy territory (_otherObjMask × EXPANSION_RESISTANCE_FACTOR)
 *  • Organic noise (_pixelNoise) — spatially-coherent multi-sine, random per gesture
 *  • Circular frontier — diagonal pixels advance √2× slower (distFactor in Map)
 *  • Erase dilation — 3px (increased from 1px) before tracing to kill rind artefact
 *  • Sea clipping — per disk-center check against land-fill mask
 *
 * ── Raster arrays (W×H screen pixels) ────────────────────────────────────────
 *  _addedMask    Uint8Array    pixels added by seeds + expansion
 *  _baseMask     Uint8Array    target-object pixels at gesture start (fixed)
 *  _blocked      Uint8Array    hard-stop pixels (static strokes; outside-obj for erase)
 *  _otherObjMask Uint8Array    other-object pixels (resistance multiplier, not block)
 *  _accum        Float32Array  fractional advance pressure per boundary pixel
 *  _boundary     Map<int,float> frontier: index → distFactor (1 = cardinal, √2 = diagonal)
 *  _landData     Uint8Array    static-fill pixels (land) — for sea clipping in addSeeds
 */

(function (MapEditor) {
  'use strict';

  const SQRT2 = Math.SQRT2;

  // ── Module state ─────────────────────────────────────────────────────────

  let _active          = false;
  let _liveMode        = false;   // true while mouse is held; false during decay
  let _decayStartTime  = 0;       // performance.now() at finishLive()

  let _mode            = 'add';
  let _targetObjId     = null;
  let _targetIsNew     = false;
  let _preDrawSnapshot = null;

  let _W = 0, _H = 0;

  let _addedMask;       // Uint8Array
  let _baseMask;        // Uint8Array
  let _blocked;         // Uint8Array
  let _otherObjMask;    // Uint8Array | null
  let _resistanceMap;   // Float32Array | null
  let _boundaryDistMap; // Float32Array | null  — screen-px distance from shape edge (erase only)
  let _accum;           // Float32Array
  let _boundary;        // Map<int, float>
  let _landData;        // Uint8Array | null  (land-fill mask for sea clipping)
  let _anyLandCenter   = false;   // has any disk center landed on land?

  let _overlayCanvas  = null;
  let _overlayCtx     = null;
  let _overlayImgData = null;
  let _overlayR = 0, _overlayG = 0, _overlayB = 0, _overlayAlpha = 245;

  let _lastFrameTime = 0;
  let _rafHandle     = null;
  let _noiseOffset   = 0;

  // ── Public API ────────────────────────────────────────────────────────────

  const Expansion = {};

  Expansion.init = function () {
    _overlayCanvas = document.createElement('canvas');
    _overlayCtx    = _overlayCanvas.getContext('2d');
    window.addEventListener('resize', () => { if (!_active) _syncSize(); });
    _syncSize();
  };

  Expansion.isActive = () => _active;

  Expansion.drawOverlay = function (ctx) {
    if (!_active || !_overlayCanvas) return;
    ctx.drawImage(_overlayCanvas, 0, 0);
  };

  /**
   * Begin live expansion (called on mousedown).
   *
   * @param {string}          targetObjId
   * @param {'add'|'erase'}   mode
   * @param {boolean}         targetIsNew
   * @param {object}          preDrawSnapshot   — for cancel() recovery
   */
  Expansion.startLive = function (targetObjId, mode, targetIsNew, preDrawSnapshot) {
    if (_active) _hardCancel();

    _syncSize();
    if (_W === 0 || _H === 0) return;

    _mode            = mode;
    _targetObjId     = targetObjId;
    _targetIsNew     = targetIsNew;
    _preDrawSnapshot = preDrawSnapshot || null;
    _noiseOffset     = Math.random() * 1000;
    _anyLandCenter   = false;
    _liveMode        = true;

    const n        = _W * _H;
    const viewport = MapEditor.viewport;

    // Rasterise target object (fixed snapshot).
    const objCanvas = MapEditor.RasterOps.renderObjectMask(
      MapEditor.UserObjects.getById(targetObjId) || { shapes: [] }, viewport
    );
    _baseMask = _readAlpha(objCanvas);

    // Land-fill mask for per-disk sea clipping.
    const landCanvas = MapEditor.RasterOps.renderStaticPathFillMask(viewport);
    _landData = _readAlpha(landCanvas);
    if (_landData.indexOf(1) < 0) _landData = null;  // all ocean map → skip clipping

    // Resistance mask (other objects).
    _otherObjMask = _buildOtherObjMask(targetObjId, viewport);

    // Mountain resistance map (Float32Array: count of contour layers per pixel).
    _resistanceMap = MapEditor.RasterOps.renderMountainResistanceMap(viewport);

    // Boundary-distance map for erase mode: BFS inward from every edge pixel
    // of _baseMask.  Used to bias expansion toward the shape boundary so erase
    // spreads laterally (concave, geography-like) rather than boring inward.
    _boundaryDistMap = (_mode === 'erase') ? _computeBoundaryDistMap() : null;

    // Blocked mask.
    _blocked = _buildBlockedMask(viewport);

    // Initialise empty raster state.
    _addedMask = new Uint8Array(n);
    _accum     = new Float32Array(n);
    _boundary  = new Map();

    // Overlay colour.
    if (mode === 'add') {
      const obj = MapEditor.UserObjects.getById(targetObjId);
      const rgb = MapEditor.ColorUtils.hexToRgb(obj ? obj.color : '#ffffff');
      _overlayR = rgb.r; _overlayG = rgb.g; _overlayB = rgb.bv;
      _overlayAlpha = 245;
    } else {
      _overlayR = 210; _overlayG = 45; _overlayB = 45;
      _overlayAlpha = 150;
    }

    _overlayCtx.clearRect(0, 0, _W, _H);
    _overlayImgData = _overlayCtx.createImageData(_W, _H);

    _active        = true;
    _lastFrameTime = performance.now();
    _rafHandle     = requestAnimationFrame(_frame);
  };

  /**
   * Add a disk of seed pixels at screen position (sx, sy) with given radius.
   * Called from drawTool on every emitted disk while mouse is held.
   * Handles sea clipping internally.
   *
   * @param {number} sx      screen x of disk center
   * @param {number} sy      screen y of disk center
   * @param {number} radius  disk radius in screen pixels
   */
  Expansion.addSeeds = function (sx, sy, radius) {
    if (!_active || !_liveMode) return;

    const cx_i = Math.round(sx);
    const cy_i = Math.round(sy);

    // ── Track land centers; retroactively clip if we just got the first one ─
    if (_landData) {
      const inBounds = cx_i >= 0 && cx_i < _W && cy_i >= 0 && cy_i < _H;
      const onLand   = inBounds && !!_landData[cy_i * _W + cx_i];
      if (onLand && !_anyLandCenter) {
        _anyLandCenter = true;
        // We now know land has priority.  Remove sea pixels already in the mask.
        _retroactiveSeaClip();
      } else if (onLand) {
        _anyLandCenter = true;
      }
    }

    // ── Paint disk — skip sea pixels if land-mode is active ──────────────
    const doSeaClip = _anyLandCenter && _landData;
    const r  = Math.ceil(radius);
    const r2 = radius * radius;
    const newSeeds = [];

    for (let dy = -r; dy <= r; dy++) {
      const ny = cy_i + dy;
      if (ny < 0 || ny >= _H) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const nx = cx_i + dx;
        if (nx < 0 || nx >= _W) continue;
        const px = ny * _W + nx;
        if (_addedMask[px] || _blocked[px]) continue;
        if (doSeaClip && !_landData[px]) continue;   // skip sea pixels
        _addedMask[px] = 1;
        _boundary.delete(px);
        newSeeds.push(px);
      }
    }

    for (const px of newSeeds) {
      _forEachNeighbor8(px, (npx, df) => {
        if (_addedMask[npx] || _blocked[npx]) return;
        if (doSeaClip && !_landData[npx]) return;   // don't enqueue sea frontier
        if (!_boundary.has(npx) || _boundary.get(npx) > df) _boundary.set(npx, df);
      });
    }

    if (newSeeds.length > 0) _paintPixels(newSeeds);
  };

  /**
   * Mouse released — switch from constant-speed to decay mode.
   * The rAF loop continues; finalization happens automatically when
   * speed falls below the stop threshold.
   */
  Expansion.finishLive = function () {
    if (!_active || !_liveMode) return;
    _liveMode       = false;
    _decayStartTime = performance.now();
  };

  /** Finalize immediately (Space key, zoom, new draw start). */
  Expansion.stop = function () {
    if (!_active) return;
    _liveMode = false;    // ensure we're in decay mode if we weren't already
    _finalize();
  };

  /**
   * Discard the gesture and restore the pre-draw snapshot (Ctrl+Z during expansion).
   * Does NOT push to undoStack.
   */
  Expansion.cancel = function () {
    if (!_active) return;
    if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
    _active   = false;
    _liveMode = false;
    if (_preDrawSnapshot) MapEditor.UserObjects.applySnapshot(_preDrawSnapshot);
    _cleanup();
    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) MapEditor.UI.refreshUndoButtons();
  };

  // ── rAF frame ─────────────────────────────────────────────────────────────

  function _frame(now) {
    if (!_active) return;

    const dt = Math.min((now - _lastFrameTime) / 1000, 0.1);
    _lastFrameTime = now;

    let speed;
    if (_liveMode) {
      // Constant speed while mouse is held.
      speed = MapEditor.Config.EXPANSION_INIT_SPEED_PX;
    } else {
      // Exponential decay after mouse release.
      const tDecay   = (now - _decayStartTime) / 1000;
      const decayBase = MapEditor.expansionDecay || MapEditor.Config.EXPANSION_DECAY_DEFAULT;
      const decay     = _mode === 'erase'
        ? decayBase * MapEditor.Config.EXPANSION_ERASE_PENALTY
        : decayBase;
      speed = MapEditor.Config.EXPANSION_INIT_SPEED_PX * Math.exp(-decay * tDecay);

      if (speed < MapEditor.Config.EXPANSION_STOP_THRESHOLD_PX || _boundary.size === 0) {
        _finalize();
        return;
      }
    }

    const advance    = speed * dt;
    const resistance = MapEditor.Config.EXPANSION_RESISTANCE_FACTOR;
    const mountainK  = MapEditor.Config.MOUNTAIN_FACTOR_PER_LEVEL;
    const doSeaClip  = _anyLandCenter && _landData;
    const newPixels  = [];

    for (const [px, distFactor] of _boundary) {
      if (_addedMask[px] || _blocked[px]) continue;
      if (doSeaClip && !_landData[px]) continue;

      // ── Resistance factors ───────────────────────────────────────────────
      // Other-object territory: multiplies speed by EXPANSION_RESISTANCE_FACTOR.
      const objFactor = (_mode === 'add' && _otherObjMask && _otherObjMask[px])
        ? resistance : 1.0;

      // Mountain contours: each layer compounds the slowdown.
      const mountainLevels = _resistanceMap ? _resistanceMap[px] : 0;
      const mountainFactor = mountainLevels > 0
        ? Math.pow(mountainK, mountainLevels)
        : 1.0;

      // Erase depth factor: expansion decays exponentially with distance from
      // the shape boundary.  Pixels at the edge expand freely; pixels deep
      // inside expand slowly.  This makes erasure spread along the boundary
      // (concave, geography-like) rather than boring a round hole inward.
      const depthFactor = (_boundaryDistMap && _mode === 'erase')
        ? Math.exp(-MapEditor.Config.ERASE_DEPTH_DECAY * _boundaryDistMap[px])
        : 1.0;

      const noise = _pixelNoise(px);

      _accum[px] += (advance * objFactor * mountainFactor * depthFactor * noise) / distFactor;

      if (_accum[px] >= 1.0) {
        _addedMask[px] = 1;
        newPixels.push(px);
      }
    }

    for (const px of newPixels) {
      _boundary.delete(px);
      _forEachNeighbor8(px, (npx, df) => {
        if (_addedMask[npx] || _blocked[npx]) return;
        if (doSeaClip && _landData && !_landData[npx]) return;
        if (!_boundary.has(npx) || _boundary.get(npx) > df) _boundary.set(npx, df);
      });
    }

    if (newPixels.length > 0) _paintPixels(newPixels);

    _rafHandle = requestAnimationFrame(_frame);
  }

  // ── Finalisation ──────────────────────────────────────────────────────────

  function _finalize() {
    if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }

    const n = _W * _H;

    // ── Sea clipping (deferred from addSeeds) ─────────────────────────────
    // If ANY disk center landed on land, remove all _addedMask pixels that
    // lie outside static-path fills (i.e. in the ocean).  This correctly
    // handles mixed strokes that cross a coastline: the land portion is kept,
    // the sea portion is discarded, regardless of stroke direction or order.
    if (_anyLandCenter && _landData) {
      let removedAny = false;
      for (let px = 0; px < n; px++) {
        if (_addedMask[px] && !_landData[px]) {
          _addedMask[px] = 0;
          removedAny = true;
        }
      }
      // Rebuild boundary after clipping (some frontier entries may now be invalid).
      if (removedAny) {
        const newBoundary = new Map();
        for (const [px, df] of _boundary) {
          if (!_addedMask[px] && !_blocked[px]) {
            // Keep frontier pixel only if it still has an in-mask neighbour.
            let hasInMaskNeighbour = false;
            _forEachNeighbor8(px, (npx) => {
              if (_addedMask[npx]) hasInMaskNeighbour = true;
            });
            if (hasInMaskNeighbour) newBoundary.set(px, df);
          }
        }
        _boundary = newBoundary;
      }
    }

    // ── Erase rind fix: dilate _addedMask by 4px WITHOUT the _baseMask ──────
    // constraint.  Previous code did `if (_baseMask[npx]) extra[npx] = 1`
    // which constrained dilation to stay inside the rasterised object boundary.
    // But _baseMask itself is ~1–2px inside the vector boundary (rasterisation
    // artefact), so the erase polygon always stopped short of the vector edge,
    // leaving a thin ghost strip after Clipper difference.
    //
    // Without the constraint, the dilated erase polygon extends ~2–3px past
    // the raster boundary = slightly past the vector boundary.  Clipper's
    // difference clips it to the shape automatically, so nothing outside the
    // country is ever erased.
    if (_mode === 'erase') {
      const extra = new Uint8Array(n);
      for (let px = 0; px < n; px++) {
        if (!_addedMask[px]) continue;
        const x0 = px % _W, y0 = (px / _W) | 0;
        for (let dy = -4; dy <= 4; dy++) {
          const ny = y0 + dy;
          if (ny < 0 || ny >= _H) continue;
          for (let dx = -4; dx <= 4; dx++) {
            if (dx * dx + dy * dy > 16) continue;   // 4px circle
            const nx = x0 + dx;
            if (nx < 0 || nx >= _W) continue;
            extra[ny * _W + nx] = 1;   // no _baseMask constraint
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
    for (let px = 0; px < n; px++) {
      if (_addedMask[px]) { const i = px*4; d[i]=d[i+1]=d[i+2]=d[i+3]=255; }
    }
    fCtx.putImageData(imgd, 0, 0);

    // ── Raster speck filter (erase mode only) ─────────────────────────────
    // After building the final canvas, remove any isolated white regions smaller
    // than ERASE_MIN_COMPONENT_PX pixels.  These correspond to the hair-thin
    // raster fragments that survive dilation but are too small to represent
    // real geometry — they would otherwise trace into the scattered dashes
    // visible as a ghost edge after erasing.
    //
    // We do this only for erase because add-mode specks are absorbed into the
    // union and never produce visible artefacts.
    if (_mode === 'erase') {
      const rawImgd   = fCtx.getImageData(0, 0, _W, _H);
      const minComp   = MapEditor.Config.ERASE_MIN_COMPONENT_PX;
      const threshold = MapEditor.Config.TRACE_ALPHA_THRESHOLD;
      MapEditor.Tracing.filterSpeckComponents(rawImgd.data, _W, _H, minComp, threshold);
      fCtx.putImageData(rawImgd, 0, 0);
    }

    const worldPolys = MapEditor.Tracing.traceCanvas(finalCanvas, MapEditor.viewport);
    _active   = false;
    _liveMode = false;

    if (!worldPolys || worldPolys.length === 0) {
      if (_targetIsNew) MapEditor.UserObjects.remove(_targetObjId);
    } else {
      MapEditor.DrawTool.applyPolygonsToTarget(
        worldPolys, _targetObjId, _mode, _targetIsNew
      );
    }

    MapEditor.undoStack.push(MapEditor.UserObjects.snapshot());
    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) MapEditor.UI.refreshUndoButtons();

    _cleanup();
  }

  function _hardCancel() {
    if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
    _active = _liveMode = false;
    _cleanup();
  }

  function _cleanup() {
    _addedMask = _baseMask = _blocked = _otherObjMask = _resistanceMap = _boundaryDistMap = _accum = _landData = null;
    _boundary  = new Map();
    _preDrawSnapshot = null;
    _anyLandCenter   = false;
    if (_overlayCtx) _overlayCtx.clearRect(0, 0, _W, _H);
    _overlayImgData = null;
  }

  // ── Sea clipping helpers ──────────────────────────────────────────────────

  /**
   * Called the moment _anyLandCenter first becomes true.
   * Removes all sea pixels already in _addedMask, clears them from the overlay,
   * and rebuilds the boundary map so the frontier is fully land-only.
   */
  function _retroactiveSeaClip() {
    if (!_landData) return;

    const d        = _overlayImgData ? _overlayImgData.data : null;
    let   anyClean = false;

    for (let px = 0; px < _W * _H; px++) {
      if (_addedMask[px] && !_landData[px]) {
        _addedMask[px] = 0;
        if (d) { const i = px * 4; d[i+3] = 0; }   // clear overlay alpha
        anyClean = true;
      }
    }

    if (anyClean) {
      if (_overlayImgData) _overlayCtx.putImageData(_overlayImgData, 0, 0);
      _rebuildBoundary();
    }
  }

  /**
   * Rebuild the entire _boundary map from scratch based on current _addedMask.
   * Called after retroactive sea clipping removes pixels from the mask.
   */
  function _rebuildBoundary() {
    const doSeaClip = _anyLandCenter && _landData;
    const newBoundary = new Map();

    for (let px = 0; px < _W * _H; px++) {
      if (!_addedMask[px]) continue;
      _forEachNeighbor8(px, (npx, df) => {
        if (_addedMask[npx] || _blocked[npx]) return;
        if (doSeaClip && _landData && !_landData[npx]) return;
        if (!newBoundary.has(npx) || newBoundary.get(npx) > df) {
          newBoundary.set(npx, df);
        }
      });
    }
    _boundary = newBoundary;
  }

  // ── Boundary distance map ─────────────────────────────────────────────────

  /**
   * BFS inward from every edge pixel of _baseMask.
   *
   * An "edge pixel" is an inside pixel (_baseMask=1) adjacent to an outside
   * pixel (_baseMask=0).  The BFS propagates inward through _baseMask pixels,
   * recording the shortest distance (in screen pixels, 4-connected) to the
   * nearest edge.
   *
   * Used by the erase expansion to weight advance by
   *   exp(−ERASE_DEPTH_DECAY × distance)
   * so that pixels near the shape boundary erode freely while pixels deep
   * inside erode slowly — producing concave, boundary-following erasure.
   *
   * @returns {Float32Array}  distance in screen pixels, Infinity if unreachable
   */
  function _computeBoundaryDistMap() {
    const n    = _W * _H;
    const dist = new Float32Array(n).fill(Infinity);
    const queue = [];

    // Seed: every _baseMask pixel that has at least one non-_baseMask 4-neighbour.
    for (let px = 0; px < n; px++) {
      if (!_baseMask[px]) continue;
      const x = px % _W, y = (px / _W) | 0;
      let isBoundary = false;
      if (x > 0      && !_baseMask[px - 1])    isBoundary = true;
      if (x < _W - 1 && !_baseMask[px + 1])    isBoundary = true;
      if (y > 0      && !_baseMask[px - _W])    isBoundary = true;
      if (y < _H - 1 && !_baseMask[px + _W])   isBoundary = true;
      if (isBoundary) { dist[px] = 0; queue.push(px); }
    }

    // 4-connected BFS inward through _baseMask.
    let head = 0;
    while (head < queue.length) {
      const px = queue[head++];
      const x  = px % _W, y = (px / _W) | 0;
      const d1 = dist[px] + 1;
      if (x > 0      && _baseMask[px - 1]  && dist[px - 1]  > d1) { dist[px - 1]  = d1; queue.push(px - 1);  }
      if (x < _W - 1 && _baseMask[px + 1]  && dist[px + 1]  > d1) { dist[px + 1]  = d1; queue.push(px + 1);  }
      if (y > 0      && _baseMask[px - _W] && dist[px - _W] > d1) { dist[px - _W] = d1; queue.push(px - _W); }
      if (y < _H - 1 && _baseMask[px + _W] && dist[px + _W] > d1) { dist[px + _W] = d1; queue.push(px + _W); }
    }

    return dist;
  }

  // ── Blocked mask ──────────────────────────────────────────────────────────

  /**
   * Add mode:   static strokes only (other objects NOT blocked — resistance instead).
   * Erase mode: static strokes + pixels outside target object.
   *
   * In BOTH modes, the 1-pixel canvas border is always blocked.
   * This guarantees the expansion frontier never reaches the literal image
   * edge, so marching-squares always produces closed polygon contours.
   * Without this, a shape touching the screen edge produces an open contour
   * that stitches into a half-screen-crossing gap.
   */
  function _buildBlockedMask(viewport) {
    const n       = _W * _H;
    const blocked = new Uint8Array(n);

    // ── 1-pixel canvas border — always blocked ────────────────────────────
    for (let x = 0; x < _W; x++) {
      blocked[x] = 1;                      // top row
      blocked[(_H - 1) * _W + x] = 1;     // bottom row
    }
    for (let y = 0; y < _H; y++) {
      blocked[y * _W] = 1;                 // left col
      blocked[y * _W + (_W - 1)] = 1;     // right col
    }

    // ── Static path strokes ───────────────────────────────────────────────
    const strokeCanvas = MapEditor.RasterOps.renderStaticPathStrokeMask(viewport);
    const strokeData   = _readAlpha(strokeCanvas);
    for (let px = 0; px < n; px++) if (strokeData[px]) blocked[px] = 1;

    // ── Erase: also block pixels outside the target object ────────────────
    if (_mode === 'erase') {
      for (let px = 0; px < n; px++) if (!_baseMask[px]) blocked[px] = 1;
    }

    return blocked;
  }

  function _buildOtherObjMask(excludeId, viewport) {
    const agg = { shapes: [] };
    for (const obj of MapEditor.UserObjects.getAll()) {
      if (obj.id === excludeId) continue;
      for (const s of obj.shapes) agg.shapes.push(s);
    }
    if (agg.shapes.length === 0) return null;
    return _readAlpha(MapEditor.RasterOps.renderObjectMask(agg, viewport));
  }

  // ── Organic noise ─────────────────────────────────────────────────────────

  /**
   * Spatially-coherent, per-gesture noise in [0.55, 1.45].
   * Three incommensurable sine frequencies → no repeating grid artefacts.
   */
  function _pixelNoise(px) {
    const x  = px % _W;
    const y  = (px / _W) | 0;
    const s1 = Math.sin(x * 0.23  + y * 0.41  + _noiseOffset);
    const s2 = Math.sin(x * 0.51  - y * 0.37  + _noiseOffset * 1.7 + 2.1);
    const s3 = Math.sin(x * 0.117 + y * 0.839 + _noiseOffset * 0.9 + 4.3);
    return 0.55 + (s1 + s2 + s3 + 3.0) * (0.90 / 6.0);  // ≈ [0.55, 1.45]
  }

  // ── Overlay helpers ───────────────────────────────────────────────────────

  function _paintPixels(pixels) {
    if (!_overlayImgData || pixels.length === 0) return;
    const d = _overlayImgData.data;
    for (const px of pixels) {
      const i = px * 4;
      d[i]   = _overlayR;
      d[i+1] = _overlayG;
      d[i+2] = _overlayB;
      d[i+3] = _overlayAlpha;
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
    if (_overlayCanvas) { _overlayCanvas.width = _W; _overlayCanvas.height = _H; }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.Expansion = Expansion;

})(window.MapEditor = window.MapEditor || {});
