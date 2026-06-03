/**
 * src/storage.js
 *
 * Save the map as SVG and load it back.
 *
 * ── SVG structure saved ──────────────────────────────────────────────────────
 *
 *  <svg viewBox="0 0 1000 500"
 *       xmlns="http://www.w3.org/2000/svg"
 *       xmlns:me="urn:map-editor">
 *
 *    <!-- static world paths are NOT saved — they are always re-loaded from
 *         world-data.svg at startup.  Only user objects are persisted. -->
 *
 *    <g id="me-objects">
 *      <g me:id="obj_1" me:color="#4a90d9" me:title="France">
 *        <path d="M … Z" />          <!-- one <path> per Shape -->
 *        <path d="M … Z" />
 *      </g>
 *      …
 *    </g>
 *  </svg>
 *
 * ── Loading ──────────────────────────────────────────────────────────────────
 *  Parse the <g id="me-objects"> group, reconstruct UserObjects + Shapes,
 *  rebuild clipperPolygons from svgPath via PathOps.svgDToClipperPaths().
 */

(function (MapEditor) {
  'use strict';

  const ME_NS    = 'urn:map-editor';
  const SVG_NS   = 'http://www.w3.org/2000/svg';

  const Storage = {};

  // ── Save ──────────────────────────────────────────────────────────────────

  /**
   * Serialise current user objects to SVG and trigger a browser download.
   */
  Storage.save = function () {
    const { WORLD_WIDTH, WORLD_HEIGHT } = MapEditor.Config;

    const lines = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg viewBox="0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}"`,
      `     xmlns="${SVG_NS}"`,
      `     xmlns:me="${ME_NS}">`,
      `  <g id="me-objects">`,
    ];

    for (const obj of MapEditor.UserObjects.getAll()) {
      // Escape XML attribute values.
      const title = _escAttr(obj.title || '');
      const color = _escAttr(obj.color);
      const id    = _escAttr(obj.id);
      lines.push(`    <g me:id="${id}" me:color="${color}" me:title="${title}">`);

      for (const shape of obj.shapes) {
        if (!shape.svgPath) continue;
        lines.push(`      <path d="${_escAttr(shape.svgPath)}"/>`);
      }

      lines.push(`    </g>`);
    }

    lines.push(`  </g>`, `</svg>`);

    const svgText = lines.join('\n');
    const blob    = new Blob([svgText], { type: 'image/svg+xml' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href        = url;
    a.download    = 'map.svg';
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Load ──────────────────────────────────────────────────────────────────

  /**
   * Load a previously saved map SVG from a File object (from the file picker).
   * Replaces all current user objects.  Pushes an undo snapshot first.
   *
   * @param {File} file
   */
  Storage.load = function (file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        _importSvgText(e.target.result);
      } catch (err) {
        console.error('[Storage] Failed to load map:', err);
        alert('Could not load map file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  function _importSvgText(svgText) {
    const parser  = new DOMParser();
    const doc     = parser.parseFromString(svgText, 'image/svg+xml');
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) throw new Error('SVG parse error: ' + parseErr.textContent.slice(0, 120));

    const objGroup = doc.getElementById('me-objects');
    if (!objGroup) throw new Error('No <g id="me-objects"> found — is this a map editor file?');

    // Clear history — loading a file is an "open" operation, not an undoable
    // edit.  The loaded state becomes the new baseline; nothing before it is
    // reachable via Ctrl+Z.
    MapEditor.UserObjects.init();

    const groupEls = objGroup.querySelectorAll(':scope > g');
    for (const g of groupEls) {
      const id    = g.getAttributeNS(ME_NS, 'id')    || MapEditor.nextId(MapEditor.Config.ID_OBJECT_PREFIX);
      const color = g.getAttributeNS(ME_NS, 'color') || '#888888';
      const title = g.getAttributeNS(ME_NS, 'title') || '';

      const shapes = [];
      for (const pathEl of g.querySelectorAll('path')) {
        const d = pathEl.getAttribute('d');
        if (!d) continue;

        const clipperPolygons = MapEditor.PathOps.svgDToClipperPaths(d);
        if (!clipperPolygons || clipperPolygons.length === 0) continue;

        shapes.push({
          id:              MapEditor.nextId(MapEditor.Config.ID_SHAPE_PREFIX),
          clipperPolygons,
          svgPath:         d,
          path2D:          new Path2D(d),
          bounds:          MapEditor.PathOps.computeBoundsFromClipper(clipperPolygons),
        });
      }

      if (shapes.length === 0) continue;

      const obj = {
        id,
        shapes,
        color,
        title,
        lastEdited: Date.now(),
      };
      MapEditor.UserObjects.getAll().push(obj);
    }

    // Replace the entire undo history with just the loaded state as baseline.
    MapEditor.undoStack.clear();
    MapEditor.undoStack.push(MapEditor.UserObjects.snapshot());

    if (MapEditor.UI && MapEditor.UI.refreshUndoButtons) {
      MapEditor.UI.refreshUndoButtons();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _escAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.Storage = Storage;

})(window.MapEditor = window.MapEditor || {});
