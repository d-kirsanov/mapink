/**
 * src/tracing.js
 *
 * Converts a binary raster (canvas alpha channel) into a set of closed
 * polygon contours using the marching-squares algorithm, then simplifies
 * them with Ramer–Douglas–Peucker.
 *
 * Coordinate systems:
 *   Input  — screen pixels (from the trail/expansion canvas)
 *   Output — world-space floats (via viewport.screenToWorld)
 *
 * Public API:
 *   MapEditor.Tracing.traceCanvas(canvas, viewport) → world-space polygon array
 *   MapEditor.Tracing.rdpSimplify(points, epsilon)  → simplified points
 *
 * A "polygon" is Array<{x:number, y:number}> in world space.
 * The return value is Array<polygon>.
 */

(function (MapEditor) {
  'use strict';

  // ── Marching-squares edge lookup table ────────────────────────────────────
  //
  // Bit layout for each 2×2 cell (corners at integer grid positions):
  //   bit 3 (8) = TL top-left
  //   bit 2 (4) = TR top-right
  //   bit 1 (2) = BR bottom-right
  //   bit 0 (1) = BL bottom-left
  //
  // Contour edges crossing the cell are encoded as pairs [e1, e2]:
  //   0 = T (top edge midpoint)
  //   1 = R (right edge midpoint)
  //   2 = B (bottom edge midpoint)
  //   3 = L (left edge midpoint)
  //
  // For ambiguous cases (5, 10) we pick one resolution and stay consistent.
  // The alternative resolution is equivalent for filled blobs.

  const MS_TABLE = [
    [],              // 0  : 0000 — all outside
    [[3, 2]],        // 1  : 0001 — BL
    [[2, 1]],        // 2  : 0010 — BR
    [[3, 1]],        // 3  : 0011 — BL+BR
    [[0, 1]],        // 4  : 0100 — TR
    [[0, 3], [2, 1]],// 5  : 0101 — TR+BL  (ambiguous: T→L and B→R)
    [[0, 2]],        // 6  : 0110 — TR+BR
    [[0, 3]],        // 7  : 0111 — TR+BR+BL  (only TL outside)
    [[0, 3]],        // 8  : 1000 — TL
    [[0, 2]],        // 9  : 1001 — TL+BL
    [[0, 1], [3, 2]],// 10 : 1010 — TL+BR  (ambiguous: T→R and L→B)
    [[0, 1]],        // 11 : 1011 — TL+BR+BL  (only TR outside)
    [[3, 1]],        // 12 : 1100 — TL+TR
    [[1, 2]],        // 13 : 1101 — TL+TR+BL  (only BR outside)
    [[3, 2]],        // 14 : 1110 — TL+TR+BR  (only BL outside)
    [],              // 15 : 1111 — all inside
  ];

  // Edge midpoint offsets within a cell (in pixel units relative to TL corner)
  //   T: (0.5, 0)   R: (1, 0.5)   B: (0.5, 1)   L: (0, 0.5)
  const EDGE_DX = [0.5, 1,   0.5, 0  ];
  const EDGE_DY = [0,   0.5, 1,   0.5];

  // ── Public entry point ────────────────────────────────────────────────────

  /**
   * Trace the alpha channel of `canvas` into world-space polygons.
   *
   * Only the bounding box of non-transparent pixels is processed,
   * for performance on large canvases with small trails.
   *
   * @param {HTMLCanvasElement}  canvas
   * @param {MapEditor.Viewport} viewport
   * @returns {Array<Array<{x:number,y:number}>>}  — world-space polygons
   */
  function traceCanvas(canvas, viewport) {
    const ctx  = canvas.getContext('2d');
    const W    = canvas.width;
    const H    = canvas.height;
    const idat = ctx.getImageData(0, 0, W, H);

    // Find bounding box of non-transparent pixels.
    const bb = _alphaBBox(idat.data, W, H);
    if (!bb) return [];    // nothing drawn

    // Add 1-pixel padding so marching squares captures the full boundary.
    const x0 = Math.max(0,   bb.x0 - 1);
    const y0 = Math.max(0,   bb.y0 - 1);
    const x1 = Math.min(W - 1, bb.x1 + 1);
    const y1 = Math.min(H - 1, bb.y1 + 1);

    const rw = x1 - x0 + 1;   // region width  (pixel cols)
    const rh = y1 - y0 + 1;   // region height (pixel rows)

    // Build binary grid for the region.
    const { TRACE_ALPHA_THRESHOLD } = MapEditor.Config;
    const grid = new Uint8Array(rw * rh);
    for (let ry = 0; ry < rh; ry++) {
      for (let rx = 0; rx < rw; rx++) {
        const px = x0 + rx, py = y0 + ry;
        grid[ry * rw + rx] =
          idat.data[(py * W + px) * 4 + 3] > TRACE_ALPHA_THRESHOLD ? 1 : 0;
      }
    }

    // Run marching squares on the binary grid.
    const screenPolys = _marchingSquares(grid, rw, rh, x0, y0);
    if (screenPolys.length === 0) return [];

    // Simplify and convert to world space.
    const { TRACE_RDP_EPSILON } = MapEditor.Config;
    const worldPolys = [];
    for (const poly of screenPolys) {
      if (poly.length < 3) continue;

      // RDP simplification in screen space first (epsilon = 1.2 px).
      const simplified = rdpSimplify(poly, 1.2);
      if (simplified.length < 3) continue;

      // Convert screen → world.
      const worldPoly = simplified.map(p => viewport.screenToWorld(p.x, p.y));

      // RDP again in world space at the configured epsilon.
      const worldSimp = rdpSimplify(worldPoly, TRACE_RDP_EPSILON);
      if (worldSimp.length >= 3) worldPolys.push(worldSimp);
    }

    return worldPolys;
  }

  // ── Ramer–Douglas–Peucker ─────────────────────────────────────────────────

  /**
   * Simplify a polygon/polyline using RDP.
   * Works with both {x,y} and {x,y} point objects.
   *
   * @param {Array<{x:number,y:number}>} pts
   * @param {number}                     epsilon  — max perpendicular deviation
   * @returns {Array<{x:number,y:number}>}
   */
  function rdpSimplify(pts, epsilon) {
    if (pts.length <= 2) return pts.slice();
    return _rdp(pts, 0, pts.length - 1, epsilon);
  }

  function _rdp(pts, lo, hi, eps) {
    if (hi - lo < 2) return [pts[lo], pts[hi]];

    let maxD = 0, maxI = lo;
    const ax = pts[lo].x, ay = pts[lo].y;
    const bx = pts[hi].x, by = pts[hi].y;
    const dx = bx - ax, dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);

    for (let i = lo + 1; i < hi; i++) {
      const d = len < 1e-12
        ? Math.hypot(pts[i].x - ax, pts[i].y - ay)
        : Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }

    if (maxD <= eps) return [pts[lo], pts[hi]];

    const left  = _rdp(pts, lo,   maxI, eps);
    const right = _rdp(pts, maxI, hi,   eps);
    return [...left.slice(0, -1), ...right];
  }

  // ── Marching squares ──────────────────────────────────────────────────────

  /**
   * Run marching squares on a binary grid.
   *
   * @param {Uint8Array} grid   — 1=inside, 0=outside, row-major, rw×rh
   * @param {number}     rw    — grid width  (pixel cols)
   * @param {number}     rh    — grid height (pixel rows)
   * @param {number}     offX  — pixel offset of grid origin (for absolute coords)
   * @param {number}     offY
   * @returns {Array<Array<{x:number,y:number}>>}  — screen-pixel polygons
   */
  function _marchingSquares(grid, rw, rh, offX, offY) {
    // Collect all segments: [[{x,y},{x,y}], ...]
    const segments = [];

    for (let row = 0; row < rh - 1; row++) {
      for (let col = 0; col < rw - 1; col++) {
        const tl = grid[ row      * rw + col    ];
        const tr = grid[ row      * rw + col + 1];
        const br = grid[(row + 1) * rw + col + 1];
        const bl = grid[(row + 1) * rw + col    ];

        const msCase = (tl << 3) | (tr << 2) | (br << 1) | bl;
        const pairs  = MS_TABLE[msCase];
        if (!pairs.length) continue;

        for (const [e1, e2] of pairs) {
          segments.push([
            {
              x: offX + col + EDGE_DX[e1],
              y: offY + row + EDGE_DY[e1],
            },
            {
              x: offX + col + EDGE_DX[e2],
              y: offY + row + EDGE_DY[e2],
            },
          ]);
        }
      }
    }

    return _stitchSegments(segments);
  }

  // ── Segment stitching ─────────────────────────────────────────────────────

  /**
   * Connect an unordered list of line segments into closed polygons.
   *
   * In well-formed MS output on a closed blob, every point appears in exactly
   * two segments (degree 2), forming clean closed loops.  We handle open chains
   * too (blob touches the canvas edge) by treating them as closed polygons.
   *
   * Point keys use ×2 integer encoding to avoid float-comparison noise:
   *   key(p) = `${round(p.x*2)}_${round(p.y*2)}`
   * This is exact for our half-integer edge midpoints.
   */
  function _stitchSegments(segments) {
    if (segments.length === 0) return [];

    const n    = segments.length;
    const used = new Uint8Array(n);

    // Build point → [segment index] map.
    const pk      = (p) => `${Math.round(p.x * 2)}_${Math.round(p.y * 2)}`;
    const ptSegs  = new Map();   // key → [seg index, ...]
    const ptCoord = new Map();   // key → {x,y}

    for (let i = 0; i < n; i++) {
      for (const pt of segments[i]) {
        const k = pk(pt);
        if (!ptSegs.has(k))  ptSegs.set(k, []);
        if (!ptCoord.has(k)) ptCoord.set(k, pt);
        ptSegs.get(k).push(i);
      }
    }

    const polygons = [];

    for (let si = 0; si < n; si++) {
      if (used[si]) continue;

      const poly    = [];
      let   segIdx  = si;
      let   curKey  = pk(segments[si][0]);

      // Trace until we can't continue or close the loop.
      for (let guard = 0; guard < n * 2; guard++) {
        if (used[segIdx]) break;
        used[segIdx] = 1;

        const [a, b] = segments[segIdx];
        const aKey   = pk(a);
        const nextPt = aKey === curKey ? b : a;
        const nextKey = pk(nextPt);

        poly.push(ptCoord.get(curKey) || a);

        // Closed loop?
        if (poly.length >= 3 && nextKey === pk(segments[si][0])) break;

        // Find next unused segment from nextKey.
        const candidates = ptSegs.get(nextKey) || [];
        let nextSeg = -1;
        for (const idx of candidates) {
          if (!used[idx]) { nextSeg = idx; break; }
        }

        if (nextSeg === -1) {
          // Open chain — cap it.
          poly.push(nextPt);
          break;
        }

        curKey = nextKey;
        segIdx = nextSeg;
      }

      if (poly.length >= 3) polygons.push(poly);
    }

    return polygons;
  }

  // ── Bounding box helper ───────────────────────────────────────────────────

  /**
   * Find the axis-aligned bounding box of all non-transparent pixels.
   * Returns null if the image is entirely transparent.
   */
  function _alphaBBox(data, W, H) {
    const { TRACE_ALPHA_THRESHOLD } = MapEditor.Config;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] > TRACE_ALPHA_THRESHOLD) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }

    return (x1 >= 0) ? { x0, y0, x1, y1 } : null;
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.Tracing = { traceCanvas, rdpSimplify };

})(window.MapEditor = window.MapEditor || {});
