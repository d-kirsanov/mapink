/**
 * src/pathOps.js
 *
 * Thin wrapper around Clipper.js (v6.x) for boolean polygon operations.
 *
 * Coordinate spaces:
 *   World space   — floats, 0..WORLD_WIDTH × 0..WORLD_HEIGHT
 *   Clipper space — integers = world × CLIPPER_SCALE (e.g. ×1000)
 *
 * All public functions accept and return world-space floats; Clipper integer
 * conversion is handled internally.
 *
 * "Polygons" throughout this module means Array<Array<{x:number,y:number}>>
 * (world space), matching the output of Tracing.traceCanvas().
 *
 * "ClipperPaths" means Array<Array<{X:int,Y:int}>> — Clipper's native format,
 * stored in Shape.clipperPolygons.
 */

(function (MapEditor) {
  'use strict';

  const { CLIPPER_SCALE, ID_SHAPE_PREFIX } = MapEditor.Config;

  // ── Coordinate conversion ─────────────────────────────────────────────────

  /** World-space polygon array → Clipper integer path array */
  function worldToClipper(worldPolys) {
    return worldPolys.map(poly =>
      poly.map(pt => ({
        X: Math.round(pt.x * CLIPPER_SCALE),
        Y: Math.round(pt.y * CLIPPER_SCALE),
      }))
    );
  }

  /** Clipper integer path array → world-space polygon array */
  function clipperToWorld(clipperPaths) {
    return clipperPaths.map(path =>
      path.map(pt => ({
        x: pt.X / CLIPPER_SCALE,
        y: pt.Y / CLIPPER_SCALE,
      }))
    );
  }

  // ── Boolean operations ────────────────────────────────────────────────────

  /**
   * Union of two world-space polygon sets.
   * @param {Array<Array<{x,y}>>} polysA
   * @param {Array<Array<{x,y}>>} polysB
   * @returns {Array<Array<{x,y}>>}
   */
  function union(polysA, polysB) {
    return clipperToWorld(_clipOp(
      worldToClipper(polysA),
      worldToClipper(polysB),
      ClipperLib.ClipType.ctUnion
    ));
  }

  /**
   * Difference: polysA minus polysB (world space).
   * @param {Array<Array<{x,y}>>} polysA
   * @param {Array<Array<{x,y}>>} polysB
   * @returns {Array<Array<{x,y}>>}
   */
  function difference(polysA, polysB) {
    return clipperToWorld(_clipOp(
      worldToClipper(polysA),
      worldToClipper(polysB),
      ClipperLib.ClipType.ctDifference
    ));
  }

  // ── Clipper internal operations ───────────────────────────────────────────

  /**
   * Execute a Clipper boolean operation.
   * Returns result ClipperPaths, or an empty array on failure.
   *
   * @param {ClipperPaths} cA  — subject
   * @param {ClipperPaths} cB  — clip
   * @param {number}       op  — ClipperLib.ClipType constant
   * @returns {ClipperPaths}
   */
  function _clipOp(cA, cB, op) {
    if (!cA || cA.length === 0) {
      if (op === ClipperLib.ClipType.ctUnion) return cB || [];
      return [];
    }
    if (!cB || cB.length === 0) {
      if (op === ClipperLib.ClipType.ctDifference) return cA;
      if (op === ClipperLib.ClipType.ctUnion)      return cA;
      return [];
    }

    try {
      const clipper  = new ClipperLib.Clipper();
      const solution = new ClipperLib.Paths();

      clipper.AddPaths(cA, ClipperLib.PolyType.ptSubject, true);
      clipper.AddPaths(cB, ClipperLib.PolyType.ptClip,    true);
      clipper.Execute(
        op,
        solution,
        ClipperLib.PolyFillType.pftNonZero,
        ClipperLib.PolyFillType.pftNonZero
      );

      // Clean up tiny artefacts from boolean ops.
      ClipperLib.Clipper.CleanPolygons(solution, CLIPPER_SCALE * 0.1);

      return solution;
    } catch (e) {
      MapEditor.debug('PathOps._clipOp error:', e);
      return cA;
    }
  }

  /**
   * Simplify / normalise a ClipperPaths (remove self-intersections, fix winding).
   * Useful for cleaning up paths imported from SVG.
   */
  function simplifyClipper(clipperPaths) {
    if (!clipperPaths || clipperPaths.length === 0) return [];
    return ClipperLib.Clipper.SimplifyPolygons(
      clipperPaths,
      ClipperLib.PolyFillType.pftNonZero
    );
  }

  // ── Shape builder helpers ─────────────────────────────────────────────────

  /**
   * Convert an array of world-space polygons (from tracing) into a fully
   * constructed Shape object ready for UserObjects.
   *
   * @param {Array<Array<{x,y}>>} worldPolys
   * @returns {Shape}
   */
  function buildShapeFromWorldPolys(worldPolys) {
    let clipperPaths = worldToClipper(worldPolys);
    clipperPaths = simplifyClipper(clipperPaths);

    const svgPath = clipperPathsToSvgD(clipperPaths);
    return {
      id:              MapEditor.nextId(ID_SHAPE_PREFIX),
      clipperPolygons: clipperPaths,
      svgPath,
      path2D:          new Path2D(svgPath),
      bounds:          computeBoundsFromClipper(clipperPaths),
    };
  }

  /**
   * Union a set of world-space polygons INTO an existing Shape.
   * Returns a new Shape (immutable update — caller replaces the old one).
   *
   * @param {Shape}                shape      — the existing Shape to union into
   * @param {Array<Array<{x,y}>>}  worldPolys — polygons to add
   * @returns {Shape}
   */
  function unionIntoShape(shape, worldPolys) {
    const newClipper = worldToClipper(worldPolys);
    let   result     = _clipOp(
      shape.clipperPolygons, newClipper, ClipperLib.ClipType.ctUnion
    );
    result = simplifyClipper(result);

    const svgPath = clipperPathsToSvgD(result);
    return {
      id:              shape.id,           // preserve id so titles follow the shape
      clipperPolygons: result,
      svgPath,
      path2D:          new Path2D(svgPath),
      bounds:          computeBoundsFromClipper(result),
    };
  }

  /**
   * Subtract a set of world-space polygons FROM an existing Shape.
   * If the result is empty returns null (shape should be removed).
   *
   * @param {Shape}                shape
   * @param {Array<Array<{x,y}>>}  worldPolys — polygons to subtract
   * @returns {Shape|null}
   */
  function differenceFromShape(shape, worldPolys) {
    const subClipper = worldToClipper(worldPolys);
    let   result     = _clipOp(
      shape.clipperPolygons, subClipper, ClipperLib.ClipType.ctDifference
    );
    result = simplifyClipper(result);

    if (!result || result.length === 0) return null;

    const svgPath = clipperPathsToSvgD(result);
    return {
      id:              shape.id,
      clipperPolygons: result,
      svgPath,
      path2D:          new Path2D(svgPath),
      bounds:          computeBoundsFromClipper(result),
    };
  }

  // ── SVG path helpers ──────────────────────────────────────────────────────

  /**
   * Encode ClipperPaths as an SVG 'd' string (world-space coordinates).
   * Uses absolute commands only: M ... L ... L ... Z
   */
  function clipperPathsToSvgD(clipperPaths) {
    if (!clipperPaths || clipperPaths.length === 0) return '';
    let d = '';
    for (const path of clipperPaths) {
      if (path.length < 2) continue;
      d += `M ${(path[0].X / CLIPPER_SCALE).toFixed(4)} ${(path[0].Y / CLIPPER_SCALE).toFixed(4)}`;
      for (let i = 1; i < path.length; i++) {
        d += ` L ${(path[i].X / CLIPPER_SCALE).toFixed(4)} ${(path[i].Y / CLIPPER_SCALE).toFixed(4)}`;
      }
      d += ' Z ';
    }
    return d.trimEnd();
  }

  /**
   * Parse an SVG 'd' string (world-space) into ClipperPaths.
   * Handles only M/L/Z — sufficient for our stored SVG paths.
   * Used when loading a saved map.
   */
  function svgDToClipperPaths(d) {
    if (!d) return [];
    const paths  = [];
    let   current = null;

    const tokens = d.match(/[MLZmlz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
    let i = 0;
    while (i < tokens.length) {
      const cmd = tokens[i];
      if (cmd === 'M' || cmd === 'm') {
        if (current && current.length >= 2) paths.push(current);
        current = [];
        i++;
        const x = parseFloat(tokens[i++]);
        const y = parseFloat(tokens[i++]);
        current.push({ X: Math.round(x * CLIPPER_SCALE), Y: Math.round(y * CLIPPER_SCALE) });
      } else if (cmd === 'L' || cmd === 'l') {
        i++;
        const x = parseFloat(tokens[i++]);
        const y = parseFloat(tokens[i++]);
        if (current) current.push({ X: Math.round(x * CLIPPER_SCALE), Y: Math.round(y * CLIPPER_SCALE) });
      } else if (cmd === 'Z' || cmd === 'z') {
        if (current && current.length >= 2) { paths.push(current); current = null; }
        i++;
      } else {
        i++;  // skip unknown token
      }
    }
    if (current && current.length >= 2) paths.push(current);
    return paths;
  }

  // ── Bounds helper ─────────────────────────────────────────────────────────

  /**
   * Compute world-space bounding box from ClipperPaths.
   * @param {ClipperPaths} clipperPaths
   * @returns {{x:number, y:number, x2:number, y2:number, w:number, h:number}}
   */
  function computeBoundsFromClipper(clipperPaths) {
    let x = Infinity, y = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const path of (clipperPaths || [])) {
      for (const pt of path) {
        const wx = pt.X / CLIPPER_SCALE;
        const wy = pt.Y / CLIPPER_SCALE;
        if (wx < x)  x  = wx;
        if (wy < y)  y  = wy;
        if (wx > x2) x2 = wx;
        if (wy > y2) y2 = wy;
      }
    }
    if (!isFinite(x)) return { x: 0, y: 0, x2: 0, y2: 0, w: 0, h: 0 };
    return { x, y, x2, y2, w: x2 - x, h: y2 - y };
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.PathOps = {
    worldToClipper,
    clipperToWorld,
    union,
    difference,
    simplifyClipper,
    buildShapeFromWorldPolys,
    unionIntoShape,
    differenceFromShape,
    clipperPathsToSvgD,
    svgDToClipperPaths,
    computeBoundsFromClipper,
  };

})(window.MapEditor = window.MapEditor || {});
