# Fun Map Editor — Agents Guide

This document describes the architecture, conventions, and algorithms for AI-agent
or human contributors developing this project. Read it before touching code.

---

## What This App Does

A standalone browser-based vector graphics editor for drawing fun fantasy/political maps.
Users paint regions (countries, empires, …) on top of a static world base-map. Painted
regions auto-expand to fill available space like ink bleeding across paper.

No back-end, no build step. Opens directly from `file://` in any modern browser.

---

## File Map

```
index.html          — Entry point, loads all scripts in dependency order
style.css           — Minimal full-screen layout
world-data.js       — Embedded simplified world SVG path strings (swap for hi-res)
lib/
  clipper.js        — Clipper.js polygon boolean ops (download from CDN if missing)
src/
  config.js         — ALL magic numbers live here. Tune behavior here, nowhere else.
  viewport.js       — Pan / zoom / coordinate transforms (world ↔ screen)
  colorUtils.js     — OKLab perceptual color distance; pick maximally different color
  undoStack.js      — Undo/redo history (deep-clone snapshots of userObjects state)
  worldmap.js       — Load & parse static SVG paths; paint them onto canvas
  userObjects.js    — UserObject / Shape data model; Clipper polygon ↔ SVG path
  rasterOps.js      — Off-screen canvas: draw disk trail, build boundary mask, dilate
  tracing.js        — Marching-squares raster → polygon contours
  pathOps.js        — Thin Clipper.js wrapper: union, difference, simplify
  drawTool.js       — Left-button draw tool; time-driven disk-size profile
  expansion.js      — Animated morphological expansion loop (post-draw)
  titleRenderer.js  — Fit title text inside/outside object visible bounds
  renderer.js       — Main render loop; composites all layers onto display canvas
  storage.js        — Save / load SVG with custom `data-mapeditor-*` attributes
  ui.js             — Toolbar, color picker, title-edit input, keyboard shortcuts
  main.js           — App init; wires all modules together
```

---

## Global Namespace

All modules attach to `window.MapEditor`.  Every file is wrapped in:

```js
(function(MapEditor) {
  'use strict';
  // … code …
  MapEditor.MyThing = …;
})(window.MapEditor = window.MapEditor || {});
```

Modules may read from sibling modules that were loaded earlier (per `index.html` order).
They must **not** `require()` each other — loading order in `index.html` IS the dependency
graph.  Keep it acyclic: a module may only call modules listed above it in `index.html`.

---

## Coordinate Systems

### World space
Equirectangular projection, origin top-left:
- x ∈ [0, 1000]  →  longitude ∈ [−180°, 180°]
- y ∈ [0,  500]  →  latitude  ∈ [  90°, −90°]

Conversions:
```
worldX = (lon  + 180) * (1000 / 360)
worldY = (90 − lat)   * ( 500 / 180)
```

### Screen space
Canvas pixels, origin top-left.

### Viewport transform (see `src/viewport.js`)
```
screenX = (worldX − vp.panX) * vp.zoom + canvas.width  / 2
screenY = (worldY − vp.panY) * vp.zoom + canvas.height / 2
```
`vp.panX/panY` is the **world coordinate at the canvas center**.

### Clipper space (integers)
Clipper.js requires integer coordinates.  We use a scale factor of 1000 to preserve
sub-unit precision:
```
clipperX = Math.round(worldX * 1000)
clipperY = Math.round(worldY * 1000)
```
`pathOps.js` wraps all conversions so callers deal only in world-space floats.

---

## Data Model

### StaticPath  (in `worldmap.js`)
```js
{
  id:          string,       // unique, e.g. 'sp_0042'
  d:           string,       // original SVG path data string
  path2D:      Path2D,       // cached Path2D for canvas hit-test & fill
  fill:        string,       // CSS color or 'none'
  stroke:      string,       // CSS color or 'none'
  type:        'land'        // | 'river' | 'mountain' (mountains slow expansion)
                             // future: more types
}
```

