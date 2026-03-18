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
   * Rasterise the STROKES of all static world paths as a white mask.
   * This is the primary blocker for expansion: coastlines, river edges, etc.
   *
   * We render strokes at 4 screen-pixels wide (slightly thicker than the
   * visual 1.5px stroke) to ensure no gaps in the barrier at any zoom level.
   *
   * Fills are intentionally NOT rendered here — countries are painted over
   * land fills freely; only the stroke boundary (coast/river edge) stops them.
   *
   * @param {MapEditor.Viewport} viewport
   * @returns {HTMLCanvasElement}
   */
  RasterOps.renderStaticPathStrokeMask = function (viewport) {
    const canvas = _makeCanvas();
    if (!MapEditor.WorldMap || !MapEditor.WorldMap.isLoaded) return canvas;

    const ctx = canvas.getContext('2d');
    ctx.save();
    viewport.applyToContext(ctx);
    ctx.strokeStyle = '#ffffff';
    // 4px screen-space width: thick enough to form a continuous barrier,
    // thinner than anything that would block meaningful painting.
    ctx.lineWidth   = viewport.screenPxToWorld(4);
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    for (const sp of MapEditor.WorldMap.paths) {
      if (!sp.path2D || sp.stroke === 'none') continue;
      ctx.stroke(sp.path2D);
    }

    ctx.restore();
    return canvas;
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
