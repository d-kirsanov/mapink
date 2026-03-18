/**
 * src/worldmap.js
 *
 * Loads world-data.svg and converts its paths into StaticPath objects
 * that the renderer can draw efficiently.
 *
 * Expected SVG conventions (you can use any standard world SVG):
 *   - Paths/polygons represent landmasses, lakes, rivers, etc.
 *   - fill / stroke taken from inline style or presentation attributes.
 *   - Paths with class or id containing "river" get type='river'.
 *   - Paths with class or id containing "mountain" get type='mountain'.
 *   - Everything else gets type='land'.
 *
 * The SVG's own viewBox is used to map coordinates into world space
 * (Config.WORLD_WIDTH × Config.WORLD_HEIGHT).  If the SVG has no viewBox
 * the raw coordinates are used as-is.
 *
 * StaticPath shape:
 * {
 *   id:      string,    — unique, e.g. 'sp_0042'
 *   d:       string,    — SVG path data ('d' attribute)
 *   path2D:  Path2D,    — pre-built Path2D for fast canvas rendering
 *   fill:    string,    — CSS colour or 'none'
 *   stroke:  string,    — CSS colour or 'none'
 *   type:    'land'|'river'|'mountain'
 * }
 *
 * After load, the module exposes:
 *   MapEditor.WorldMap.paths       — StaticPath[]
 *   MapEditor.WorldMap.svgViewBox  — {x, y, width, height} of source SVG
 *   MapEditor.WorldMap.transform   — DOMMatrix mapping SVG coords → world coords
 *   MapEditor.WorldMap.isLoaded    — boolean
 */

