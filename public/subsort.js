'use strict';
// How a card's sub-tasks are ordered, shared by the board (browser) and by what
// Claude reads (Node). Sessions started from a checklist item are listed under it,
// sorted the same way among themselves.
(function (root) {
  const SORTS = {
    board: 'Board order',
    recent: 'Most recent activity',
    newest: 'Newest first',
    oldest: 'Oldest first',
    attention: 'Needs attention first',
    title: 'Title A–Z',
  };
  // what to look at first: waiting on you, then working, then ready to check, then the rest
  const RANK = { blocked: 0, in_progress: 2, review: 3, todo: 4, done: 6 };
  const STATE_RANK = { needs_you: 0, running: 1, review: 3, idle: 4, done: 6 };
  const rank = (s) => (s.state && s.state in STATE_RANK ? STATE_RANK[s.state] : RANK[s.status] ?? 5);

  const CMP = {
    recent: (a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0),
    newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    oldest: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    attention: (a, b) => rank(a) - rank(b) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0),
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base', numeric: true }),
  };

  /** Sub-tasks in display order, each with `depth` (0, or 1 under its checklist item). */
  function subTree(subs, sort) {
    const cmp = CMP[sort];
    const order = (list) => (cmp ? list.slice().sort((a, b) => cmp(a, b) || list.indexOf(a) - list.indexOf(b)) : list);
    const ids = new Set(subs.map((s) => s.id));
    const kids = new Map();
    const top = [];
    for (const s of subs) {
      if (s.forSub && ids.has(s.forSub)) {
        if (!kids.has(s.forSub)) kids.set(s.forSub, []);
        kids.get(s.forSub).push(s);
      } else top.push(s);
    }
    const out = [];
    for (const s of order(top)) {
      out.push({ ...s, depth: 0 });
      for (const k of order(kids.get(s.id) || [])) out.push({ ...k, depth: 1 });
    }
    return out;
  }

  const api = { SORTS, subTree };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SubSort = api;
})(typeof window !== 'undefined' ? window : globalThis);
