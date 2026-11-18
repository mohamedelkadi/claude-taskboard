'use strict';
const fx = require('./fixture');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/paths');
const store = require('../src/store');
const claude = require('../src/claude');
const view = require('../src/view');

after(fx.cleanup);

const state = () => view.buildState(store.load(), claude.scan());
const card = (st, title) => st.cards.find((c) => c.title === title);

test('scan reads sessions, groups, tickets and the transcript step list', async () => {
  const scan = claude.scan();
  assert.equal(scan.sessions.length, 6);
  assert.deepEqual(scan.groups, [{ id: 'cg-1', name: 'Search' }]);
  const root = scan.sessions.find((s) => s.id === fx.ids.root);
  assert.equal(root.groupId, 'cg-1');
  assert.equal(root.state, 'needs_you');
  assert.deepEqual(root.tickets, ['PROJ-100']);
  // "review-26397" in a branch name is not a ticket
  assert.deepEqual(scan.sessions.find((s) => s.id === fx.ids.other).tickets, []);

  const detail = await claude.sessionDetail(root);
  assert.deepEqual(detail.plan.map((i) => i.status), ['completed', 'in_progress', 'pending'], 'a repeated log line advances once');
  assert.equal(detail.firstPrompt, 'fix the search ranking');
  assert.equal(detail.lastPrompt, 'and add a test');
  assert.equal(detail.cost, 1.24);
});

test('a transcript is read incrementally as it grows', async () => {
  const root = claude.scan().sessions.find((s) => s.id === fx.ids.root);
  fs.appendFileSync(fx.transcript, fx.tool('t3', 'mcp__ccd_turn__wrap_up', { recap: 'Fixed the ranking.', ask: 'Ship it?' }) + '\n');
  const detail = await claude.sessionDetail(root);
  assert.deepEqual(detail.plan.map((i) => i.status), ['completed', 'completed', 'pending']);
  assert.equal(detail.wrap.recap, 'Fixed the ranking.');
  const again = claude.scan().sessions.find((s) => s.id === fx.ids.root);
  assert.deepEqual(again.steps, { total: 3, done: 2, current: '' });
});

test('first run imports sidebar groups, session families and scheduled tasks', () => {
  const made = view.seed(claude.scan());
  assert.deepEqual(made, { groups: 1, families: 0, routines: 1 });
  const st = state();
  const search = card(st, 'Search');
  assert.equal(search.ticket, '');
  assert.equal(search.auto.groupId, 'cg-1');
  // the root came in by group, its child by the "started from" rule
  assert.deepEqual(search.view.subs.map((s) => [s.sessionId, s.via, s.status]), [[fx.ids.root, 'group', 'blocked'], [fx.ids.child, 'child', 'done']]);
  assert.deepEqual(search.view.counts, { total: 2, done: 1, running: 0, needs: 1, review: 0 });
  const daily = card(st, 'Daily report');
  assert.equal(daily.status, 'waiting');
  assert.equal(daily.view.subs.length, 1, 'all runs are one sub-task');
  assert.equal(daily.view.subs[0].runs, 2);
  assert.equal(daily.view.subs[0].status, 'blocked');
  assert.equal(view.seed(claude.scan()), null, 'never imports twice');
});

