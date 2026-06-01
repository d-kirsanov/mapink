/**
 * src/config.js
 *
 * ALL magic numbers live here. Never scatter bare literals throughout the code.
 * Tune behaviour by changing values in this file only.
 *
 * The world coordinate system is equirectangular projection:
 *   x ∈ [0, WORLD_WIDTH]   →  longitude ∈ [−180°, +180°]
 *   y ∈ [0, WORLD_HEIGHT]  →  latitude  ∈ [+90°,  −90°]
 *
 * Conversion helpers:
 *   worldX = (lon  + 180) * (WORLD_WIDTH  / 360)
 *   worldY = (90 − lat)   * (WORLD_HEIGHT / 180)
 */

(function (MapEditor) {
  'use strict';

  MapEditor.Config = Object.freeze({

    // ── World dimensions ─────────────────────────────────────────────────────
    WORLD_WIDTH:  1000,   // coordinate units spanning longitude −180°..+180°
    WORLD_HEIGHT:  500,   // coordinate units spanning latitude  +90°..−90°

    // ── Zoom ─────────────────────────────────────────────────────────────────
    // Limits expressed as factors of the "fit-to-screen" zoom level,
    // so they are resolution-independent.
    ZOOM_FACTOR_MIN:  0.4,   // zoom out ≤ 2.5× the full world width
    ZOOM_FACTOR_MAX:  4000,  // zoom in enough to fill screen with Andorra (~25 km)
                             //   Andorra ≈ 0.6 world units wide →
                             //   max screen/world ratio ≈ 1920/0.6 ≈ 3200
                             //   factor ≈ 3200 / 1.92 ≈ 1667; 4000 gives headroom

    ZOOM_WHEEL_FACTOR: 1.12, // zoom multiplier per mouse-wheel tick

    // ── Draw tool — disk trail ───────────────────────────────────────────────
    // All sizes in *screen pixels* (constant regardless of zoom level).
    // All disks are the same size now; the triangle/tentacle shape emerges
    // naturally because the base of a stroke starts expanding earlier than the tip.
    DISK_RADIUS_MAX_PX: 12,  // radius of every disk

    // Trail density: one disk emitted per this many screen-pixels of movement.
    TRAIL_DENSITY_PX: 0.6,

    // ── Expansion ────────────────────────────────────────────────────────────
    // Initial frontier speed in *screen pixels per second*.
    EXPANSION_INIT_SPEED_PX: 80,

    // Exponential decay exponent (per second).
    // speed(t) = INIT_SPEED × exp(−DECAY × t)
    // The UI slider maps to this value at runtime (default matches slider default).
    EXPANSION_DECAY_DEFAULT: 1.5,

    // Expansion stops when speed falls below this threshold (screen px/s).
    EXPANSION_STOP_THRESHOLD_PX: 0.5,

    // Erase operations decay this much *faster* than add operations.
    EXPANSION_ERASE_PENALTY: 1.3,

    // Fraction of normal expansion speed when crossing into another user object.
    EXPANSION_RESISTANCE_FACTOR: 0.4,

    // ── Mountain resistance ───────────────────────────────────────────────────
    // Each mountain contour layer the frontier is inside multiplies the advance
    // rate by this factor.  0.55^1 ≈ 55%, 0.55^2 ≈ 30%, 0.55^3 ≈ 17% …
    // Tune upward (toward 1.0) to make mountains more permeable.
    MOUNTAIN_FACTOR_PER_LEVEL: 0.55,

    // ── River blocking ────────────────────────────────────────────────────────
    // Width (screen pixels) of the blocker strip painted over river strokes.
    // Keep this LESS than DISK_RADIUS_MAX_PX * 2 so a brush spanning both banks
    // still places seeds on each side, allowing expansion on both independently.
    RIVER_STROKE_BLOCK_PX: 3,

    // Width (screen pixels) for coastline/border blocker strips.
    COAST_STROKE_BLOCK_PX: 4,

    // ── Clipper.js integer scaling ────────────────────────────────────────────
    // World-space floats are multiplied by this before passing to Clipper.
    // 1000 gives sub-pixel precision at the world scale (0.001 world units).
    CLIPPER_SCALE: 1000,

    // ── Static paths ─────────────────────────────────────────────────────────
    // Stroke drawn at this constant width in *screen pixels*, regardless of zoom.
    STATIC_STROKE_WIDTH_PX: 1.5,

    // ── Titles ───────────────────────────────────────────────────────────────
    TITLE_FONT_FAMILY: '"Palatino Linotype", Palatino, "Book Antiqua", serif',
    TITLE_FONT_WEIGHT: '600',
    TITLE_MAX_FONT_PX: 52,
    TITLE_MIN_FONT_PX:  8,
    TITLE_PADDING_PX:   6,   // breathing room between text box and object edge
    // When title cannot fit inside the object, it is placed to the right.
    // This is the gap between the object edge and the external title.
    TITLE_EXTERNAL_GAP_PX: 4,
    // Minimum gap (screen px) between any two rendered title bounding boxes.
    TITLE_MIN_GAP_PX: 10,

    // ── Colors ───────────────────────────────────────────────────────────────
    OCEAN_COLOR:       '#1a4a7a',
    WORLD_BORDER_COLOR: 'rgba(0,0,0,0.35)',  // faint border around the world rect
    OBJECT_BORDER_ALPHA: 0.4,                // user-object outline opacity multiplier

    // ── Undo ─────────────────────────────────────────────────────────────────
    MAX_UNDO_STEPS: 50,

    // ── IDs ──────────────────────────────────────────────────────────────────
    // See MapEditor.nextId() in main.js.
    // Prefix strings for generated IDs:
    ID_OBJECT_PREFIX: 'obj',
    ID_SHAPE_PREFIX:  'shp',
    ID_STATIC_PREFIX: 'sp',

    // ── Raster work canvas ────────────────────────────────────────────────────
    // Resolution multiplier for off-screen canvases (1.0 = same as display).
    // Higher values give more precise expansion/tracing at cost of performance.
    RASTER_SCALE: 1.0,

    // ── Marching-squares tracing ──────────────────────────────────────────────
    // Inside threshold (0–255 alpha).
    TRACE_ALPHA_THRESHOLD: 128,
    // Ramer-Douglas-Peucker simplification tolerance in SCREEN PIXELS.
    // Converted to world units at trace time via: worldEps = PX / viewport.zoom
    // Higher zoom → smaller world epsilon → more detail preserved.
    TRACE_RDP_EPSILON_PX: 1.5,

    // ── Debug ─────────────────────────────────────────────────────────────────
    DEBUG: false,
  });

  /**
   * Monotonically increasing ID generator.
   * Usage: const id = MapEditor.nextId('obj');  // → 'obj_1', 'obj_2', …
   */
  let _idCounter = 0;
  MapEditor.nextId = function (prefix) {
    return prefix + '_' + (++_idCounter);
  };

  /**
   * Conditional debug logger.  A no-op in production (DEBUG=false).
   */
  MapEditor.debug = function (...args) {
    if (MapEditor.Config.DEBUG) console.debug('[MapEditor]', ...args);
  };

})(window.MapEditor = window.MapEditor || {});
