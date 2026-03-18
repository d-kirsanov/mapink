/**
 * src/main.js
 *
 * Application initialisation.  Runs after all other scripts have loaded.
 *
 * Responsibilities:
 *   - Grab the canvas, size it to the window, handle resize.
 *   - Instantiate Viewport, UndoStack, and the empty UserObjects store.
 *   - Wire pan (middle mouse), zoom (wheel), and Home key directly here
 *     since they are pure viewport concerns that need no other module.
 *   - Load the world SVG, then start the render loop.
 *   - Delegate all other input handling to ui.js (draw tool, toolbar, etc.)
 *
 * Global objects attached to window.MapEditor:
 *   .canvas       — HTMLCanvasElement
 *   .ctx          — CanvasRenderingContext2D
 *   .viewport     — Viewport instance
 *   .undoStack    — UndoStack instance
 *   (UserObjects, DrawTool, Expansion, etc. are attached by their own modules)
 */

(function (MapEditor) {
  'use strict';

  // ── Canvas setup ──────────────────────────────────────────────────────────

  function _initCanvas() {
    const canvas = document.getElementById('mainCanvas');
    const ctx    = canvas.getContext('2d', { alpha: false });

    // Size the canvas to fill the window.
    function resize() {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      if (MapEditor.viewport) {
        MapEditor.viewport.onResize();
      }
      // Force a re-render so the world doesn't disappear after resize.
      if (MapEditor.Renderer) MapEditor.Renderer.redraw();
    }

    resize();
    window.addEventListener('resize', resize);

    MapEditor.canvas = canvas;
    MapEditor.ctx    = ctx;
  }

  // ── Pan & zoom ────────────────────────────────────────────────────────────

  function _initNavigation() {
    const canvas   = MapEditor.canvas;
    const viewport = MapEditor.viewport;
    const { ZOOM_WHEEL_FACTOR } = MapEditor.Config;

    // ── Middle-button pan via Pointer Events ─────────────────────────────
    // Using the Pointer Events API with setPointerCapture is far more reliable
    // than mouse events for middle-click: it prevents the browser's autoscroll
    // cursor from stealing the pointer, and captures movement even when the
    // cursor leaves the canvas.
    let _panPointerId = -1;
    let _panLastX     = 0;
    let _panLastY     = 0;

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 1) return;   // middle button only
      e.preventDefault();
      _panPointerId = e.pointerId;
      _panLastX     = e.clientX;
      _panLastY     = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== _panPointerId) return;
      const dx = e.clientX - _panLastX;
      const dy = e.clientY - _panLastY;
      viewport.panBy(dx, dy);
      _panLastX = e.clientX;
      _panLastY = e.clientY;
    });

    const _endPan = (e) => {
      if (e.pointerId !== _panPointerId) return;
      _panPointerId = -1;
      canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = 'crosshair';
    };
    canvas.addEventListener('pointerup',     _endPan);
    canvas.addEventListener('pointercancel', _endPan);

    // Prevent the browser's middle-click paste / scroll-mode on all relevant events.
    canvas.addEventListener('auxclick',    (e) => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // ── Mouse-wheel zoom ──────────────────────────────────────────────────
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Finalize any running expansion BEFORE changing the viewport.
      // Tracing must run under the same transform that was active during drawing.
      if (MapEditor.Expansion && MapEditor.Expansion.isActive()) {
        MapEditor.Expansion.stop();
      }
      const delta  = e.deltaY > 0 ? -1 : 1;
      const factor = delta > 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR;
      const rect   = canvas.getBoundingClientRect();
      viewport.zoomAtPoint(e.clientX - rect.left, e.clientY - rect.top, factor);
    }, { passive: false });

    // ── Home key → fit to screen ──────────────────────────────────────────
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Home') { e.preventDefault(); viewport.fitToScreen(); }
    });
  }

  // ── App init ──────────────────────────────────────────────────────────────

  async function _init() {
    _initCanvas();

    // Core singletons
    MapEditor.viewport  = new MapEditor.Viewport(MapEditor.canvas);
    MapEditor.undoStack = new MapEditor.UndoStack();

    // Initialise UserObjects store (empty state)
    MapEditor.UserObjects.init();

    // Push the initial empty state so undo can always go back to it.
    MapEditor.undoStack.push(MapEditor.UserObjects.snapshot());

    // Init modules that need canvas/viewport ready
    MapEditor.RasterOps.init(MapEditor.canvas);
    MapEditor.DrawTool.init();
    MapEditor.Expansion.init();
    MapEditor.TitleRenderer.init();
    MapEditor.UI.init();

    // Navigation (pan/zoom) wired here — depends only on MapEditor.viewport
    _initNavigation();

    // Start render loop right away so we show *something* while SVG loads.
    MapEditor.Renderer.start();

    // Load the world SVG (async; render loop shows ocean + empty canvas until done).
    await MapEditor.WorldMap.load('world-data.svg');

    // Fit the world to the screen once loaded.
    MapEditor.viewport.fitToScreen();

    MapEditor.debug('MapEditor: initialisation complete');
  }

  // Run after DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})(window.MapEditor = window.MapEditor || {});
