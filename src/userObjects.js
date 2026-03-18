/**
 * src/userObjects.js
 *
 * Data model for user-painted map regions.
 *
 * UserObject  — a named, colored map region (e.g. a country).
 *   .id              string
 *   .shapes          Shape[]
 *   .color           '#rrggbb'
 *   .title           string
 *   .lastEdited      number (Date.now())
 *
 * Shape  — one connected polygon island within a UserObject.
 *   .id              string
 *   .clipperPolygons Array<Array<{X:int,Y:int}>>  — Clipper integer coords (×CLIPPER_SCALE)
 *   .svgPath         string                         — cached SVG 'd' for serialisation
 *   .path2D          Path2D                         — cached for canvas rendering & hit-test
 *   .bounds          {x, y, x2, y2, w, h}           — world-space bounding box
 *
 * Snapshot (used by UndoStack, JSON-serialisable):
 *   { userObjects: [...], lastEditedId: string|null }
 *
 * path2D is NOT stored in snapshots — applySnapshot() rebuilds it from svgPath
 * via `new Path2D(svgPath)` with no dependency on PathOps load order.
 */

(function (MapEditor) {
  'use strict';

  // ── Module state ─────────────────────────────────────────────────────────

  let _objects      = [];
  let _lastEditedId = null;

  // Dedicated hit-test context with identity transform.
  // Path2D stores world-space coords, so we pass world-space points here.
  const _hitCanvas = document.createElement('canvas');
  _hitCanvas.width = _hitCanvas.height = 4;
  const _hitCtx = _hitCanvas.getContext('2d');

  // ── Public API ────────────────────────────────────────────────────────────

  const UserObjects = {};

  UserObjects.init = function () {
    _objects      = [];
    _lastEditedId = null;
  };

  UserObjects.getAll      = () => _objects;
  UserObjects.getById     = (id) => _objects.find(o => o.id === id) || null;
  UserObjects.getLastEdited = () => _lastEditedId
    ? (UserObjects.getById(_lastEditedId) || null)
    : null;
  UserObjects.setLastEdited = (id) => { _lastEditedId = id; };

  /**
   * Create a new UserObject with a maximally-different colour.
   * Starts with zero shapes; call setShapes() or addShape() to populate it.
   */
  UserObjects.create = function () {
    const existingColors = _objects.map(o => o.color);
    const color = MapEditor.ColorUtils.findMostDifferentColor(existingColors);
    const obj = {
      id:         MapEditor.nextId(MapEditor.Config.ID_OBJECT_PREFIX),
      shapes:     [],
      color,
      title:      '',
      lastEdited: Date.now(),
    };
    _objects.push(obj);
    _lastEditedId = obj.id;
    return obj;
  };

  /** Remove an object.  Clears lastEditedId if it matched. */
  UserObjects.remove = function (id) {
    const idx = _objects.findIndex(o => o.id === id);
    if (idx >= 0) _objects.splice(idx, 1);
    if (_lastEditedId === id) _lastEditedId = null;
  };

  /**
   * Replace the shapes array on an object.
   * Empty shapes → object is automatically removed.
   */
  UserObjects.setShapes = function (objId, shapes) {
    const obj = UserObjects.getById(objId);
    if (!obj) return;
    obj.shapes     = shapes;
    obj.lastEdited = Date.now();
    _lastEditedId  = objId;
    if (shapes.length === 0) UserObjects.remove(objId);
  };

  /** Append one Shape to an existing object (Shift-draw new territory). */
  UserObjects.addShape = function (objId, shape) {
    const obj = UserObjects.getById(objId);
    if (!obj) return;
    obj.shapes.push(shape);
    obj.lastEdited = Date.now();
    _lastEditedId  = objId;
  };

  /**
   * Hit-test a world-space point against all shapes.
   *
   * ctx.isPointInPath(path2D, x, y) treats x/y in the same coordinate space as
   * the path regardless of the context's current transform.  Our path2Ds are in
   * world space, so we pass world-space coordinates to the identity-transform
   * _hitCtx.  No viewport transform is needed here.
   *
   * Tests smallest-area objects first so small objects on top get priority.
   *
   * @param {number} worldX
   * @param {number} worldY
   * @returns {{object, shape}|null}
   */
  UserObjects.hitTest = function (worldX, worldY) {
    const sorted = _objects.slice().sort((a, b) => _objArea(a) - _objArea(b));
    for (const obj of sorted) {
      for (const shape of obj.shapes) {
        if (shape.path2D && _hitCtx.isPointInPath(shape.path2D, worldX, worldY)) {
          return { object: obj, shape };
        }
      }
    }
    return null;
  };

  /**
   * Move a shape from its current owner to targetObjId (Ctrl+click).
   * Removes the source object if it becomes empty.
   */
  UserObjects.moveShapeTo = function (shapeId, targetObjId) {
    let shape = null, srcObj = null;
    for (const obj of _objects) {
      const idx = obj.shapes.findIndex(s => s.id === shapeId);
      if (idx >= 0) {
        shape  = obj.shapes.splice(idx, 1)[0];
        srcObj = obj;
        break;
      }
    }
    if (!shape) return;
    if (srcObj && srcObj.shapes.length === 0) UserObjects.remove(srcObj.id);
    const target = UserObjects.getById(targetObjId);
    if (target) {
      target.shapes.push(shape);
      target.lastEdited = Date.now();
      _lastEditedId = targetObjId;
    }
  };

  // ── Snapshot / restore ────────────────────────────────────────────────────

  /** JSON-serialisable snapshot for UndoStack.  Omits path2D. */
  UserObjects.snapshot = function () {
    return {
      userObjects: _objects.map(obj => ({
        id:         obj.id,
        color:      obj.color,
        title:      obj.title,
        lastEdited: obj.lastEdited,
        shapes:     obj.shapes.map(s => ({
          id:              s.id,
          clipperPolygons: s.clipperPolygons.map(poly =>
            poly.map(pt => ({ X: pt.X, Y: pt.Y }))
          ),
          svgPath: s.svgPath,
          bounds:  { ...s.bounds },
        })),
      })),
      lastEditedId: _lastEditedId,
    };
  };

  /** Restore state from a snapshot.  Rebuilds path2D from svgPath. */
  UserObjects.applySnapshot = function (state) {
    _objects = state.userObjects.map(obj => ({
      id:         obj.id,
      color:      obj.color,
      title:      obj.title,
      lastEdited: obj.lastEdited,
      shapes:     obj.shapes.map(s => ({
        id:              s.id,
        clipperPolygons: s.clipperPolygons,
        svgPath:         s.svgPath,
        bounds:          s.bounds,
        path2D:          s.svgPath ? new Path2D(s.svgPath) : new Path2D(),
      })),
    }));
    _lastEditedId = state.lastEditedId || null;
    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) {
      MapEditor.UI.refreshUndoButtons();
    }
  };

  // ── Internal helpers ──────────────────────────────────────────────────────

  function _objArea(obj) {
    let a = 0;
    for (const s of obj.shapes) { if (s.bounds) a += s.bounds.w * s.bounds.h; }
    return a;
  }

  MapEditor.UserObjects = UserObjects;

})(window.MapEditor = window.MapEditor || {});