### Shape  (one polygon island within a UserObject)
```js
{
  id:              string,
  clipperPolygons: Array<Array<{X:int, Y:int}>>,  // Clipper integer coords (×1000)
  svgPath:         string,                         // cached SVG 'd' attribute
  bounds:          {x, y, x2, y2, w, h}           // world-space bounding box
}
```

### UserObject
```js
{
  id:          string,       // e.g. 'obj_1'
  shapes:      Shape[],
  color:       string,       // '#rrggbb'
  title:       string,
  lastEdited:  number        // Date.now() — most recently edited = gets priority
}
```

### App state snapshot  (what UndoStack stores)
```js
{
  userObjects: UserObject[]  // deep-cloned; all fields JSON-serialisable
}
```

---

## Render Pipeline  (`renderer.js`)

Each animation frame:
1. **Clear** canvas to ocean color
2. **Static fills** — draw landmass fills (Path2D, world-space transform)
3. **User object fills** — sorted by area (largest first) so small objects paint on top
4. **Static strokes** — constant visible width: `ctx.lineWidth = STATIC_STROKE_WIDTH_PX / vp.zoom`
5. **User object borders** (optional, thin)
6. **Active expansion overlay** — semi-transparent live raster from `expansion.js`
7. **Active draw trail** — live disk trail from `drawTool.js`
8. **Titles** — from `titleRenderer.js`
9. **UI elements** — cursor, hover highlights

---

## Draw Tool  (`drawTool.js`)

**Left button = add, Right button = erase.**

On `mousedown`:
- Record `startTime = Date.now()`
- Determine target object (hit-test all UserObject shapes at click world pos)
  - Left+empty space → create new UserObject (new color) unless Shift held
  - Shift+left+empty → add shape to `lastEditedObject`
  - Left on existing object → add to that object
  - Right on existing object → erase from that object

On `mousemove` (button held):
- Compute disk radius: `r_screen = diskProfile(elapsed)`
- Emit disk at current pos if distance from last disk > `TRAIL_DENSITY * r_screen`
- Draw disk to `rasterOps.trailCanvas` in screen space (filled circle, white)

Disk size profile (time-driven, `t` = seconds since mousedown):
```
grow phase  (t < PROFILE_GROW_TIME):
  r = lerp(DISK_RADIUS_MIN, DISK_RADIUS_MAX, t / PROFILE_GROW_TIME)

taper phase (t ≥ PROFILE_GROW_TIME):
  t2 = t − PROFILE_GROW_TIME
  r  = lerp(DISK_RADIUS_MAX, DISK_RADIUS_MIN, min(1, t2 / PROFILE_TAPER_TIME))
```

On `mouseup`:
- Snapshot current state → `undoStack.push()`
- Hand `trailCanvas` + target object + mode (add/erase) to `expansion.js`
- Clear `trailCanvas`

---

## Expansion Engine  (`expansion.js`)

Morphological dilation / erosion, animated, screen-space.

### Setup (once per draw gesture)
1. Render current UserObject to `objectCanvas` (screen-space raster, white = inside)
2. Render all *other* UserObjects + static paths to `boundaryCanvas` (white = blocked)
3. Compute signed-distance-from-edge for each white pixel in `trailCanvas` relative
   to `objectCanvas` edge  →  `edgeDistCanvas`
   - Inside the existing object: distance = 0 (no expansion from here)
   - At edge: distance = 1 (max expansion speed)
   - Away from object: linearly tapers to 0 at trail tip
4. Union `trailCanvas` with `objectCanvas` → `frontierCanvas` (starting state)

### Per-frame  (`rAF` loop)
```
speed(t) = EXPANSION_INIT_SPEED_PX * exp(−EXPANSION_DECAY_RATE * t)
pixelsToAdvance = speed(t) * frameDeltaSeconds
```
Run a BFS-style frontier expansion:
- For each frontier pixel, expand outward by `pixelsToAdvance * edgeWeight(pixel)`
  where `edgeWeight` comes from the precomputed `edgeDistCanvas`
- Mark any pixel that is already white in `boundaryCanvas` as blocked (stop there)
- Clip to visible canvas rect

