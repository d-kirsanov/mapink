/**
 * src/titleRenderer.js
 *
 * Draws object titles centered over the visible portion of each shape.
 *
 * ── Changes from previous version ────────────────────────────────────────────
 *
 *  CENTROID FIX
 *    Title position is now the polygon vertex centroid projected to screen,
 *    clamped to the visible bbox.  Previously, the plain visible-bbox centre
 *    was used, which placed titles in the wrong location for irregular/large
 *    shapes and caused titles of two adjacent countries to overlap at borders.
 *
 *  IN-PLACE EDITING
 *    Double-clicking a title opens an <input> positioned and styled to match
 *    the rendered title exactly: same font, size, color, screen position.
 *    The canvas suppresses rendering of the edited title while the input is
 *    open (_editingObjId), so there is no double-image.  Auto-resizes as you
 *    type.  Enter/Escape/blur to commit.
 */

(function (MapEditor) {
  'use strict';

  const TitleRenderer = {};

  const _measureCanvas = document.createElement('canvas');
  const _measureCtx    = _measureCanvas.getContext('2d');

  let _externalCols  = new Map();
  let _titleHitAreas = [];         // Array<{rect,cx,cy,fontSize,obj}> — reset per frame
  let _editingObjId  = null;       // id of object whose title is currently being edited

  // ── Init ──────────────────────────────────────────────────────────────────

  TitleRenderer.init = function () {
    MapEditor.canvas.addEventListener('dblclick', _onDoubleClick);
  };

  // ── Main draw (called every frame by renderer) ────────────────────────────

  /**
   * @param {CanvasRenderingContext2D} ctx       main canvas ctx (identity transform)
   * @param {MapEditor.Viewport}       viewport
   */
  TitleRenderer.drawTitles = function (ctx, viewport) {
    _externalCols.clear();
    _titleHitAreas = [];

    const W = MapEditor.canvas.width;
    const H = MapEditor.canvas.height;

    for (const obj of MapEditor.UserObjects.getAll()) {
      if (!obj.title) continue;
      if (obj.id === _editingObjId) continue;   // suppress while editing in-place

      for (const shape of obj.shapes) {
        if (!shape.bounds || shape.bounds.w === 0) continue;
        _drawShapeTitle(ctx, viewport, obj, shape, W, H);
      }
    }
  };

  /**
   * Return the UserObject whose title text covers screen point (sx, sy), or null.
   * Used by ui.js for hover highlighting over external labels.
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

  // ── Per-shape title ───────────────────────────────────────────────────────

  function _drawShapeTitle(ctx, viewport, obj, shape, W, H) {
    const { TITLE_MIN_FONT_PX, TITLE_MAX_FONT_PX, TITLE_PADDING_PX,
            TITLE_FONT_FAMILY, TITLE_FONT_WEIGHT } = MapEditor.Config;

    // ── Visible bbox on screen ────────────────────────────────────────────
    const sb  = shape.bounds;
    const s0  = viewport.worldToScreen(sb.x,  sb.y);
    const s1  = viewport.worldToScreen(sb.x2, sb.y2);
    const vx0 = Math.max(0, s0.x);
    const vy0 = Math.max(0, s0.y);
    const vx1 = Math.min(W, s1.x);
    const vy1 = Math.min(H, s1.y);

    if (vx1 <= vx0 || vy1 <= vy0) return;

    const vw = vx1 - vx0;
    const vh = vy1 - vy0;

    // ── Polygon-centroid title position, clamped to screen ─────────────────
    const wc = _shapeWorldCentroid(shape);
    let cx, cy;
    if (wc) {
      const sc = viewport.worldToScreen(wc.x, wc.y);
      cx = Math.max(vx0 + TITLE_PADDING_PX, Math.min(vx1 - TITLE_PADDING_PX, sc.x));
      cy = Math.max(vy0 + TITLE_PADDING_PX, Math.min(vy1 - TITLE_PADDING_PX, sc.y));
    } else {
      cx = (vx0 + vx1) / 2;
      cy = (vy0 + vy1) / 2;
    }

    // ── Fit font size ─────────────────────────────────────────────────────
    const availW = vw - TITLE_PADDING_PX * 2;
    const availH = vh - TITLE_PADDING_PX * 2;
    if (availW < 4 || availH < 4) return;

    const fontSize = _fitFontSize(
      obj.title, availW, availH,
      TITLE_MIN_FONT_PX, TITLE_MAX_FONT_PX,
      TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY
    );
    const textW = _measureText(obj.title, fontSize, TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY);

    if (fontSize <= TITLE_MIN_FONT_PX && textW > availW) {
      _drawExternalTitle(ctx, obj, shape, viewport, vx0, vx1, cy, fontSize, W, H);
      return;
    }

    // ── Clamp text box fully inside screen ────────────────────────────────
    // (prevents titles from being half-cut at screen edges when zoomed in)
    const halfW = textW / 2 + TITLE_PADDING_PX;
    const halfH = fontSize / 2 + 2;
    cx = Math.max(halfW, Math.min(W - halfW, cx));
    cy = Math.max(halfH, Math.min(H - halfH, cy));

    _renderTitle(ctx, obj.title, cx, cy, fontSize, obj.color,
                 TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY);
    _titleHitAreas.push({
      rect: { x: cx - textW / 2, y: cy - fontSize / 2, w: textW, h: fontSize },
      cx, cy, fontSize, obj,
    });
  }

  /**
   * Draw the title outside the shape when it doesn't fit inside.
   *
   * Placement priority:
   *   1. Right of shape  — if that column is free of other user objects (or is sea)
   *   2. Left  of shape  — if that column is free of other user objects (or is sea)
   *   3. Right of shape  — fallback regardless
   */
  function _drawExternalTitle(ctx, obj, shape, viewport, shapeLeft, shapeRight, cy,
                               fontSize, W, H) {
    const { TITLE_EXTERNAL_GAP_PX, TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY,
            TITLE_PADDING_PX } = MapEditor.Config;

    const textW = _measureText(obj.title, fontSize, TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY);
    const halfH = fontSize / 2 + 2;

    // Clamp vertical position so label doesn't go off-screen.
    const drawY = Math.max(halfH, Math.min(H - halfH, cy));

    // ── Candidate positions ───────────────────────────────────────────────
    const rightX = shapeRight + TITLE_EXTERNAL_GAP_PX;
    const leftX  = shapeLeft  - TITLE_EXTERNAL_GAP_PX - textW;

    const rightFits = (rightX + textW) <= W;
    const leftFits  = leftX >= 0;

    // Check if a horizontal band around (x, drawY) overlaps another object.
    // We test the screen midpoint of the label band at several y offsets.
    const _columnHasObject = (startX, bandW) => {
      const testY  = Math.max(0, Math.min(H - 1, drawY));
      const midX   = Math.max(0, Math.min(W - 1, startX + bandW / 2));
      const wp     = viewport.screenToWorld(midX, testY);
      const hit    = MapEditor.UserObjects.hitTest(wp.x, wp.y);
      return hit && hit.object.id !== obj.id;
    };

    let chosenX = null;

    if (rightFits && !_columnHasObject(rightX, textW)) {
      chosenX = rightX;                          // 1. right is clear
    } else if (leftFits && !_columnHasObject(leftX, textW)) {
      chosenX = leftX;                           // 2. left is clear
    } else if (rightFits) {
      chosenX = rightX;                          // 3. fallback: right anyway
    } else if (leftFits) {
      chosenX = leftX;
    } else {
      return;   // nowhere to put it
    }

    // Column occupancy to avoid vertical pile-up of same-side labels.
    const col   = Math.round(chosenX / 10) * 10;
    const lastY = _externalCols.get(col) || 0;
    const lineH = fontSize * 1.4;
    let   labelY = drawY;
    if (Math.abs(labelY - lastY) < lineH) labelY = lastY + lineH;
    if (labelY < halfH || labelY > H - halfH) return;
    _externalCols.set(col, labelY);

    const tcx = chosenX + textW / 2;
    _renderTitle(ctx, obj.title, tcx, labelY, fontSize, obj.color,
                 TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY);
    _titleHitAreas.push({
      rect: { x: chosenX, y: labelY - fontSize / 2, w: textW, h: fontSize },
      cx: tcx, cy: labelY, fontSize, obj,
    });
  }

  function _renderTitle(ctx, text, cx, cy, fontSize, objColor, fontWeight, fontFamily) {
    ctx.save();
    ctx.font            = `${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.textAlign       = 'center';
    ctx.textBaseline    = 'middle';
    ctx.shadowColor     = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur      = Math.max(3, fontSize * 0.25);
    ctx.shadowOffsetX   = 0;
    ctx.shadowOffsetY   = 1;
    ctx.fillStyle       = MapEditor.ColorUtils.contrastTextColor(objColor);
    ctx.fillText(text, cx, cy);
    ctx.restore();
  }

  // ── Double-click → in-place edit ─────────────────────────────────────────

  function _onDoubleClick(e) {
    if (e.ctrlKey || e.metaKey) return;   // Ctrl-dblclick reserved elsewhere

    const rect = MapEditor.canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;

    // Check title hit areas first (for external labels).
    let hitInfo = null;
    let hitObj  = null;
    for (const entry of _titleHitAreas) {
      const { rect: r } = entry;
      if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) {
        hitInfo = entry;
        hitObj  = entry.obj;
        break;
      }
    }

    // Fall back to shape hit test.
    if (!hitObj) {
      const wp  = MapEditor.viewport.screenToWorld(sx, sy);
      const hit = MapEditor.UserObjects.hitTest(wp.x, wp.y);
      if (!hit) return;
      hitObj = hit.object;
      // Build a fake hitInfo using the first title hit area for this object,
      // or synthesize one.
      const existing = _titleHitAreas.find(h => h.obj.id === hitObj.id);
      if (existing) {
        hitInfo = existing;
      } else {
        // Synthesize hit info from click position.
        hitInfo = { cx: sx, cy: sy, fontSize: 18, obj: hitObj };
      }
    }

    e.preventDefault();
    _openTitleEditor(hitObj, hitInfo);
  }

  /**
   * Position and style the title <input> to match the rendered title exactly.
   */
  function _openTitleEditor(obj, hitInfo) {
    const { TITLE_FONT_FAMILY, TITLE_FONT_WEIGHT } = MapEditor.Config;

    const wrap  = document.getElementById('titleEditWrap');
    const input = document.getElementById('titleEditInput');

    _editingObjId = obj.id;

    const textColor = MapEditor.ColorUtils.contrastTextColor(obj.color);
    const fs        = hitInfo.fontSize;
    const initW     = Math.max(
      _measureText(obj.title || '\u2003', fs, TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY) + 32,
      60
    );

    // Match rendering styles exactly.
    input.value = obj.title;
    input.style.fontSize   = fs + 'px';
    input.style.fontFamily = TITLE_FONT_FAMILY;
    input.style.fontWeight = TITLE_FONT_WEIGHT;
    input.style.color      = textColor;
    input.style.width      = initW + 'px';

    // Position centered on the title's screen location.
    wrap.style.left    = hitInfo.cx + 'px';
    wrap.style.top     = hitInfo.cy + 'px';
    wrap.style.display = 'block';

    input.focus();
    input.select();

    // Auto-resize as user types.
    input.oninput = () => {
      const w = Math.max(
        _measureText(input.value || '\u2003', fs, TITLE_FONT_WEIGHT, TITLE_FONT_FAMILY) + 32,
        60
      );
      input.style.width = w + 'px';
    };

    const commit = () => {
      obj.title     = input.value.trim();
      _editingObjId = null;
      wrap.style.display = 'none';
      MapEditor.undoStack.push(MapEditor.UserObjects.snapshot());
      if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) MapEditor.UI.refreshUndoButtons();
    };

    input.onblur    = commit;
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter')  { commit(); ev.preventDefault(); }
      if (ev.key === 'Escape') {
        _editingObjId      = null;
        wrap.style.display = 'none';
        ev.preventDefault();
      }
      ev.stopPropagation();
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Vertex centroid of the shape's clipper polygons in world space.
   * Much more accurate than bbox-centre for irregular shapes.
   */
  function _shapeWorldCentroid(shape) {
    const scale = MapEditor.Config.CLIPPER_SCALE;
    let sumX = 0, sumY = 0, count = 0;
    for (const poly of (shape.clipperPolygons || [])) {
      for (const pt of poly) {
        sumX += pt.X; sumY += pt.Y; count++;
      }
    }
    if (!count) return null;
    return { x: sumX / count / scale, y: sumY / count / scale };
  }

  function _fitFontSize(text, availW, availH, minPx, maxPx, weight, family) {
    if (_measureText(text, maxPx, weight, family) <= availW && maxPx <= availH) return maxPx;
    let lo = minPx, hi = maxPx;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      (_measureText(text, mid, weight, family) <= availW && mid <= availH) ? (lo = mid) : (hi = mid);
    }
    return Math.max(minPx, Math.floor(lo));
  }

  function _measureText(text, size, weight, family) {
    _measureCtx.font = `${weight} ${size}px ${family}`;
    return _measureCtx.measureText(text).width;
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.TitleRenderer = TitleRenderer;

})(window.MapEditor = window.MapEditor || {});
