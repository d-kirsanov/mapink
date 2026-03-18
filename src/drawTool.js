/**
 * src/drawTool.js
 *
 * Handles left-button (add) and right-button (erase) drawing on the map.
 *
 * ── Changes from previous version ────────────────────────────────────────────
 *
 *  • All disks are a uniform DISK_RADIUS_MAX_PX — no grow/taper profile.
 *    The triangle/tentacle profile emerges naturally: the base of a stroke
 *    has been expanding longer than its tip, so it ends up wider.
 *
 *  • Expansion starts immediately on mousedown via Expansion.startLive().
 *    Each emitted disk is passed to Expansion.addSeeds() in real time.
 *    On mouseup, Expansion.finishLive() switches to the decay phase.
 *
 *  • Space-held mode: expansion is skipped; the raw trail is committed
 *    immediately on mouseup (same as before).
 *
 *  • DrawTool.drawOverlay() is a no-op in live expansion mode —
 *    Expansion.drawOverlay() renders everything.  The trail overlay is still
 *    shown in space-held mode for visual feedback.
 *
 * ── Coordinate note ────────────────────────────────────────────────────────
 *  Trail canvas & disk positions: screen pixels.
 *  Hit-testing passes WORLD coords to isPointInPath (see userObjects.js).
 *  Expansion.addSeeds() receives screen coords directly.
 */