(function (MapEditor) {
  'use strict';

  const { WORLD_WIDTH, WORLD_HEIGHT, ID_STATIC_PREFIX } = MapEditor.Config;

  // ── Public state ────────────────────────────────────────────────────────

  const WorldMap = {
    paths:      [],
    svgViewBox: { x: 0, y: 0, width: WORLD_WIDTH, height: WORLD_HEIGHT },
    transform:  new DOMMatrix(),   // updated after load
    isLoaded:   false,
  };

  // ── Load entry point ────────────────────────────────────────────────────

  /**
   * Fetch and parse world-data.svg, then build StaticPath objects.
   * Returns a Promise that resolves when the map is ready to render.
   *
   * @param {string} [url='world-data.svg']
   * @returns {Promise<void>}
   */

WorldMap.load = async function () {
    try {
        if (typeof worldSvgString === 'undefined') {
            throw new Error("SVG string not found");
        }  
  
      const parser  = new DOMParser();
      const svgDoc  = parser.parseFromString(worldSvgString, 'image/svg+xml');
      const svgRoot = svgDoc.documentElement;

      // ── Parse viewBox ──────────────────────────────────────────────────────
      const vb = _parseViewBox(svgRoot);
      WorldMap.svgViewBox = vb;

      // Build a DOMMatrix that maps SVG coordinates → world coordinates.
      // SVG viewBox (vb.x, vb.y, vb.width, vb.height) → (0, 0, WORLD_WIDTH, WORLD_HEIGHT)
      const scaleX = WORLD_WIDTH  / vb.width;
      const scaleY = WORLD_HEIGHT / vb.height;
      WorldMap.transform = new DOMMatrix([
        scaleX, 0,
        0,      scaleY,
        -vb.x * scaleX,
        -vb.y * scaleY,
      ]);

      // ── Collect all drawable elements ──────────────────────────────────────
      const elements = svgRoot.querySelectorAll('path, polygon, polyline, rect, circle, ellipse');
      WorldMap.paths = [];

      let idCounter = 0;
      for (const el of elements) {
        const d = _elementToPathData(el, svgRoot);
        if (!d) continue;

        const fill   = _resolveColor(el, 'fill',   svgRoot) || 'none';
        const stroke = _resolveColor(el, 'stroke', svgRoot) || 'none';

        // Skip elements that are invisible (no fill, no stroke, or display:none)
        const display = _resolveStyle(el, 'display');
        const vis     = _resolveStyle(el, 'visibility');
        if (display === 'none' || vis === 'hidden') continue;
        if (fill === 'none' && stroke === 'none') continue;

        const type = _classifyElement(el);

        // Transform the path data from SVG coords to world coords.
        // We do this by building a scaled version of the 'd' string so the
        // Path2D + canvas transform system just works with world coordinates.
        const worldD = _transformPathData(d, WorldMap.transform);

        WorldMap.paths.push({
          id:     ID_STATIC_PREFIX + '_' + (++idCounter),
          d:      worldD,
          path2D: new Path2D(worldD),
          fill,
          stroke,
          type,
        });
      }

    } catch (err) {
      console.error('[WorldMap] Failed to load', err);
      // Provide a minimal fallback so the app still runs without a world map
      WorldMap.paths   = [];
      WorldMap.isLoaded = true;
      return;
    }


    WorldMap.isLoaded = true;
    MapEditor.debug(`WorldMap: loaded ${WorldMap.paths.length} static paths from ${url}`);
  };

  // ── Hit-testing ─────────────────────────────────────────────────────────

  /**
   * Return true if world-space point (wx, wy) falls inside any land path.
   * Used by the expansion engine to detect static-path boundaries.
   *
   * NOTE: Requires a scratch canvas context because isPointInPath works in
   * screen space when the context has a transform applied.  We pass the
   * context and the active viewport so we can use the current transform.
   *
   * @param {CanvasRenderingContext2D} ctx  — with viewport transform applied
   * @param {number} sx  — screen x
   * @param {number} sy  — screen y
   * @returns {boolean}
   */
  WorldMap.isPointInAnyPath = function (ctx, sx, sy) {
    for (const sp of WorldMap.paths) {
      if (sp.fill !== 'none' && ctx.isPointInPath(sp.path2D, sx, sy)) return true;
      if (sp.stroke !== 'none' && ctx.isPointInStroke(sp.path2D, sx, sy)) return true;
    }
    return false;
  };

  // ── Rendering ───────────────────────────────────────────────────────────

  /**
   * Draw all static path fills onto ctx.
   * Caller must apply the viewport transform first.
   *
   * @param {CanvasRenderingContext2D} ctx
   */
  WorldMap.drawFills = function (ctx) {
    for (const sp of WorldMap.paths) {
      if (sp.fill === 'none') continue;
      ctx.fillStyle = sp.fill;
      ctx.fill(sp.path2D);
    }
  };

  /**
   * Draw all static path strokes onto ctx at a constant *screen* width.
   * This must be called with the viewport transform still active; we
   * compensate by dividing the desired screen width by the zoom level.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {MapEditor.Viewport} viewport
   */
  WorldMap.drawStrokes = function (ctx, viewport) {
    const { STATIC_STROKE_WIDTH_PX } = MapEditor.Config;
    ctx.lineWidth = viewport.screenPxToWorld(STATIC_STROKE_WIDTH_PX);
    ctx.lineCap   = 'round';
    ctx.lineJoin  = 'round';

    for (const sp of WorldMap.paths) {
      if (sp.stroke === 'none') continue;
      ctx.strokeStyle = sp.stroke;
      ctx.stroke(sp.path2D);
    }
  };

  // ── Internal helpers ────────────────────────────────────────────────────

  /**
   * Parse the viewBox attribute of the SVG root, falling back to
   * width/height attributes or the world dimensions.
   */
  function _parseViewBox(svgRoot) {
    const vbAttr = svgRoot.getAttribute('viewBox');
    if (vbAttr) {
      const parts = vbAttr.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every(isFinite)) {
        return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
      }
    }
    // Fall back to width/height attributes
    const w = parseFloat(svgRoot.getAttribute('width'))  || WORLD_WIDTH;
    const h = parseFloat(svgRoot.getAttribute('height')) || WORLD_HEIGHT;
    return { x: 0, y: 0, width: w, height: h };
  }

  /**
   * Convert any SVG drawable element to an SVG path 'd' string.
   * Returns null for unsupported element types.
   *
   * @param {SVGElement} el
   * @returns {string|null}
   */
  function _elementToPathData(el, svgRoot) {
    const tag = el.tagName.toLowerCase();

    switch (tag) {
      case 'path':
        return el.getAttribute('d') || null;

      case 'polygon':
      case 'polyline': {
        const pts = el.getAttribute('points');
        if (!pts) return null;
        const coords = pts.trim().split(/[\s,]+/).map(Number);
        if (coords.length < 4) return null;
        let d = `M ${coords[0]} ${coords[1]}`;
        for (let i = 2; i < coords.length; i += 2) {
          d += ` L ${coords[i]} ${coords[i + 1]}`;
        }
        if (tag === 'polygon') d += ' Z';
        return d;
      }

      case 'rect': {
        const x  = parseFloat(el.getAttribute('x'))  || 0;
        const y  = parseFloat(el.getAttribute('y'))  || 0;
        const w  = parseFloat(el.getAttribute('width'));
        const h  = parseFloat(el.getAttribute('height'));
        const rx = parseFloat(el.getAttribute('rx')) || 0;
        const ry = parseFloat(el.getAttribute('ry')) || rx;
        if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
        if (rx === 0 && ry === 0) {
          return `M ${x} ${y} H ${x+w} V ${y+h} H ${x} Z`;
        }
        // Rounded rect
        return `M ${x+rx} ${y}` +
          ` H ${x+w-rx} A ${rx} ${ry} 0 0 1 ${x+w} ${y+ry}` +
          ` V ${y+h-ry} A ${rx} ${ry} 0 0 1 ${x+w-rx} ${y+h}` +
          ` H ${x+rx}   A ${rx} ${ry} 0 0 1 ${x} ${y+h-ry}` +
          ` V ${y+ry}   A ${rx} ${ry} 0 0 1 ${x+rx} ${y} Z`;
      }

      case 'circle': {
        const cx = parseFloat(el.getAttribute('cx')) || 0;
        const cy = parseFloat(el.getAttribute('cy')) || 0;
        const r  = parseFloat(el.getAttribute('r'));
        if (!isFinite(r) || r <= 0) return null;
        // SVG arc approximation of a full circle
        return `M ${cx-r} ${cy}` +
          ` A ${r} ${r} 0 1 0 ${cx+r} ${cy}` +
          ` A ${r} ${r} 0 1 0 ${cx-r} ${cy} Z`;
      }

      case 'ellipse': {
        const cx = parseFloat(el.getAttribute('cx')) || 0;
        const cy = parseFloat(el.getAttribute('cy')) || 0;
        const rx = parseFloat(el.getAttribute('rx'));
        const ry = parseFloat(el.getAttribute('ry'));
        if (!isFinite(rx) || !isFinite(ry) || rx <= 0 || ry <= 0) return null;
        return `M ${cx-rx} ${cy}` +
          ` A ${rx} ${ry} 0 1 0 ${cx+rx} ${cy}` +
          ` A ${rx} ${ry} 0 1 0 ${cx-rx} ${cy} Z`;
      }

      default:
        return null;
    }
  }

  /**
   * Resolve a presentation attribute (fill, stroke, …) for an element,
   * walking up the group hierarchy for inherited values.
   *
   * Priority: inline style > presentation attribute > parent attribute.
   *
   * @param {SVGElement} el
   * @param {string}     prop   CSS property name ('fill' / 'stroke')
   * @param {SVGElement} svgRoot
   * @returns {string|null}
   */
  function _resolveColor(el, prop, svgRoot) {
    // 1. Inline style
    const style = el.style && el.style[prop];
    if (style && style !== 'inherit') return style;

    // 2. Presentation attribute
    const attr = el.getAttribute(prop);
    if (attr && attr !== 'inherit') return attr;

    // 3. Walk up to parent groups
    let parent = el.parentElement;
    while (parent && parent !== svgRoot) {
      const ps = parent.style && parent.style[prop];
      if (ps && ps !== 'inherit') return ps;
      const pa = parent.getAttribute(prop);
      if (pa && pa !== 'inherit') return pa;
      parent = parent.parentElement;
    }

    return null;
  }

  /**
   * Resolve a CSS style property (display, visibility) for an element.
   */
  function _resolveStyle(el, prop) {
    if (el.style && el.style[prop]) return el.style[prop];
    return el.getAttribute(prop) || '';
  }

  /**
   * Classify a path element as 'land', 'river', or 'mountain'
   * based on id/class attributes.
   */
  function _classifyElement(el) {
    const id    = (el.getAttribute('id')    || '').toLowerCase();
    const cls   = (el.getAttribute('class') || '').toLowerCase();
    const combined = id + ' ' + cls;

    if (/river|stream|lake|water/.test(combined)) return 'river';
    if (/mountain|peak|highland|range/.test(combined)) return 'mountain';
    return 'land';
  }

  // ── Path data coordinate transform ─────────────────────────────────────

  /**
   * Apply a DOMMatrix transform to every coordinate pair in an SVG path 'd' string.
   *
   * This is a lightweight parser that handles the most common commands:
   *   M m L l H h V v C c S s Q q T t A a Z z
   *
   * Relative commands (lowercase) are converted to absolute first so the
   * matrix can be applied uniformly.
   *
   * For maximum compatibility we output absolute commands only.
   *
   * @param {string}    d    SVG path data
   * @param {DOMMatrix} mat  Transform matrix
   * @returns {string}       Transformed SVG path data
   */
  function _transformPathData(d, mat) {
    if (!d) return '';

    // Fast-path: if the matrix is identity, skip transform.
    if (mat.a === 1 && mat.b === 0 && mat.c === 0 && mat.d === 1 &&
        mat.e === 0 && mat.f === 0) {
      return d;
    }

    const out   = [];
    let cx = 0, cy = 0;   // current point (absolute)
    let sx = 0, sy = 0;   // subpath start (for Z relative)

    // Tokenise: split into command-char + number sequences.
    const tokens = d.match(/[MmZzLlHhVvCcSsQqTtAa]|[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/g);
    if (!tokens) return '';

    let i = 0;
    let cmd = '';

    // Helper: read next number from tokens
    const num = () => parseFloat(tokens[i++]);

    // Helper: transform a point through the matrix
    const tx = (x, y) => {
      const px = mat.a * x + mat.c * y + mat.e;
      const py = mat.b * x + mat.d * y + mat.f;
      return [px, py];
    };
    // Transform scale factor for radii (assumes uniform scale)
    const scaleX = Math.sqrt(mat.a * mat.a + mat.b * mat.b);
    const scaleY = Math.sqrt(mat.c * mat.c + mat.d * mat.d);

    const _f = (v) => +v.toFixed(4);

    while (i < tokens.length) {
      if (/[MmZzLlHhVvCcSsQqTtAa]/.test(tokens[i])) {
        cmd = tokens[i++];
      }

      switch (cmd) {
        case 'M': case 'm': {
          let x = num(), y = num();
          if (cmd === 'm') { x += cx; y += cy; }
          [cx, cy] = [x, y];
          [sx, sy] = [cx, cy];
          const [px, py] = tx(cx, cy);
          out.push(`M ${_f(px)} ${_f(py)}`);
          // Subsequent coord pairs after M are implicit L
          cmd = cmd === 'M' ? 'L' : 'l';
          break;
        }
        case 'L': case 'l': {
          let x = num(), y = num();
          if (cmd === 'l') { x += cx; y += cy; }
          cx = x; cy = y;
          const [px, py] = tx(cx, cy);
          out.push(`L ${_f(px)} ${_f(py)}`);
          break;
        }
        case 'H': case 'h': {
          let x = num();
          if (cmd === 'h') x += cx;
          cx = x;
          const [px, py] = tx(cx, cy);
          out.push(`L ${_f(px)} ${_f(py)}`);
          break;
        }
        case 'V': case 'v': {
          let y = num();
          if (cmd === 'v') y += cy;
          cy = y;
          const [px, py] = tx(cx, cy);
          out.push(`L ${_f(px)} ${_f(py)}`);
          break;
        }
        case 'C': case 'c': {
          let x1 = num(), y1 = num();
          let x2 = num(), y2 = num();
          let x  = num(), y  = num();
          if (cmd === 'c') { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
          cx = x; cy = y;
          const [p1x, p1y] = tx(x1, y1);
          const [p2x, p2y] = tx(x2, y2);
          const [px,  py ] = tx(cx, cy);
          out.push(`C ${_f(p1x)} ${_f(p1y)} ${_f(p2x)} ${_f(p2y)} ${_f(px)} ${_f(py)}`);
          break;
        }
        case 'S': case 's': {
          let x2 = num(), y2 = num();
          let x  = num(), y  = num();
          if (cmd === 's') { x2 += cx; y2 += cy; x += cx; y += cy; }
          cx = x; cy = y;
          const [p2x, p2y] = tx(x2, y2);
          const [px,  py ] = tx(cx, cy);
          out.push(`S ${_f(p2x)} ${_f(p2y)} ${_f(px)} ${_f(py)}`);
          break;
        }
        case 'Q': case 'q': {
          let x1 = num(), y1 = num();
          let x  = num(), y  = num();
          if (cmd === 'q') { x1 += cx; y1 += cy; x += cx; y += cy; }
          cx = x; cy = y;
          const [p1x, p1y] = tx(x1, y1);
          const [px,  py ] = tx(cx, cy);
          out.push(`Q ${_f(p1x)} ${_f(p1y)} ${_f(px)} ${_f(py)}`);
          break;
        }
        case 'T': case 't': {
          let x = num(), y = num();
          if (cmd === 't') { x += cx; y += cy; }
          cx = x; cy = y;
          const [px, py] = tx(cx, cy);
          out.push(`T ${_f(px)} ${_f(py)}`);
          break;
        }
        case 'A': case 'a': {
          let rx = num(), ry = num();
          let xRot = num(), largeArc = num(), sweep = num();
          let x = num(), y = num();
          if (cmd === 'a') { x += cx; y += cy; }
          cx = x; cy = y;
          const [px, py] = tx(cx, cy);
          // Scale radii by matrix scale factors; rotation is ignored (no rotation support)
          out.push(`A ${_f(rx * scaleX)} ${_f(ry * scaleY)} ${_f(xRot)} ${largeArc} ${sweep} ${_f(px)} ${_f(py)}`);
          break;
        }
        case 'Z': case 'z': {
          cx = sx; cy = sy;
          out.push('Z');
          break;
        }
        default:
          // Unknown command — skip one token to avoid infinite loop
          i++;
      }
    }

    return out.join(' ');
  }

  // ── Export ──────────────────────────────────────────────────────────────

  MapEditor.WorldMap = WorldMap;

})(window.MapEditor = window.MapEditor || {});
