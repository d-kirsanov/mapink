/**
 * src/rasterOps.js
 *
 * Manages off-screen canvases used for:
 *   - trailCanvas  : the current draw trail (white disks on transparent black)
 *                    Used as an alpha mask for marching-squares tracing.
 *   - Temporary boundary/object masks created on demand for the expansion engine.
 *
 * All canvases are screen-sized (matching the main display canvas).
 * They are resized automatically when the main canvas resizes.
 *
 * Coordinates are always SCREEN pixels in this module.
 */

(function (MapEditor) {
  'use strict';

  let _mainCanvas  = null;
  let _trailCanvas = null;
  let _trailCtx    = null;
  let _w = 0, _h = 0;

  const RasterOps = {};

  // ── Initialisation ─────────────────────────────────────────────────────

  /**
   * @param {HTMLCanvasElement} mainCanvas — the display canvas
   */
  RasterOps.init = function (mainCanvas) {
    _mainCanvas  = mainCanvas;
    _trailCanvas = document.createElement('canvas');
    _trailCtx    = _trailCanvas.getContext('2d');
    _resize();

    // Keep canvases in sync with the display canvas.
    window.addEventListener('resize', _resize);
  };

  function _resize() {
    _w = _mainCanvas.width;
    _h = _mainCanvas.height;
    _trailCanvas.width  = _w;
    _trailCanvas.height = _h;
    // Note: resizing clears the canvas automatically.
  }

  // ── Trail canvas ──────────────────────────────────────────────────────

  /** Erase the entire trail canvas (before starting a new draw gesture). */
  RasterOps.clearTrail = function () {
    _trailCtx.clearRect(0, 0, _w, _h);
  };

  /**
   * Paint a single filled disk onto the trail canvas.
   * The disk is always white (opacity = 1) so the alpha channel is a clean mask.
   *
   * @param {number} sx  screen x
   * @param {number} sy  screen y
   * @param {number} r   radius in screen pixels
   */
  RasterOps.drawDisk = function (sx, sy, r) {
    _trailCtx.beginPath();
    _trailCtx.arc(sx, sy, r, 0, Math.PI * 2);
    _trailCtx.fillStyle = '#ffffff';
    _trailCtx.fill();
  };

  /** Return the trail canvas (for tracing / read-only use). */
  RasterOps.getTrailCanvas = function () { return _trailCanvas; };

  // ── Mask canvases (created on demand) ────────────────────────────────

  /**
   * Rasterise a single UserObject (or any {shapes} duck-type) as a
   * white-on-transparent mask.  Accepts real UserObjects and also the
   * fake aggregate objects created by Expansion._makeMultiObjFake().
   * Returns a new HTMLCanvasElement (screen-sized).
   *
   * @param {{shapes: Shape[]}}   obj
   * @param {MapEditor.Viewport}  viewport
   * @returns {HTMLCanvasElement}
   */
  RasterOps.renderObjectMask = function (obj, viewport) {
    const canvas = _makeCanvas();
    const ctx    = canvas.getContext('2d');
    ctx.save();
    viewport.applyToContext(ctx);
    ctx.fillStyle = '#ffffff';
    for (const shape of obj.shapes) {
      if (shape.path2D) ctx.fill(shape.path2D, 'evenodd');
    }
    ctx.restore();
    return canvas;
  };

  /**
   * Rasterise all UserObjects EXCEPT excludeObjId plus all static paths as a
   * white-on-transparent "blocked" mask.  Used by the expansion engine to know
   * what the expanding frontier must not cross.
   *
   * @param {string|null}         excludeObjId  — id of the object being drawn
   * @param {MapEditor.Viewport}  viewport
   * @returns {HTMLCanvasElement}
   */
  RasterOps.renderBoundaryMask = function (excludeObjId, viewport) {
    const canvas = _makeCanvas();
    const ctx    = canvas.getContext('2d');
    ctx.save();
    viewport.applyToContext(ctx);
    ctx.fillStyle = '#ffffff';

    // Static world paths act as hard boundaries.
    if (MapEditor.WorldMap && MapEditor.WorldMap.isLoaded) {
      // Use stroke boundaries only for landmasses (the edge of land is a border).
      // Fill would block expansion inside landmasses, which is wrong —
      // user objects sit ON TOP of land, not outside it.
      // TODO(agent): distinguish ocean-land boundary vs mountain-type blockers
      MapEditor.WorldMap.drawFills(ctx);
    }

    // All other user objects block expansion.
    for (const obj of MapEditor.UserObjects.getAll()) {
      if (obj.id === excludeObjId) continue;
      for (const shape of obj.shapes) {
        if (shape.path2D) ctx.fill(shape.path2D, 'evenodd');
      }
    }

    ctx.restore();
    return canvas;
  };

  /**
   * Rasterise the FILLS of all static world paths as a white mask.
   * Used by the expansion engine for sea-clipping: any pixel NOT covered
   * by a static fill is considered ocean.
   *
   * Mountain fills are included (mountains are on land), so the land mask
   * correctly covers mountain areas.
   *
   * @param {MapEditor.Viewport} viewport
   * @returns {HTMLCanvasElement}
   */
  RasterOps.renderStaticPathFillMask = function (viewport) {
    const canvas = _makeCanvas();
    if (!MapEditor.WorldMap || !MapEditor.WorldMap.isLoaded) return canvas;

    const ctx = canvas.getContext('2d');
    ctx.save();
    viewport.applyToContext(ctx);
    ctx.fillStyle = '#ffffff';

    for (const sp of MapEditor.WorldMap.paths) {
      if (!sp.path2D || sp.fill === 'none') continue;
      ctx.fill(sp.path2D, 'nonzero');
    }

    ctx.restore();
    return canvas;
  };

  /**
   * Rasterise blocker strokes for coastlines and rivers.
   *
   * Mountains are intentionally excluded — they slow expansion rather than
   * stopping it (handled by the resistance map).
   *
   * Coastlines use COAST_STROKE_BLOCK_PX (wider barrier = reliable stop).
   * Rivers use RIVER_STROKE_BLOCK_PX (narrower = a brush spanning both banks
   * still places seeds on each side, so expansion works on both independently).
   *
   * @param {MapEditor.Viewport} viewport
   * @returns {HTMLCanvasElement}
   */
  RasterOps.renderStaticPathStrokeMask = function (viewport) {
    const canvas = _makeCanvas();
    if (!MapEditor.WorldMap || !MapEditor.WorldMap.isLoaded) return canvas;

    const { COAST_STROKE_BLOCK_PX, RIVER_STROKE_BLOCK_PX } = MapEditor.Config;
    const ctx = canvas.getContext('2d');
    ctx.save();
    viewport.applyToContext(ctx);
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    for (const sp of MapEditor.WorldMap.paths) {
      if (!sp.path2D) continue;
      if (sp.type === 'mountain') continue;   // mountains: resistance not block

      // Determine blocker width for this path type.
      const blockPx = sp.type === 'river' ? RIVER_STROKE_BLOCK_PX : COAST_STROKE_BLOCK_PX;

      // Only stroke paths that have a visible stroke OR are land/river boundaries.
      // We block land fills too (coastline = edge of filled land polygon), so
      // we mask paths that have either a stroke or a non-none fill.
      if (sp.stroke === 'none' && sp.fill === 'none') continue;

      ctx.lineWidth = viewport.screenPxToWorld(blockPx);
      ctx.stroke(sp.path2D);
    }

    ctx.restore();
    return canvas;
  };

  /**
   * Build a Float32Array resistance map for mountain contours.
   *
   * Each pixel's value = number of mountain contour polygons that cover it.
   * The expansion engine uses: advance × MOUNTAIN_FACTOR_PER_LEVEL ^ value
   *
   * Nested contours (higher elevation peaks) automatically accumulate higher
   * values because they are covered by all outer contours plus their own.
   * Mountain passes have fewer overlapping contours → lower value → faster.
   *
   * Returns null if no mountain paths are defined (avoids per-frame overhead).
   *
   * @param {MapEditor.Viewport} viewport
   * @returns {Float32Array|null}
   */
  RasterOps.renderMountainResistanceMap = function (viewport) {
    if (!MapEditor.WorldMap || !MapEditor.WorldMap.isLoaded) return null;

    const mountainPaths = MapEditor.WorldMap.pathsOfType('mountain');
    if (mountainPaths.length === 0) return null;

    const n   = _w * _h;
    const map = new Float32Array(n);
    const thr = MapEditor.Config.TRACE_ALPHA_THRESHOLD;

    for (const sp of mountainPaths) {
      if (!sp.path2D) continue;

      const tmpCanvas = _makeCanvas();
      const ctx = tmpCanvas.getContext('2d');
      ctx.save();
      viewport.applyToContext(ctx);
      ctx.fillStyle = '#ffffff';
      ctx.fill(sp.path2D, 'nonzero');
      ctx.restore();

      const alpha = ctx.getImageData(0, 0, _w, _h).data;
      for (let i = 0; i < n; i++) {
        if (alpha[i * 4 + 3] > thr) map[i] += 1;
      }
    }

    // Return null if no mountain pixels were found (avoids overhead later).
    for (let i = 0; i < n; i++) { if (map[i] > 0) return map; }
    return null;
  };

  // ── Accessors ─────────────────────────────────────────────────────────

  Object.defineProperty(RasterOps, 'width',  { get: () => _w });
  Object.defineProperty(RasterOps, 'height', { get: () => _h });

  // ── Internal helpers ──────────────────────────────────────────────────

  function _makeCanvas() {
    const c = document.createElement('canvas');
    c.width  = _w;
    c.height = _h;
    return c;
  }

  MapEditor.RasterOps = RasterOps;

})(window.MapEditor = window.MapEditor || {});
