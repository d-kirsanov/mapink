/**
 * src/viewport.js
 *
 * Viewport manages pan/zoom and all coordinate transforms between
 * world space and screen (canvas pixel) space.
 *
 * World space  ──  equirectangular projection, 0..WORLD_WIDTH × 0..WORLD_HEIGHT
 * Screen space ──  canvas pixels, origin top-left
 *
 * Forward transform (world → screen):
 *   sx = (wx − panX) * zoom + canvas.width  / 2
 *   sy = (wy − panY) * zoom + canvas.height / 2
 *
 * Inverse transform (screen → world):
 *   wx = (sx − canvas.width  / 2) / zoom + panX
 *   wy = (sy − canvas.height / 2) / zoom + panY
 *
 * panX / panY is the world coordinate that sits at the CENTER of the canvas.
 */

(function (MapEditor) {
  'use strict';

  class Viewport {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
      this.canvas = canvas;

      const { WORLD_WIDTH, WORLD_HEIGHT } = MapEditor.Config;
      // Start with the world center; zoom will be set by fitToScreen().
      this.panX = WORLD_WIDTH  / 2;
      this.panY = WORLD_HEIGHT / 2;
      this.zoom = 1;

      this._minZoom = 0;  // computed by _updateZoomBounds
      this._maxZoom = Infinity;
      this._updateZoomBounds();
      this.fitToScreen();
    }

    // ── Zoom bound calculation ───────────────────────────────────────────────

    /**
     * Recompute absolute zoom limits from canvas size and Config factors.
     * Call after canvas resize.
     */
    _updateZoomBounds() {
      const { WORLD_WIDTH, WORLD_HEIGHT, ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX } = MapEditor.Config;
      const fitZoom = Math.min(
        this.canvas.width  / WORLD_WIDTH,
        this.canvas.height / WORLD_HEIGHT
      );
      this._minZoom = fitZoom * ZOOM_FACTOR_MIN;
      this._maxZoom = fitZoom * ZOOM_FACTOR_MAX;
    }

    // ── Core transforms ──────────────────────────────────────────────────────

    /**
     * World coordinates → screen coordinates.
     * @param {number} wx
     * @param {number} wy
     * @returns {{x:number, y:number}}
     */
    worldToScreen(wx, wy) {
      return {
        x: (wx - this.panX) * this.zoom + this.canvas.width  / 2,
        y: (wy - this.panY) * this.zoom + this.canvas.height / 2,
      };
    }

    /**
     * Screen coordinates → world coordinates.
     * @param {number} sx
     * @param {number} sy
     * @returns {{x:number, y:number}}
     */
    screenToWorld(sx, sy) {
      return {
        x: (sx - this.canvas.width  / 2) / this.zoom + this.panX,
        y: (sy - this.canvas.height / 2) / this.zoom + this.panY,
      };
    }

    // ── Navigation ───────────────────────────────────────────────────────────

    /**
     * Zoom by the given factor, keeping the screen point (sx, sy) fixed
     * in world space.  Used for mouse-wheel zoom.
     * @param {number} sx  - screen x of zoom anchor
     * @param {number} sy  - screen y of zoom anchor
     * @param {number} factor - multiplier (>1 = zoom in, <1 = zoom out)
     */
    zoomAtPoint(sx, sy, factor) {
      // World point currently under the anchor:
      const wx = (sx - this.canvas.width  / 2) / this.zoom + this.panX;
      const wy = (sy - this.canvas.height / 2) / this.zoom + this.panY;

      const newZoom = Math.max(this._minZoom, Math.min(this._maxZoom, this.zoom * factor));
      if (newZoom === this.zoom) return;  // already at limit

      // After applying newZoom, the same world point must sit at (sx, sy):
      //   sx = (wx − panX_new) * newZoom + canvas.width / 2
      //   ⟹  panX_new = wx − (sx − canvas.width / 2) / newZoom
      this.panX = wx - (sx - this.canvas.width  / 2) / newZoom;
      this.panY = wy - (sy - this.canvas.height / 2) / newZoom;
      this.zoom = newZoom;
    }

    /**
     * Pan by a screen-pixel delta (from mouse drag).
     * @param {number} dsx  - screen-space horizontal delta
     * @param {number} dsy  - screen-space vertical delta
     */
    panBy(dsx, dsy) {
      // Moving the screen right by dsx means the world pans left by dsx/zoom:
      this.panX -= dsx / this.zoom;
      this.panY -= dsy / this.zoom;
    }

    /**
     * Reset to show the entire world, centered, with a small margin.
     * Bound to the Home key.
     */
    fitToScreen() {
      const { WORLD_WIDTH, WORLD_HEIGHT } = MapEditor.Config;
      this._updateZoomBounds();
      this.zoom = Math.min(
        this.canvas.width  / WORLD_WIDTH,
        this.canvas.height / WORLD_HEIGHT
      ) * 0.95;               // 5 % margin so the world doesn't touch canvas edges
      this.panX = WORLD_WIDTH  / 2;
      this.panY = WORLD_HEIGHT / 2;
    }

    // ── Context helpers ──────────────────────────────────────────────────────

    /**
     * Apply the viewport transform to a 2D canvas context so that
     * subsequent drawing commands use world coordinates.
     *
     * Usage:
     *   ctx.save();
     *   viewport.applyToContext(ctx);
     *   ctx.fillRect(worldX, worldY, worldW, worldH);
     *   ctx.restore();
     *
     * @param {CanvasRenderingContext2D} ctx
     */
    applyToContext(ctx) {
      const cx = this.canvas.width  / 2;
      const cy = this.canvas.height / 2;
      // setTransform(a, b, c, d, e, f) where the matrix is:
      //   [ a  c  e ]   [ zoom   0    cx − panX*zoom ]
      //   [ b  d  f ] = [  0    zoom  cy − panY*zoom ]
      //   [ 0  0  1 ]   [  0     0         1        ]
      ctx.setTransform(
        this.zoom, 0,
        0, this.zoom,
        cx - this.panX * this.zoom,
        cy - this.panY * this.zoom
      );
    }

    /**
     * Reset the context transform to identity (screen space).
     * @param {CanvasRenderingContext2D} ctx
     */
    resetContext(ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ── Utility ──────────────────────────────────────────────────────────────

    /**
     * Return the currently visible rectangle in world coordinates.
     * Note: the world is finite ([0..WORLD_WIDTH] × [0..WORLD_HEIGHT]) but the
     * viewport may extend beyond those bounds when zoomed out or panned to edge.
     *
     * @returns {{x:number, y:number, x2:number, y2:number, width:number, height:number}}
     */
    getVisibleBounds() {
      const tl = this.screenToWorld(0, 0);
      const br = this.screenToWorld(this.canvas.width, this.canvas.height);
      return {
        x: tl.x, y: tl.y,
        x2: br.x, y2: br.y,
        width:  br.x - tl.x,
        height: br.y - tl.y,
      };
    }

    /**
     * Return the visible world rectangle clamped to world bounds.
     * Useful for raster operations that only care about what's on the map.
     *
     * @returns {{x:number, y:number, x2:number, y2:number, width:number, height:number}}
     */
    getClampedVisibleBounds() {
      const { WORLD_WIDTH, WORLD_HEIGHT } = MapEditor.Config;
      const b = this.getVisibleBounds();
      const x  = Math.max(0, b.x);
      const y  = Math.max(0, b.y);
      const x2 = Math.min(WORLD_WIDTH,  b.x2);
      const y2 = Math.min(WORLD_HEIGHT, b.y2);
      return { x, y, x2, y2, width: x2 - x, height: y2 - y };
    }

    /**
     * Convert a screen-space stroke width to world-space so that the stroke
     * appears at a constant physical size regardless of zoom level.
     *
     * Usage: ctx.lineWidth = viewport.screenPxToWorld(STATIC_STROKE_WIDTH_PX);
     *
     * @param {number} screenPx
     * @returns {number} world-space width
     */
    screenPxToWorld(screenPx) {
      return screenPx / this.zoom;
    }

    /**
     * Convert a world-space length to screen pixels.
     * @param {number} worldUnits
     * @returns {number}
     */
    worldToScreenPx(worldUnits) {
      return worldUnits * this.zoom;
    }

    /**
     * Update after the canvas has been resized (e.g. window resize handler).
     * Clamps the current zoom to the new limits.
     */
    onResize() {
      this._updateZoomBounds();
      this.zoom = Math.max(this._minZoom, Math.min(this._maxZoom, this.zoom));
    }

    /** Current zoom level (px / world unit). Read-only shorthand. */
    get zoomLevel() { return this.zoom; }

    /** True if currently at maximum zoom. */
    get atMaxZoom() { return this.zoom >= this._maxZoom * 0.999; }

    /** True if currently at minimum zoom. */
    get atMinZoom() { return this.zoom <= this._minZoom * 1.001; }
  }

  MapEditor.Viewport = Viewport;

})(window.MapEditor = window.MapEditor || {});
