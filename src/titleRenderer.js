/**
 * src/titleRenderer.js
 *
 * Draws object titles centered over the visible portion of each shape.
 *
 * Sizing rules:
 *   1. Binary-search font size so text fits the visible bounding box.
 *   2. Clamp to [TITLE_MIN_FONT_PX, TITLE_MAX_FONT_PX] (both in screen px).
 *   3. If at min size and still too wide:
 *      a. Try placing label to the RIGHT of the object (if column is clear).
 *      b. Otherwise hide it.
 *
 * All geometry is computed in SCREEN space (after viewport transform) so
 * font sizes remain constant regardless of zoom.
 *
 * Double-click to edit is wired here (canvas dblclick → show <input>).
 */

(function (MapEditor) {
  'use strict';

  const TitleRenderer = {};

  // Scratch canvas for measuring text width at a given font size.
  const _measureCanvas = document.createElement('canvas');
  const _measureCtx    = _measureCanvas.getContext('2d');

  // Tracks external-label column occupancy to avoid pile-ups.
  // Reset each frame: Map<colX → maxY used so far>
  let _externalCols = new Map();

  // Hit areas for all rendered titles this frame (for hover detection).
  // Array of { rect: {x,y,w,h}, obj: UserObject }
  let _titleHitAreas = [];

  // ── Init ──────────────────────────────────────────────────────────────────

  TitleRenderer.init = function () {
    const canvas = MapEditor.canvas;
    canvas.addEventListener('dblclick', _onDoubleClick);
  };

  // ── Main draw call (called by renderer every frame) ───────────────────────

  /**
   * @param {CanvasRenderingContext2D} ctx       main canvas context (identity transform)
   * @param {MapEditor.Viewport}       viewport
   */
  TitleRenderer.drawTitles = function (ctx, viewport) {
    _externalCols.clear();
    _titleHitAreas = [];   // reset for hover detection

    for (const obj of MapEditor.UserObjects.getAll()) {
      if (!obj.title) continue;
      for (const shape of obj.shapes) {
        if (!shape.bounds || shape.bounds.w === 0) continue;
        _drawShapeTitle(ctx, viewport, obj, shape);
      }
    }
  };

  /**
   * Return the UserObject whose title text is at screen position (sx, sy),
   * or null.  Used by ui.js for hover highlighting over external labels.
   */
  TitleRenderer.hitTestTitle = function (sx, sy) {
    for (const { rect, obj } of _titleHitAreas) {
      if (sx >= rect.x && sx <= rect.x + rect.w &&
          sy >= rect.y && sy <= rect.y + rect.h) {
        return obj;
      }
    }
    return null;
  };

  // ── Per-shape title drawing ───────────────────────────────────────────────

  function _drawShapeTitle(ctx, viewport, obj, shape) {
    const { TITLE_MIN_FONT_PX, TITLE_MAX_FONT_PX, TITLE_PADDING_PX,
            TITLE_FONT_FAMILY, TITLE_FONT_WEIGHT, TITLE_EXTERNAL_GAP_PX } = MapEditor.Config;

    const W = MapEditor.canvas.width;
    const H = MapEditor.canvas.height;

    // ── Visible bounding box of the shape on screen ──────────────────────
    const sb = shape.bounds;
    if (!sb || sb.w === 0) return;

    const s0  = viewport.worldToScreen(sb.x,  sb.y);
    const s1  = viewport.worldToScreen(sb.x2, sb.y2);

    // Intersect with canvas
    const vx0 = Math.max(0, s0.x);
    const vy0 = Math.max(0, s0.y);
    const vx1 = Math.min(W, s1.x);
    const vy1 = Math.min(H, s1.y);

    if (vx1 <= vx0 || vy1 <= vy0) return;   // shape not visible

    const vw = vx1 - vx0;
    const vh = vy1 - vy0;

    const cx = (vx0 + vx1) / 2;
    const cy = (vy0 + vy1) / 2;

    // ── Fit font size by binary search ───────────────────────────────────
    const availW = vw - TITLE_PADDING_PX * 2;
    const availH = vh - TITLE_PADDING_PX * 2;
    if (availW < 4 || availH < 4) return;

    let fontSize = _fitFontSize(
      obj.title, availW, availH,
      TITLE_MIN_FONT_PX, TITLE_MAX_FONT_PX,
      TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY
    );

    const textW = _measureText(obj.title, fontSize, TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY);

    if (fontSize <= TITLE_MIN_FONT_PX && textW > availW) {
      // Try external placement to the right.
      _drawExternalTitle(ctx, obj, shape, viewport, vx1, cy, fontSize);
      return;
    }

    // ── Draw centered inside ──────────────────────────────────────────────
    _renderTitle(ctx, obj.title, cx, cy, fontSize, obj.color,
                 TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY);
    // Record hit area for hover detection.
    const tw = _measureText(obj.title, fontSize, TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY);
    _titleHitAreas.push({
      rect: { x: cx - tw / 2, y: cy - fontSize / 2, w: tw, h: fontSize },
      obj,
    });
  }

  function _drawExternalTitle(ctx, obj, shape, viewport, shapeRight, cy, fontSize) {
    const { TITLE_EXTERNAL_GAP_PX, TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY } = MapEditor.Config;
    const W = MapEditor.canvas.width;

    const textW = _measureText(obj.title, fontSize, TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY);
    const x = shapeRight + TITLE_EXTERNAL_GAP_PX;

    if (x + textW > W) return;  // won't fit to the right either — hide

    // Check column occupancy to avoid vertical pile-up.
    const col    = Math.round(x / 10) * 10;   // bucket x to nearest 10px
    const lastY  = _externalCols.get(col) || 0;
    const lineH  = fontSize * 1.4;

    let y = cy;
    if (Math.abs(y - lastY) < lineH) y = lastY + lineH;
    if (y < 0 || y > MapEditor.canvas.height) return;

    _externalCols.set(col, y);
    _renderTitle(ctx, obj.title, x + textW / 2, y, fontSize, obj.color,
                 TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY);
    _titleHitAreas.push({
      rect: { x, y: y - fontSize / 2, w: textW, h: fontSize },
      obj,
    });
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  function _renderTitle(ctx, text, cx, cy, fontSize, objColor,
                        fontWeight, fontFamily) {
    ctx.save();
    ctx.font      = `${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // White shadow for legibility on any background color.
    ctx.shadowColor   = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur    = Math.max(3, fontSize * 0.2);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;

    // Choose white or black text depending on object color.
    ctx.fillStyle = MapEditor.ColorUtils.contrastTextColor(objColor);

    ctx.fillText(text, cx, cy);
    ctx.restore();
  }

  /**
   * Binary-search the largest font size where text fits within availW × availH.
   */
  function _fitFontSize(text, availW, availH, minPx, maxPx, weight, family) {
    // Quick check: does it fit at max?
    if (_measureText(text, maxPx, weight, family) <= availW && maxPx <= availH) {
      return maxPx;
    }

    let lo = minPx, hi = maxPx;
    for (let iter = 0; iter < 12; iter++) {
      const mid = (lo + hi) / 2;
      if (_measureText(text, mid, weight, family) <= availW && mid <= availH) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return Math.max(minPx, Math.floor(lo));
  }

  function _measureText(text, size, weight, family) {
    _measureCtx.font = `${weight} ${size}px ${family}`;
    return _measureCtx.measureText(text).width;
  }

  // ── Double-click to edit title ────────────────────────────────────────────

  function _onDoubleClick(e) {
    // Only handle plain double-clicks (no modifier keys — those may be used
    // for colour picker in ui.js).
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;

    const viewport = MapEditor.viewport;
    const rect     = MapEditor.canvas.getBoundingClientRect();
    const sx       = e.clientX - rect.left;
    const sy       = e.clientY - rect.top;
    const wp       = viewport.screenToWorld(sx, sy);

    const hit = MapEditor.UserObjects.hitTest(wp.x, wp.y);
    if (!hit) return;

    e.preventDefault();
    _openTitleEditor(hit.object, sx, sy);
  }

  /**
   * Show an absolutely-positioned <input> over the clicked point so the
   * user can edit the title in place.
   */
  function _openTitleEditor(obj, sx, sy) {
    const { TITLE_MIN_FONT_PX, TITLE_MAX_FONT_PX,
            TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY } = MapEditor.Config;

    const wrap  = document.getElementById('titleEditWrap');
    const input = document.getElementById('titleEditInput');

    // Estimate a reasonable display font size for the input.
    const shape = obj.shapes[0];
    let displaySize = 16;
    if (shape && shape.bounds) {
      const viewport = MapEditor.viewport;
      const sb  = shape.bounds;
      const s0  = viewport.worldToScreen(sb.x,  sb.y);
      const s1  = viewport.worldToScreen(sb.x2, sb.y2);
      const vw  = Math.max(0, Math.min(MapEditor.canvas.width,  s1.x) - Math.max(0, s0.x));
      const vh  = Math.max(0, Math.min(MapEditor.canvas.height, s1.y) - Math.max(0, s0.y));
      displaySize = _fitFontSize(
        obj.title || 'X', vw - 12, vh - 12,
        TITLE_MIN_FONT_PX, TITLE_MAX_FONT_PX,
        TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY
      );
    }

    input.value = obj.title;
    input.style.fontSize  = displaySize + 'px';
    input.style.minWidth  = Math.max(80, displaySize * 6) + 'px';
    wrap.style.display    = 'block';
    wrap.style.left       = (sx - 60) + 'px';
    wrap.style.top        = (sy - displaySize) + 'px';
    input.focus();
    input.select();

    const commit = () => {
      obj.title = input.value.trim();
      wrap.style.display = 'none';
      // Push undo state so title edit is undoable.
      MapEditor.undoStack.push(MapEditor.UserObjects.snapshot());
      if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) {
        MapEditor.UI.refreshUndoButtons();
      }
    };

    // Remove old listeners before adding new ones to avoid stacking.
    input.onblur   = commit;
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter')  { commit(); ev.preventDefault(); }
      if (ev.key === 'Escape') { wrap.style.display = 'none'; ev.preventDefault(); }
      ev.stopPropagation();   // prevent global shortcuts while editing
    };
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.TitleRenderer = TitleRenderer;

})(window.MapEditor = window.MapEditor || {});
