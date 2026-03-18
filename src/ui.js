/**
 * src/ui.js
 *
 * Full UI wiring:
 *   - Toolbar: Save, Load, Undo, Redo, Decay slider
 *   - Double-click on object (not title) → colour picker popup
 *   - Keyboard shortcuts: Ctrl+Z, Ctrl+Y, Home, Space
 *   - Dynamic cursor: crosshair (draw) / default (over existing object)
 *   - Cursor hover highlight (lighten object under cursor)
 *
 * Title editing double-click is handled in titleRenderer.js to keep that
 * module self-contained.  We coordinate here by checking whether the click
 * point is inside an object vs. near a title.
 */

(function (MapEditor) {
  'use strict';

  const UI = {};

  // Tracks the object id currently under the cursor for hover highlight.
  let _hoverObjId = null;

  // ── Init ──────────────────────────────────────────────────────────────────

  UI.init = function () {
    _initToolbar();
    _initColorPicker();
    _initKeyboard();
    _initCursorTracking();
  };

  // ── Toolbar ───────────────────────────────────────────────────────────────

  function _initToolbar() {
    document.getElementById('btn-save').addEventListener('click', () => MapEditor.Storage.save());

    document.getElementById('btn-load').addEventListener('click', () =>
      document.getElementById('fileInput').click()
    );
    document.getElementById('fileInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) MapEditor.Storage.load(file);
      e.target.value = '';
    });

    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    btnUndo.addEventListener('click', _undo);
    btnRedo.addEventListener('click', _redo);

    UI.refreshUndoButtons = function () {
      btnUndo.disabled = !MapEditor.undoStack.canUndo;
      btnRedo.disabled = !MapEditor.undoStack.canRedo;
    };
    UI.refreshUndoButtons();

    const decaySlider = document.getElementById('inp-decay');
    MapEditor.expansionDecay = parseFloat(decaySlider.value);
    decaySlider.addEventListener('input', () => {
      MapEditor.expansionDecay = parseFloat(decaySlider.value);
    });
  }

  // ── Colour picker popup ───────────────────────────────────────────────────

  function _initColorPicker() {
    const popup  = document.getElementById('colorPickerPopup');
    const input  = document.getElementById('colorPickerInput');
    const close  = document.getElementById('colorPickerClose');

    close.addEventListener('click', () => { popup.style.display = 'none'; });

    // Apply colour change live (no commit needed).
    input.addEventListener('input', () => {
      const obj = MapEditor.UserObjects.getById(_colorPickerObjId);
      if (obj) obj.color = input.value;
    });

    // Push undo when picker is closed.
    input.addEventListener('change', () => {
      MapEditor.undoStack.push(MapEditor.UserObjects.snapshot());
      UI.refreshUndoButtons();
    });

    // Double-click on canvas: if click is on an object (and NOT on a title
    // text region, which titleRenderer handles) → open colour picker.
    MapEditor.canvas.addEventListener('dblclick', (e) => {
      // Shift-double-click → colour picker (avoids conflict with title edit).
      if (!e.shiftKey) return;   // plain dblclick is claimed by titleRenderer for title edit

      const rect = MapEditor.canvas.getBoundingClientRect();
      const sx   = e.clientX - rect.left;
      const sy   = e.clientY - rect.top;
      const wp   = MapEditor.viewport.screenToWorld(sx, sy);
      const hit  = MapEditor.UserObjects.hitTest(wp.x, wp.y);
      if (!hit) return;

      e.preventDefault();
      _openColorPicker(hit.object, e.clientX, e.clientY);
    });
  }

  let _colorPickerObjId = null;

  function _openColorPicker(obj, clientX, clientY) {
    const popup = document.getElementById('colorPickerPopup');
    const input = document.getElementById('colorPickerInput');

    _colorPickerObjId = obj.id;
    input.value = obj.color;

    // Position popup near the click, keeping it inside the viewport.
    const W = window.innerWidth, H = window.innerHeight;
    const pw = 200, ph = 60;
    let left = clientX + 10, top = clientY + 10;
    if (left + pw > W) left = clientX - pw - 10;
    if (top  + ph > H) top  = clientY - ph - 10;

    popup.style.left    = left + 'px';
    popup.style.top     = top  + 'px';
    popup.style.display = 'flex';
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  function _initKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); _undo(); return; }
        if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); _redo(); return; }
      }

      // Space: stop expansion; also sets spaceHeld flag used by drawTool.
      if (e.key === ' ') {
        e.preventDefault();
        MapEditor.spaceHeld = true;
        if (MapEditor.Expansion) MapEditor.Expansion.stop();
      }

      // Home: fit to screen (also wired in main.js but harmless to repeat).
      if (e.key === 'Home') {
        e.preventDefault();
        MapEditor.viewport.fitToScreen();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') MapEditor.spaceHeld = false;
    });
  }

  // ── Undo / redo helpers ───────────────────────────────────────────────────

  function _undo() {
    // If expansion is running, cancel it (restore pre-draw state) without
    // popping the undo stack — the gesture is discarded, not committed.
    if (MapEditor.Expansion && MapEditor.Expansion.isActive()) {
      MapEditor.Expansion.cancel();
      UI.refreshUndoButtons();
      return;
    }
    const state = MapEditor.undoStack.undo();
    if (!state) return;
    MapEditor.UserObjects.applySnapshot(state);
  }

  function _redo() {
    // Finalize any running expansion before jumping to a redo state.
    if (MapEditor.Expansion && MapEditor.Expansion.isActive()) {
      MapEditor.Expansion.stop();
    }
    const state = MapEditor.undoStack.redo();
    if (!state) return;
    MapEditor.UserObjects.applySnapshot(state);
  }

  // ── Cursor tracking & hover highlight ────────────────────────────────────

  function _initCursorTracking() {
    MapEditor.canvas.addEventListener('mousemove', (e) => {
      if (MapEditor.DrawTool && MapEditor.DrawTool.isDrawing()) return;

      const rect = MapEditor.canvas.getBoundingClientRect();
      const sx   = e.clientX - rect.left;
      const sy   = e.clientY - rect.top;
      const wp   = MapEditor.viewport.screenToWorld(sx, sy);

      // Check shape hit first, then title text regions.
      const hit      = MapEditor.UserObjects.hitTest(wp.x, wp.y);
      const titleHit = (!hit && MapEditor.TitleRenderer)
        ? MapEditor.TitleRenderer.hitTestTitle(sx, sy)
        : null;

      const newId = hit ? hit.object.id : (titleHit ? titleHit.id : null);

      if (newId !== _hoverObjId) {
        _hoverObjId = newId;
        MapEditor.canvas.style.cursor = newId ? 'cell' : 'crosshair';
      }
    });

    MapEditor.canvas.addEventListener('mouseleave', () => {
      _hoverObjId = null;
      MapEditor.canvas.style.cursor = 'crosshair';
    });
  }

  /**
   * Return the id of the object currently under the cursor (for renderer
   * to draw a hover highlight, if desired).
   */
  UI.getHoverObjId = () => _hoverObjId;

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.UI = UI;

})(window.MapEditor = window.MapEditor || {});