Stop when `speed(t) < EXPANSION_STOP_THRESHOLD` or space key pressed.

### Finalise
1. Trace `frontierCanvas` → polygon contours (`tracing.js`)
2. Convert contours to Clipper polygons
3. If mode=add:    `newShape = union(existingShapes, newContours)`
4. If mode=erase:  `newShapes = difference(existingShapes, newContours)`
5. Also subtract from *all overlapping UserObjects* (mode=add encroaches on neighbours)
6. Update UserObject, trigger re-render

### Erase decay  (preventing overlap)
`EXPANSION_ERASE_PENALTY` multiplies the decay rate for erase operations so that
erasing always decays faster than the corresponding add — ensuring object A never
overlaps object B when drawing A→B.

### Mountain slow-down (TODO in v2)
Static paths with `type='mountain'` will add a resistance factor (e.g. 0.3) to
`boundaryCanvas` rather than a hard stop.  The frontier slows but is not stopped.

---

## Tracing  (`tracing.js`)

Marching-squares algorithm on the expansion raster:
- Threshold: pixel alpha > 128 → inside
- Output: array of polygon contours in screen-space pixel coords
- Converted to world coords via `viewport.screenToWorld()`
- Simplified with Ramer–Douglas–Peucker (ε = 0.3 world units)

---

## Boolean Operations  (`pathOps.js`)

Thin wrapper around Clipper.js:
- All inputs/outputs in world-space float coordinates
- Internally scaled by `CLIPPER_SCALE = 1000` for integer precision
- Operations: `union(polysA, polysB)`, `difference(polysA, polysB)`, `simplify(polys)`
- Results cached as SVG `d` strings on Shape objects

---

## Titles  (`titleRenderer.js`)

1. Find **visible bounding box** of the shape on screen (intersect shape bbox with canvas)
2. Fit title text to box: binary-search font size between `TITLE_MIN_FONT_PX` and `TITLE_MAX_FONT_PX`
3. If at min size and text still too wide: render title to the **right** of the object
   (scan rightward from object edge, find first unoccupied column, or hide)
4. Render with white text shadow for legibility on all map colours
5. Double-click to edit: show absolutely-positioned `<input>` over the title

---

## Storage  (`storage.js`)

### Save
Build an SVG document:
- `<svg viewBox="0 0 1000 500" xmlns:me="urn:map-editor">` 
- Static paths copied verbatim from loaded world SVG as `<g id="static">`
- UserObjects as `<g id="objects">`:  each UserObject → `<g>` with attributes
  `me:id`, `me:color`, `me:title`; each Shape → `<path d="…" />`
- Save via `<a download>` blob URL

### Load
- Parse SVG, split into `#static` and `#objects` groups
- Reconstruct UserObject / Shape data model
- Rebuild Clipper polygons from SVG path data (via `pathOps.svgPathToPolygons()`)

---

## Conventions

- **All magic numbers** in `src/config.js`.  Search for bare numbers before adding one.
- **No `console.log` in committed code** — use `MapEditor.debug(msg)` (no-op in production).
- **Prefer `const`** for module-level values; `let` only where mutation is needed.
- **Name booleans** with `is`/`has`/`can` prefix (`isErasing`, `hasSelection`).
- **IDs** are generated by `MapEditor.nextId('prefix')` — a monotonic counter.
- **Canvas state** — always `ctx.save()` / `ctx.restore()` around any transform changes.
- **Hit-testing** — use `ctx.isPointInPath(path2D, sx, sy)` with screen coords.
- **No globals beyond `window.MapEditor`** — never add anything else to `window`.
- **TODO / FIXME comments**: tag with your initials and the date, e.g. `// TODO(agent) 2025: …`

---

## Known Limitations & Future Work

- Mountain slow-down not yet implemented (see expansion section above)
- `pathOps` can be slow for objects with thousands of vertices — add simplification pass
- Titles can overlap if many small objects are adjacent; needs collision avoidance
- No touch / stylus support yet
- Redo is cleared on draw — full redo stack is a future enhancement
- The static world SVG is simplified; replace `world-data.js` for higher fidelity
