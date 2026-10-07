// Minimal observable store used by the controllers; its shape matches React's useSyncExternalStore (subscribe, getSnapshot).
// The controllers hold all behavior of the extension pages and know nothing about React or the DOM, so the Node test
// suites exercise them directly with a mocked `chrome`.

/**
 * @template T
 * @param {T} initial
 */
export function createStore(initial) {
  let state = initial;
  const subscribers = new Set();
  return {
    getState: () => state,
    /** Merges a patch (or the result of a function of the current state) and notifies subscribers. */
    setState(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const fn of Array.from(subscribers)) fn();
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
  };
}
