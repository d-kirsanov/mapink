/**
 * src/renderer.js
 *
 * Main render loop.  Composites all visual layers onto the display canvas
 * on every animation frame.
 *
 * Layer order (back → front):
 *   1. Ocean background (solid fill)
 *   2. World rectangle border (faint outline)
 *   3. Static path fills  (landmasses, lakes, etc.)
 *   4. User object fills  (sorted largest-first so small ones paint on top)
 *   5. Static path strokes (constant screen-width)
 *   6. User object borders (semi-transparent, thin)
 *   7. Active expansion overlay (live raster from expansion.js — semi-transparent)
 *   8. Active draw trail (live disk trail from drawTool.js — semi-transparent)
 *   9. Titles (from titleRenderer.js)
 *  10. Debug overlays (only when Config.DEBUG is true)
 *
 * Usage:
 *   MapEditor.Renderer.start();   // begin rAF loop
 *   MapEditor.Renderer.stop();    // pause loop
 *   MapEditor.Renderer.redraw();  // force one frame immediately (for init)
 */

(function (MapEditor) {
  'use strict';

  const Renderer = {};

  // rAF handle; null when stopped.
  let _rafHandle = null;

  // ── Start / stop ─────────────────────────────────────────────────────────

  Renderer.start = function () {
    if (_rafHandle !== null) return;   // already running
    _loop();
  };

  Renderer.stop = function () {
    if (_rafHandle !== null) {
      cancelAnimationFrame(_rafHandle);
      _rafHandle = null;
    }
  };

  /** Draw one frame immediately (useful before the loop starts). */
  Renderer.redraw = function () {
    _drawFrame();
  };

  // ── Main loop ─────────────────────────────────────────────────────────────

  function _loop() {
    _drawFrame();
    _rafHandle = requestAnimationFrame(_loop);
  }

  function _drawFrame() {
    // Gather required modules — all must be initialised by main.js before
    // Renderer.start() is called.
    const canvas   = MapEditor.canvas;
    const ctx      = MapEditor.ctx;
    const viewport = MapEditor.viewport;

    if (!canvas || !ctx || !viewport) return;

    const W = canvas.width;
    const H = canvas.height;
    const { OCEAN_COLOR, WORLD_WIDTH, WORLD_HEIGHT,
            WORLD_BORDER_COLOR, OBJECT_BORDER_ALPHA } = MapEditor.Config;

    // ── 1. Ocean background ─────────────────────────────────────────────
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);   // identity — fill whole canvas
    ctx.fillStyle = OCEAN_COLOR;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // Apply viewport transform for all world-space drawing.
    ctx.save();
    viewport.applyToContext(ctx);

    // ── 2. World boundary rectangle ─────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = WORLD_BORDER_COLOR;
    ctx.lineWidth   = viewport.screenPxToWorld(1);
    ctx.strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    ctx.restore();

    // ── 3. Static fills ─────────────────────────────────────────────────
    if (MapEditor.WorldMap && MapEditor.WorldMap.isLoaded) {
      MapEditor.WorldMap.drawFills(ctx);
    }

    // ── 4. User object fills ─────────────────────────────────────────────
    _drawUserObjectFills(ctx, viewport);

    // ── 5. Static strokes ────────────────────────────────────────────────
    if (MapEditor.WorldMap && MapEditor.WorldMap.isLoaded) {
      MapEditor.WorldMap.drawStrokes(ctx, viewport);
    }

    // ── 6. User object borders ───────────────────────────────────────────
    _drawUserObjectBorders(ctx, viewport);

    // ── 6b. Hover highlight ──────────────────────────────────────────────
    if (MapEditor.UI && MapEditor.UI.getHoverObjId) {
      const hoverId = MapEditor.UI.getHoverObjId();
      if (hoverId) {
        const hoverObj = MapEditor.UserObjects && MapEditor.UserObjects.getById(hoverId);
        if (hoverObj) {
          ctx.save();
          ctx.fillStyle   = 'rgba(255,255,255,0.18)';
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth   = viewport.screenPxToWorld(2);
          for (const shape of hoverObj.shapes) {
            if (!shape.path2D) continue;
            ctx.fill(shape.path2D, 'evenodd');
            ctx.stroke(shape.path2D);
          }
          ctx.restore();
        }
      }
    }

    ctx.restore();   // end viewport transform

    // ── 7. Expansion overlay (screen-space raster) ───────────────────────
    if (MapEditor.Expansion && MapEditor.Expansion.isActive()) {
      MapEditor.Expansion.drawOverlay(ctx);
    }

    // ── 8. Draw trail overlay (screen-space raster) ──────────────────────
    if (MapEditor.DrawTool && MapEditor.DrawTool.isDrawing()) {
      MapEditor.DrawTool.drawOverlay(ctx);
    }

    // ── 9. Titles ────────────────────────────────────────────────────────
    if (MapEditor.TitleRenderer) {
      MapEditor.TitleRenderer.drawTitles(ctx, viewport);
    }

    // ── 10. Debug overlays ───────────────────────────────────────────────
    if (MapEditor.Config.DEBUG) {
      _drawDebugOverlay(ctx, viewport);
    }
  }

  // ── User object rendering ─────────────────────────────────────────────────

  /**
   * Draw filled shapes for all user objects, sorted largest bounding-box
   * area first so smaller objects render on top (more visible).
   */
  function _drawUserObjectFills(ctx, viewport) {
    const objs = MapEditor.UserObjects && MapEditor.UserObjects.getAll();
    if (!objs || objs.length === 0) return;

    // Sort largest-area first (by bounding box area of first shape as proxy)
    const sorted = objs.slice().sort((a, b) => {
      const areaA = _objectBoundsArea(a);
      const areaB = _objectBoundsArea(b);
      return areaB - areaA;   // descending
    });

    for (const obj of sorted) {
      if (!obj.shapes || obj.shapes.length === 0) continue;

      ctx.fillStyle = obj.color;

      for (const shape of obj.shapes) {
        if (!shape.path2D) continue;
        ctx.fill(shape.path2D, 'evenodd');
      }
    }
  }

  /**
   * Draw thin semi-transparent borders around user object shapes.
   */
  function _drawUserObjectBorders(ctx, viewport) {
    const objs = MapEditor.UserObjects && MapEditor.UserObjects.getAll();
    if (!objs || objs.length === 0) return;

    const { OBJECT_BORDER_ALPHA } = MapEditor.Config;
    ctx.lineWidth = viewport.screenPxToWorld(1);
    ctx.lineCap   = 'round';
    ctx.lineJoin  = 'round';

    for (const obj of objs) {
      if (!obj.shapes || obj.shapes.length === 0) continue;

      // Slightly darkened version of the object color at reduced opacity
      const col = MapEditor.ColorUtils.adjustLightness(obj.color, -0.15);
      ctx.strokeStyle = col;
      ctx.globalAlpha = OBJECT_BORDER_ALPHA;

      for (const shape of obj.shapes) {
        if (!shape.path2D) continue;
        ctx.stroke(shape.path2D);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _objectBoundsArea(obj) {
    if (!obj.shapes || obj.shapes.length === 0) return 0;
    let total = 0;
    for (const s of obj.shapes) {
      if (s.bounds) total += s.bounds.w * s.bounds.h;
    }
    return total;
  }

  // ── Debug overlay ─────────────────────────────────────────────────────────

  function _drawDebugOverlay(ctx, viewport) {
    const vb = viewport.getVisibleBounds();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle   = 'rgba(255,255,0,0.85)';
    ctx.font        = '11px monospace';
    ctx.fillText(
      `zoom=${viewport.zoom.toFixed(2)}  pan=(${viewport.panX.toFixed(1)}, ${viewport.panY.toFixed(1)})` +
      `  vis=(${vb.x.toFixed(1)},${vb.y.toFixed(1)})–(${vb.x2.toFixed(1)},${vb.y2.toFixed(1)})`,
      8, canvas.height - 10
    );
    ctx.restore();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.Renderer = Renderer;

})(window.MapEditor = window.MapEditor || {});
