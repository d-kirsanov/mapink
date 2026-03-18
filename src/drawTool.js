/**
 * src/drawTool.js
 *
 * Handles left-button (add) and right-button (erase) drawing on the map.
 *
 * ── Draw gesture lifecycle ──────────────────────────────────────────────────
 *
 *  mousedown  → determine target object and mode; clear trail canvas; mark
 *               a pre-draw undo snapshot (stored temporarily, not pushed yet)
 *
 *  mousemove  → emit disks along the cursor path onto the trail canvas
 *               (RasterOps.drawDisk) and into _diskTrail[] for the overlay
 *
 *  mouseup    → push the pre-draw snapshot onto undoStack; hand the filled
 *               trail canvas to _finalizeTrail() which traces it, applies the
 *               boolean op, and updates UserObjects.
 *               (In Part 5 this is replaced by Expansion.start().)
 *
 * ── Disk size profile (time-driven) ─────────────────────────────────────────
 *
 *   t ∈ [0, GROW]:           r = lerp(MIN, MAX, t / GROW)
 *   t ∈ [GROW, GROW+TAPER]:  r = lerp(MAX, MIN, (t-GROW) / TAPER)
 *   t > GROW+TAPER:          r = MIN   (stays small)
 *
 *   All radii are in SCREEN pixels (constant visible size regardless of zoom).
 *
 * ── Coordinate note ──────────────────────────────────────────────────────────
 *
 *   Trail canvas & disk positions are in SCREEN pixels.
 *   Hit-testing passes WORLD coords to isPointInPath (see userObjects.js).
 *   Finalisation converts traced screen polygons → world via viewport.
 */