(function (MapEditor) {
  'use strict';

  const DrawTool = {};

  // ── State ─────────────────────────────────────────────────────────────────

  let _drawing          = false;
  let _mode             = 'add';
  let _targetObjId      = null;
  let _targetIsNew      = false;
  let _usingLiveExpansion = false;   // false in space-held mode

  let _lastDiskX        = 0;
  let _lastDiskY        = 0;
  let _hasPrevDisk      = false;
  let _diskTrail        = [];        // [{sx,sy,r}] for space-held overlay
  let _preDrawSnapshot  = null;      // for Expansion.cancel() recovery

  // ── Init ──────────────────────────────────────────────────────────────────

  DrawTool.init = function () {
    const canvas = MapEditor.canvas;
    canvas.addEventListener('mousedown',  _onMouseDown);
    window.addEventListener('mousemove',  _onMouseMove);
    window.addEventListener('mouseup',    _onMouseUp);
    canvas.addEventListener('dblclick',   _onDoubleClick);
  };

  // ── Public interface ──────────────────────────────────────────────────────

  DrawTool.isDrawing = () => _drawing;

  /**
   * Draw overlay for space-held mode only.
   * In live expansion mode Expansion.drawOverlay() handles visuals.
   */
  DrawTool.drawOverlay = function (ctx) {
    if (!_drawing || _usingLiveExpansion || _diskTrail.length === 0) return;

    ctx.save();
    ctx.globalAlpha = 0.75;
    const obj = MapEditor.UserObjects.getById(_targetObjId);
    if (_mode === 'add') {
      ctx.fillStyle = obj ? obj.color : '#ffffff';
    } else {
      ctx.fillStyle = 'rgba(220,50,50,0.9)';
    }
    for (const { sx, sy, r } of _diskTrail) {
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  // ── Shared apply function (called by Expansion._finalize) ─────────────────

  DrawTool.applyPolygonsToTarget = function (worldPolys, objId, mode, targetIsNew) {
    _applyPolygonsToTarget(worldPolys, objId, mode, targetIsNew);
  };

  // ── Mouse event handlers ──────────────────────────────────────────────────

  function _onMouseDown(e) {
    if (e.button !== 0 && e.button !== 2) return;

    // Finalize any running expansion before starting a new gesture.
    if (MapEditor.Expansion && MapEditor.Expansion.isActive()) {
      MapEditor.Expansion.stop();
    }

    const viewport = MapEditor.viewport;
    const rect     = MapEditor.canvas.getBoundingClientRect();
    const sx       = e.clientX - rect.left;
    const sy       = e.clientY - rect.top;
    const wp       = viewport.screenToWorld(sx, sy);

    // ── Ctrl+click: move shape to last-edited object ──────────────────────
    if (e.ctrlKey || e.metaKey) {
      const hit = MapEditor.UserObjects.hitTest(wp.x, wp.y);
      if (hit) {
        const lastEdited = MapEditor.UserObjects.getLastEdited();
        if (lastEdited && lastEdited.id !== hit.object.id) {
          _pushUndo();
          MapEditor.UserObjects.moveShapeTo(hit.shape.id, lastEdited.id);
          MapEditor.UserObjects.setLastEdited(lastEdited.id);
        }
      }
      return;
    }

    // ── Determine target object and mode ─────────────────────────────────
    const isErase = (e.button === 2);
    const hit     = MapEditor.UserObjects.hitTest(wp.x, wp.y);

    if (isErase) {
      if (!hit) return;
      _mode        = 'erase';
      _targetObjId = hit.object.id;
      _targetIsNew = false;
    } else {
      _mode = 'add';
      if (hit) {
        _targetObjId = hit.object.id;
        _targetIsNew = false;
        MapEditor.UserObjects.setLastEdited(_targetObjId);
      } else if (e.shiftKey) {
        const lastEdited = MapEditor.UserObjects.getLastEdited();
        if (lastEdited) {
          _targetObjId = lastEdited.id;
          _targetIsNew = false;
        } else {
          const obj    = MapEditor.UserObjects.create();
          _targetObjId = obj.id;
          _targetIsNew = true;
        }
      } else {
        const obj    = MapEditor.UserObjects.create();
        _targetObjId = obj.id;
        _targetIsNew = true;
      }
    }

    // ── Take pre-draw snapshot (for Expansion.cancel()) ───────────────────
    _preDrawSnapshot = MapEditor.UserObjects.snapshot();
    if (_targetIsNew) {
      _preDrawSnapshot.userObjects = _preDrawSnapshot.userObjects.filter(
        o => o.id !== _targetObjId
      );
    }

    // ── Begin gesture ──────────────────────────────────────────────────────
    MapEditor.RasterOps.clearTrail();
    _diskTrail    = [];
    _hasPrevDisk  = false;
    _drawing      = true;

    _usingLiveExpansion = !MapEditor.spaceHeld;

    if (_usingLiveExpansion) {
      MapEditor.Expansion.startLive(_targetObjId, _mode, _targetIsNew, _preDrawSnapshot);
    }

    e.preventDefault();
    _emitDisk(sx, sy);
  }

  function _onMouseMove(e) {
    if (!_drawing) return;
    const rect = MapEditor.canvas.getBoundingClientRect();
    _maybeEmitDisks(e.clientX - rect.left, e.clientY - rect.top);
  }

  function _onMouseUp(e) {
    if (!_drawing) return;
    if (e.button !== 0 && e.button !== 2) return;

    _drawing = false;

    if (_diskTrail.length === 0) {
      // No disks emitted — clean up.
      if (_targetIsNew) MapEditor.UserObjects.remove(_targetObjId);
      if (_usingLiveExpansion && MapEditor.Expansion.isActive()) {
        MapEditor.Expansion.cancel();
      }
      _reset();
      return;
    }

    if (_usingLiveExpansion) {
      _reset();
      // Switch expansion from constant-speed to decay phase.
      MapEditor.Expansion.finishLive();
    } else {
      // Space-held: commit raw trail immediately.
      _finalizeTrail();
      _reset();
    }
  }

  function _onDoubleClick(e) {
    // Handled by titleRenderer; prevent accidental draw.
    e.preventDefault();
  }

  // ── Disk emission ─────────────────────────────────────────────────────────

  function _maybeEmitDisks(sx, sy) {
    const r       = MapEditor.Config.DISK_RADIUS_MAX_PX;
    const spacing = MapEditor.Config.TRAIL_DENSITY_PX * r;

    if (!_hasPrevDisk) {
      _emitDisk(sx, sy);
      _lastDiskX   = sx;
      _lastDiskY   = sy;
      _hasPrevDisk = true;
      return;
    }

    const dx   = sx - _lastDiskX;
    const dy   = sy - _lastDiskY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < spacing) return;

    const steps = Math.floor(dist / spacing);
    for (let i = 1; i <= steps; i++) {
      const t  = (i * spacing) / dist;
      _emitDisk(_lastDiskX + dx * t, _lastDiskY + dy * t);
    }
    const t    = (steps * spacing) / dist;
    _lastDiskX = _lastDiskX + dx * t;
    _lastDiskY = _lastDiskY + dy * t;
  }

  function _emitDisk(sx, sy) {
    const r = MapEditor.Config.DISK_RADIUS_MAX_PX;

    // Write to trail canvas (used by space-held path and tracing fallback).
    MapEditor.RasterOps.drawDisk(sx, sy, r);
    _diskTrail.push({ sx, sy, r });

    if (!_hasPrevDisk) {
      _lastDiskX   = sx;
      _lastDiskY   = sy;
      _hasPrevDisk = true;
    }

    // In live expansion mode, send disk directly to expansion engine.
    if (_usingLiveExpansion) {
      MapEditor.Expansion.addSeeds(sx, sy, r);
    }
  }

  // ── Space-held finalization ───────────────────────────────────────────────

  /**
   * Commit the raw trail immediately (Space-held mode).
   * Pushes to undo AFTER applying (mirrors Expansion._finalize behaviour).
   */
  function _finalizeTrail() {
    const worldPolys = MapEditor.Tracing.traceCanvas(
      MapEditor.RasterOps.getTrailCanvas(), MapEditor.viewport
    );
    if (!worldPolys || worldPolys.length === 0) {
      if (_targetIsNew) MapEditor.UserObjects.remove(_targetObjId);
    } else {
      _applyPolygonsToTarget(worldPolys, _targetObjId, _mode, _targetIsNew);
    }
    MapEditor.undoStack.push(MapEditor.UserObjects.snapshot());
    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) MapEditor.UI.refreshUndoButtons();
  }

  // ── Apply polygons ────────────────────────────────────────────────────────

  function _applyPolygonsToTarget(worldPolys, objId, mode, isNew) {
    const obj = MapEditor.UserObjects.getById(objId);
    if (!obj) return;

    if (mode === 'add') {
      if (obj.shapes.length === 0) {
        const shape = MapEditor.PathOps.buildShapeFromWorldPolys(worldPolys);
        MapEditor.UserObjects.setShapes(objId, [shape]);
      } else {
        const merged = _mergeAllShapesWithPolys(obj, worldPolys);
        MapEditor.UserObjects.setShapes(objId, [merged]);
      }
      _subtractFromNeighbours(worldPolys, objId);
    } else {
      const newShapes = obj.shapes
        .map(s => MapEditor.PathOps.differenceFromShape(s, worldPolys))
        .filter(Boolean);
      MapEditor.UserObjects.setShapes(objId, newShapes);
    }
    MapEditor.UserObjects.setLastEdited(objId);
  }

  function _mergeAllShapesWithPolys(obj, worldPolys) {
    let result = obj.shapes[0];
    for (let i = 1; i < obj.shapes.length; i++) {
      result = MapEditor.PathOps.unionIntoShape(
        result, MapEditor.PathOps.clipperToWorld(obj.shapes[i].clipperPolygons)
      );
    }
    return MapEditor.PathOps.unionIntoShape(result, worldPolys);
  }

  function _subtractFromNeighbours(worldPolys, excludeId) {
    const savedId = MapEditor.UserObjects.getLastEdited()
      ? MapEditor.UserObjects.getLastEdited().id : null;

    for (const obj of MapEditor.UserObjects.getAll().slice()) {
      if (obj.id === excludeId) continue;
      const newShapes = obj.shapes
        .map(s => MapEditor.PathOps.differenceFromShape(s, worldPolys))
        .filter(Boolean);
      MapEditor.UserObjects.setShapes(obj.id, newShapes);
    }

    if (savedId) MapEditor.UserObjects.setLastEdited(savedId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _pushUndo() {
    MapEditor.undoStack.push(MapEditor.UserObjects.snapshot());
    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) MapEditor.UI.refreshUndoButtons();
  }

  function _reset() {
    _drawing             = false;
    _targetObjId         = null;
    _targetIsNew         = false;
    _usingLiveExpansion  = false;
    _hasPrevDisk         = false;
    _diskTrail           = [];
    _preDrawSnapshot     = null;
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.DrawTool = DrawTool;

})(window.MapEditor = window.MapEditor || {});
