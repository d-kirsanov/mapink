/**
 * src/undoStack.js
 *
 * Undo/redo history for user-object state.
 *
 * Strategy: snapshot-based (deep-clone JSON) rather than command-based.
 * Reason: the state (Clipper polygons + metadata) is reasonably small and
 * JSON round-trips cleanly.  Command-based undo would be more memory-efficient
 * but significantly more complex with the expansion-animation system.
 *
 * The app should:
 *   1. Call undoStack.push(initialEmptyState) at startup.
 *   2. Call undoStack.push(currentState) BEFORE every user action that
 *      should be undoable (i.e. push the state we want to be able to
 *      return to, which is the state *before* the action).
 *      — OR — push the resulting state after the action, both styles work
 *      as long as you pick one and stick to it.  We push AFTER: the stack
 *      grows as actions are completed.
 *   3. On Ctrl+Z: state = undoStack.undo(); if (state) applyState(state);
 *   4. On Ctrl+Y: state = undoStack.redo(); if (state) applyState(state);
 *
 * State shape (defined by the caller; must be JSON-serialisable):
 *   {
 *     userObjects: UserObject[]   // see userObjects.js for shape
 *   }
 */

(function (MapEditor) {
  'use strict';

  class UndoStack {
    constructor() {
      const { MAX_UNDO_STEPS } = MapEditor.Config;
      this._max   = MAX_UNDO_STEPS;
      this._stack = [];   // array of JSON-serialised state strings
      this._index = -1;   // pointer into _stack; -1 = empty
    }

    // ── Core operations ─────────────────────────────────────────────────────

    /**
     * Push a new state.  Discards any redo history above the current index.
     * Enforces the maximum stack depth by dropping the oldest entry.
     *
     * @param {object} state  Must be JSON-serialisable.
     */
    push(state) {
      // Discard all states above the current cursor (kills redo history)
      if (this._index < this._stack.length - 1) {
        this._stack.splice(this._index + 1);
      }

      // Serialise once — this is our immutable snapshot
      this._stack.push(JSON.stringify(state));

      // Enforce depth limit (keep most recent)
      if (this._stack.length > this._max) {
        this._stack.shift();
        // _index stays pointing to the last element after the shift
        // because the oldest entry was removed from the front.
      }

      // Cursor always points to the newly pushed state
      this._index = this._stack.length - 1;

      MapEditor.debug(`UndoStack: pushed (depth=${this._stack.length}, idx=${this._index})`);
    }

    /**
     * Undo one step.
     *
     * Returns a deep-cloned copy of the previous state, or null if we are
     * already at the earliest recorded state (nothing to undo).
     *
     * @returns {object|null}
     */
    undo() {
      if (this._index <= 0) {
        MapEditor.debug('UndoStack: nothing to undo');
        return null;
      }
      this._index--;
      MapEditor.debug(`UndoStack: undo → idx=${this._index}`);
      return JSON.parse(this._stack[this._index]);
    }

    /**
     * Redo one step.
     *
     * Returns a deep-cloned copy of the next state, or null if there is no
     * redo history (we are at the latest state).
     *
     * @returns {object|null}
     */
    redo() {
      if (this._index >= this._stack.length - 1) {
        MapEditor.debug('UndoStack: nothing to redo');
        return null;
      }
      this._index++;
      MapEditor.debug(`UndoStack: redo → idx=${this._index}`);
      return JSON.parse(this._stack[this._index]);
    }

    // ── State queries ────────────────────────────────────────────────────────

    /** True when undo() would return a state. */
    get canUndo() { return this._index > 0; }

    /** True when redo() would return a state. */
    get canRedo() { return this._index < this._stack.length - 1; }

    /** Number of states currently in the stack. */
    get depth() { return this._stack.length; }

    // ── Maintenance ──────────────────────────────────────────────────────────

    /**
     * Discard all history.  Call when loading a new map.
     */
    clear() {
      this._stack = [];
      this._index = -1;
    }

    /**
     * Replace the current tip of the stack (the most recently pushed state)
     * without adding a new entry.  Useful for "merge" scenarios like coalescing
     * rapid small edits into one undo step — though the expansion engine
     * already batches drawing + expansion into a single push().
     *
     * @param {object} state
     */
    replaceTip(state) {
      if (this._index < 0) {
        this.push(state);
        return;
      }
      this._stack[this._index] = JSON.stringify(state);
    }
  }

  MapEditor.UndoStack = UndoStack;

})(window.MapEditor = window.MapEditor || {});