(function (MapEditor) {
  'use strict';

  const DrawTool = {};

  // ── State ─────────────────────────────────────────────────────────────────

  let _drawing         = false;
  let _mode            = 'add';      // 'add' | 'erase'
  let _targetObjId     = null;       // id of the UserObject being modified
  let _targetIsNew     = false;      // true when we created a new object for this gesture
  let _startTime       = 0;         // Date.now() at mousedown (for disk profile)
  let _lastDiskX       = 0;         // screen coords of last emitted disk
  let _lastDiskY       = 0;
  let _hasPrevDisk     = false;
  let _diskTrail       = [];         // [{sx, sy, r}] for drawOverlay
  let _preDrawSnapshot = null;       // snapshot taken at mousedown, pushed on mouseup

  // ── Initialisation ────────────────────────────────────────────────────────

  DrawTool.init = function () {
    const canvas = MapEditor.canvas;

    canvas.addEventListener('mousedown',  _onMouseDown);
    window.addEventListener('mousemove',  _onMouseMove);
    window.addEventListener('mouseup',    _onMouseUp);

    // Prevent the context menu on right-click over the canvas.
    canvas.addEventListener('dblclick', _onDoubleClick);
  };

  // ── Public interface ──────────────────────────────────────────────────────

  DrawTool.isDrawing = () => _drawing;

  /**
   * Composite the live draw trail over the main canvas.
   * Called by renderer.js on every frame while drawing.
   * Uses screen-space coordinates — no viewport transform needed.
   *
   * @param {CanvasRenderingContext2D} ctx
   */
  DrawTool.drawOverlay = function (ctx) {
    if (!_drawing || _diskTrail.length === 0) return;

    ctx.save();
    ctx.globalAlpha = 0.75;

    if (_mode === 'add') {
      // Fill disks in the target object's colour.
      const obj   = MapEditor.UserObjects.getById(_targetObjId);
      ctx.fillStyle = obj ? obj.color : '#ffffff';
      for (const { sx, sy, r } of _diskTrail) {
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Erase: show semi-transparent red disks.
      ctx.fillStyle = 'rgba(220, 50, 50, 0.9)';
      for (const { sx, sy, r } of _diskTrail) {
        ctx.beginPath();
        ctx.arc(sx, sy, r * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  };

  // ── Mouse event handlers ──────────────────────────────────────────────────

  function _onMouseDown(e) {
    // Only left (0) or right (2) button; ignore middle (pan is handled in main.js).
    if (e.button !== 0 && e.button !== 2) return;

    const { viewport } = MapEditor;
    const rect = MapEditor.canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;
    const wp   = viewport.screenToWorld(sx, sy);

    // ── Ctrl+click: move shape to last-edited object ──────────────────────
    if (e.ctrlKey || e.metaKey) {
      const hit = MapEditor.UserObjects.hitTest(wp.x, wp.y);
      if (hit) {
        const lastEdited = MapEditor.UserObjects.getLastEdited();
        if (lastEdited && lastEdited.id !== hit.object.id) {
          _pushUndo();
          MapEditor.UserObjects.moveShapeTo(hit.shape.id, lastEdited.id);
        }
      }
      return;
    }

    // ── Normal draw / erase ───────────────────────────────────────────────
    const isErase = (e.button === 2);
    const hit     = MapEditor.UserObjects.hitTest(wp.x, wp.y);

    if (isErase) {
      if (!hit) return;  // erase does nothing on empty space
      _mode        = 'erase';
      _targetObjId = hit.object.id;
      _targetIsNew = false;
    } else {
      _mode = 'add';
      if (hit) {
        // Drawing on an existing object → add to it.
        _targetObjId = hit.object.id;
        _targetIsNew = false;
        MapEditor.UserObjects.setLastEdited(_targetObjId);
      } else if (e.shiftKey) {
        // Shift+draw on empty space → add new disconnected shape to last-edited.
        const lastEdited = MapEditor.UserObjects.getLastEdited();
        if (lastEdited) {
          _targetObjId = lastEdited.id;
          _targetIsNew = false;
        } else {
          // No last-edited → create new object as fallback.
          const obj    = MapEditor.UserObjects.create();
          _targetObjId = obj.id;
          _targetIsNew = true;
        }
      } else {
        // Draw on empty space → create a new object.
        const obj    = MapEditor.UserObjects.create();
        _targetObjId = obj.id;
        _targetIsNew = true;
      }
    }

    // ── Begin gesture ─────────────────────────────────────────────────────
    _preDrawSnapshot = MapEditor.UserObjects.snapshot();
    // If we just created a new empty object, we need to include the pre-creation
    // state in the snapshot.  Re-snapshot after temporarily removing the new empty
    // object so undo rolls back to before it existed.
    if (_targetIsNew) {
      // Temporarily remove the freshly-created (empty) object from the snapshot.
      _preDrawSnapshot.userObjects = _preDrawSnapshot.userObjects.filter(
        o => o.id !== _targetObjId
      );
    }

    MapEditor.RasterOps.clearTrail();
    _diskTrail    = [];
    _startTime    = Date.now();
    _hasPrevDisk  = false;
    _drawing      = true;

    e.preventDefault();

    // Emit the first disk at the click position.
    _maybeEmitDisks(sx, sy);
  }

  function _onMouseMove(e) {
    if (!_drawing) return;

    const rect = MapEditor.canvas.getBoundingClientRect();
    const sx   = e.clientX - rect.left;
    const sy   = e.clientY - rect.top;

    _maybeEmitDisks(sx, sy);
  }

  function _onMouseUp(e) {
    if (!_drawing) return;
    if (e.button !== 0 && e.button !== 2) return;

    _drawing = false;

    const hasTrail = _diskTrail.length > 0;
    if (!hasTrail) {
      // No disks emitted (user just clicked without moving).
      // Clean up empty object created on mousedown, if any.
      if (_targetIsNew) MapEditor.UserObjects.remove(_targetObjId);
      _reset();
      return;
    }

    // Push pre-draw state onto undo stack BEFORE applying changes.
    MapEditor.undoStack.push(_preDrawSnapshot);
    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) {
      MapEditor.UI.refreshUndoButtons();
    }

    if (MapEditor.spaceHeld) {
      // Space held: commit raw trail directly, no expansion.
      _finalizeTrail();
      _reset();
    } else {
      // Hand off to expansion engine.  _reset() is called here immediately
      // because the expansion engine is now in charge; the draw state is no
      // longer needed.  Expansion reads the trail canvas before this frame ends.
      const objId  = _targetObjId;
      const mode   = _mode;
      const isNew  = _targetIsNew;
      _reset();
      MapEditor.Expansion.start(objId, mode, isNew);
    }
  }

  function _onDoubleClick(e) {
    // Handled by UI module (Part 6).
    // Prevent the double-click from starting a draw gesture.
    e.preventDefault();
  }

  // ── Disk emission ─────────────────────────────────────────────────────────

  /**
   * Advance along the cursor path, emitting disks at the configured density.
   * The radius is determined by the time-driven profile.
   */
  function _maybeEmitDisks(sx, sy) {
    const r       = _diskRadius();
    const spacing = MapEditor.Config.TRAIL_DENSITY_PX * r;

    if (!_hasPrevDisk) {
      _emitDisk(sx, sy, r);
      _lastDiskX   = sx;
      _lastDiskY   = sy;
      _hasPrevDisk = true;
      return;
    }

    const dx   = sx - _lastDiskX;
    const dy   = sy - _lastDiskY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < spacing) return;  // haven't moved far enough yet

    // Interpolate disks at equal spacing along the segment.
    const steps = Math.floor(dist / spacing);
    for (let i = 1; i <= steps; i++) {
      const t  = (i * spacing) / dist;
      const ix = _lastDiskX + dx * t;
      const iy = _lastDiskY + dy * t;
      _emitDisk(ix, iy, r);
    }

    // Advance last-disk position to the last emitted disk (not the current cursor).
    const t      = (steps * spacing) / dist;
    _lastDiskX   = _lastDiskX + dx * t;
    _lastDiskY   = _lastDiskY + dy * t;
  }

  function _emitDisk(sx, sy, r) {
    MapEditor.RasterOps.drawDisk(sx, sy, r);
    _diskTrail.push({ sx, sy, r });
  }

  /**
   * Time-driven disk radius profile.
   *
   *  Phase 1 (grow):  r = MIN + (MAX−MIN) × t / GROW_TIME
   *  Phase 2 (taper): r = MAX − (MAX−MIN) × (t−GROW) / TAPER_TIME
   *  After both:      r = MIN
   *
   * @returns {number} radius in screen pixels
   */
  function _diskRadius() {
    const { DISK_RADIUS_MIN_PX, DISK_RADIUS_MAX_PX,
            PROFILE_GROW_TIME_S, PROFILE_TAPER_TIME_S } = MapEditor.Config;

    const t = (Date.now() - _startTime) / 1000;  // seconds

    if (t < PROFILE_GROW_TIME_S) {
      return DISK_RADIUS_MIN_PX +
        (DISK_RADIUS_MAX_PX - DISK_RADIUS_MIN_PX) * (t / PROFILE_GROW_TIME_S);
    }

    const t2 = t - PROFILE_GROW_TIME_S;
    if (t2 < PROFILE_TAPER_TIME_S) {
      return DISK_RADIUS_MAX_PX -
        (DISK_RADIUS_MAX_PX - DISK_RADIUS_MIN_PX) * (t2 / PROFILE_TAPER_TIME_S);
    }

    return DISK_RADIUS_MIN_PX;
  }

  // ── Trail finalisation ────────────────────────────────────────────────────

  /**
   * Trace the trail canvas, build world-space polygons, and apply the
   * boolean operation (union or difference) to the target object.
   *
   * In Part 5 the expansion engine replaces this call so that the operation
   * is animated and respects boundaries.  The expansion engine will call back
   * into the same union/difference logic after the animation completes.
   */
  function _finalizeTrail() {
    const viewport   = MapEditor.viewport;
    const trailCanvas = MapEditor.RasterOps.getTrailCanvas();

    // Trace the raster into world-space polygons.
    const worldPolys = MapEditor.Tracing.traceCanvas(trailCanvas, viewport);

    if (!worldPolys || worldPolys.length === 0) {
      // Trail was too small to trace — discard.
      if (_targetIsNew) MapEditor.UserObjects.remove(_targetObjId);
      return;
    }

    _applyPolygonsToTarget(worldPolys, _targetObjId, _mode, _targetIsNew);
  }

  /**
   * Apply a set of world-space polygons to the target object.
   * Exported so the expansion engine (Part 5) can call it with the final
   * expanded polygon set.
   *
   * @param {Array<Array<{x,y}>>} worldPolys
   * @param {string}              objId
   * @param {'add'|'erase'}       mode
   * @param {boolean}             targetIsNew  — true if the object was just created
   */
  DrawTool.applyPolygonsToTarget = function (worldPolys, objId, mode, targetIsNew) {
    _applyPolygonsToTarget(worldPolys, objId, mode, targetIsNew);
  };

  function _applyPolygonsToTarget(worldPolys, objId, mode, isNew) {
    const obj = MapEditor.UserObjects.getById(objId);
    if (!obj) return;

    if (mode === 'add') {
      if (obj.shapes.length === 0) {
        const shape = MapEditor.PathOps.buildShapeFromWorldPolys(worldPolys);
        MapEditor.UserObjects.setShapes(objId, [shape]);
      } else {
        const mergedShape = _mergeAllShapesWithPolys(obj, worldPolys);
        MapEditor.UserObjects.setShapes(objId, [mergedShape]);
      }
      _subtractFromNeighbours(worldPolys, objId);
    } else {
      const newShapes = obj.shapes
        .map(s => MapEditor.PathOps.differenceFromShape(s, worldPolys))
        .filter(Boolean);
      MapEditor.UserObjects.setShapes(objId, newShapes);
    }

    // Always finish with the drawn-on object as last-edited, regardless of
    // what _subtractFromNeighbours or setShapes may have changed it to.
    MapEditor.UserObjects.setLastEdited(objId);
  }

  function _mergeAllShapesWithPolys(obj, worldPolys) {
    let result = obj.shapes[0];
    for (let i = 1; i < obj.shapes.length; i++) {
      result = MapEditor.PathOps.unionIntoShape(result, _shapeToWorldPolys(obj.shapes[i]));
    }
    return MapEditor.PathOps.unionIntoShape(result, worldPolys);
  }

  function _shapeToWorldPolys(shape) {
    return MapEditor.PathOps.clipperToWorld(shape.clipperPolygons);
  }

  /**
   * Subtract worldPolys from all UserObjects other than excludeId.
   * Saves and restores _lastEditedId so that Ctrl+click and Shift+draw
   * always target the object the user explicitly drew on, not the last
   * neighbour that happened to be shrunk.
   */
  function _subtractFromNeighbours(worldPolys, excludeId) {
    // Save before iterating — setShapes() would clobber _lastEditedId.
    const savedId = MapEditor.UserObjects.getLastEdited()
      ? MapEditor.UserObjects.getLastEdited().id
      : null;

    for (const obj of MapEditor.UserObjects.getAll().slice()) {
      if (obj.id === excludeId) continue;
      const newShapes = obj.shapes
        .map(s => MapEditor.PathOps.differenceFromShape(s, worldPolys))
        .filter(Boolean);
      MapEditor.UserObjects.setShapes(obj.id, newShapes);
    }

    // Restore so the target object remains "last edited".
    if (savedId) MapEditor.UserObjects.setLastEdited(savedId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _pushUndo() {
    const snap = MapEditor.UserObjects.snapshot();
    MapEditor.undoStack.push(snap);
    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) {
      MapEditor.UI.refreshUndoButtons();
    }
  }

  function _reset() {
    _drawing         = false;
    _targetObjId     = null;
    _targetIsNew     = false;
    _hasPrevDisk     = false;
    _diskTrail       = [];
    _preDrawSnapshot = null;
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.DrawTool = DrawTool;

})(window.MapEditor = window.MapEditor || {});