test('unsorted sessions get a suggestion from a shared PR; archived ones settle as done', () => {
  const st = state();
  const other = st.sessions.find((s) => s.id === fx.ids.other);
  assert.equal(other.cardId, null);
  assert.equal(other.suggest.cardId, card(st, 'Search').id);
  assert.match(other.suggest.reason, /PR #7/);
  assert.equal(st.sessions.find((s) => s.id === fx.ids.old).estate, 'done');
});

test('cards move between columns and keep their order', () => {
  const a = store.apply('card.create', { title: 'A', status: 'To do' });
  const b = store.apply('card.create', { title: 'B', status: 'todo' });
  const c = store.apply('card.create', { title: 'C', status: 'in progress' });
  const order = (col) => store.load().cards.filter((x) => x.status === col).sort((x, y) => x.order - y.order).map((x) => x.title);
  assert.deepEqual(order('todo'), ['B', 'A'], 'new cards go on top');
  store.apply('card.move', { card: c.id, status: 'todo', beforeId: a.id });
  assert.deepEqual(order('todo'), ['B', 'C', 'A']);
  store.apply('card.move', { card: b.key, status: 'todo' });
  assert.deepEqual(order('todo'), ['C', 'A', 'B'], 'no beforeId drops at the end');
  assert.equal(store.apply('card.update', { card: 'A', status: 'Done' }).status, 'done');
  assert.throws(() => store.apply('card.update', { card: a.id, status: 'nope' }), /No column/);
});

test('a session sits on one card; taking it off by hand keeps it off', () => {
  const st0 = state();
  const search = card(st0, 'Search');
  const a = card(st0, 'A');
  store.apply('session.link', { card: a.id, sessionIds: [fx.ids.child] });
  let st = state();
  assert.equal(st.sessions.find((s) => s.id === fx.ids.child).cardId, a.id);
  assert.ok(!card(st, 'Search').view.subs.some((s) => s.sessionId === fx.ids.child), 'linking moved it');
  assert.equal(st.implicit.length, 1, 'the two cards are now detected as related');
  assert.match(st.implicit[0].reasons[0], /was started from/);

  store.apply('session.unlink', { sessionIds: [fx.ids.child] });
  assert.equal(view.applyAutoLinks(claude.scan()), 0, 'not pulled back by the "started from" rule');
  assert.equal(state().sessions.find((s) => s.id === fx.ids.child).cardId, null);

  // a ticket rule claims sessions that mention the key
  store.apply('card.update', { card: a.id, auto: { ticketKeys: ['proj-100'] } });
  store.apply('session.unlink', { sessionIds: [fx.ids.root] });
  store.mutate((b) => delete b.sessionMeta[fx.ids.root]);
  store.apply('card.update', { card: search.id, auto: { groupId: '' } });
  assert.equal(view.applyAutoLinks(claude.scan()), 1);
  assert.equal(state().sessions.find((s) => s.id === fx.ids.root).cardId, a.id);
});

test('"mark handled" hides a request until the session asks again', () => {
  let st = state();
  const root = st.sessions.find((s) => s.id === fx.ids.root);
  assert.equal(root.estate, 'needs_you');
  store.apply('session.meta', { sessionIds: [root.id], ack: { [root.id]: root.token } });
  assert.equal(state().sessions.find((s) => s.id === root.id).estate, 'idle');
  fx.desktopSession(fx.ids.root, 1, { title: 'PROJ-100 search root', postTurnSummary: { status_category: 'blocked', needs_action: 'a new question', summarizes_uuid: 'u-2' } });
  assert.equal(state().sessions.find((s) => s.id === root.id).estate, 'needs_you');
});

test('sub-tasks, connections, notes and columns', () => {
  const a = store.findCard(store.load(), 'A');
  const b = store.findCard(store.load(), 'B');
  const sub = store.apply('subtask.add', { card: a.id, title: 'write tests' });
  store.apply('subtask.update', { card: a.id, subtask: 'write tests', status: 'done' });
  assert.throws(() => store.apply('subtask.update', { card: a.id, subtask: sub.id, status: 'auto' }), /status is one of/, 'auto is for linked sessions only');

  store.apply('link.add', { from: a.id, to: b.id, type: 'blocks' });
  store.apply('link.add', { from: b.id, to: a.id, type: 'relates' });
  const links = store.load().cards.flatMap((c) => c.links.map((l) => [c.title, l.type]));
  assert.deepEqual(links, [['B', 'relates']], 'one connection per pair');
  assert.throws(() => store.apply('link.add', { from: a.id, to: a.id }), /itself/);

  store.apply('note.add', { card: a.id, text: 'decided to ship', by: 'claude · test' });
  const md = view.cardMarkdown(card(state(), 'A'), state());
  assert.match(md, /\[x\] write tests/);
  assert.match(md, /related to TB-\d+ · B/);
  assert.match(md, /decided to ship/);

  store.apply('columns.set', { columns: [{ id: 'todo', name: 'Next' }, { name: 'Shipped', done: true }] });
  const after = store.load();
  assert.deepEqual(after.columns.map((c) => c.name), ['Next', 'Shipped']);
  assert.ok(after.cards.every((c) => ['todo', 'shipped'].includes(c.status)), 'cards from deleted columns are kept');

  store.apply('card.delete', { card: b.id });
  assert.ok(!store.load().cards.some((c) => c.links.some((l) => l.to === b.id)));
});

test('card files are written for Claude and removed with the card', () => {
  view.exportMarkdown(state());
  const a = store.findCard(store.load(), 'A');
  const file = path.join(P.CARDS_DIR, `${a.key}.md`);
  assert.match(fs.readFileSync(file, 'utf8'), /^# TB-\d+ · A/);
  assert.match(fs.readFileSync(P.OVERVIEW_FILE, 'utf8'), /## Next/);
  store.apply('card.delete', { card: a.id });
  view.exportMarkdown(state());
  assert.ok(!fs.existsSync(file));
});

test('a damaged board file is reported, never replaced with an empty board', () => {
  const good = fs.readFileSync(P.BOARD_FILE, 'utf8');
  fs.writeFileSync(P.BOARD_FILE, '{ not json');
  assert.throws(() => store.apply('card.create', { title: 'x' }), /Cannot read/);
  assert.equal(fs.readFileSync(P.BOARD_FILE, 'utf8'), '{ not json');
  fs.writeFileSync(P.BOARD_FILE, good);
});
