'use strict';
// At most one attempt per candidate; stale errors cannot advance a newer play.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.createFallback = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  return function createFallback(start, exhausted) {
    let generation=0, candidates=[], index=-1, handled=false;
    function advance() {
      index++; handled=false;
      if (index>=candidates.length) { exhausted(); return; }
      const attempt=++generation;
      start(candidates[index], index, candidates.length, () => {
        if (attempt!==generation || handled) return;
        handled=true; advance();
      }, () => attempt===generation && !handled);
    }
    return {
      play(items) { generation++; candidates=items.slice(); index=-1; advance(); },
      cancel() { generation++; candidates=[]; index=-1; },
    };
  };
});
