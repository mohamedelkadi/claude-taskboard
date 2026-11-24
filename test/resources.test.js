'use strict';
const fx = require('./fixture');
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../src/paths');
const R = require('../src/resources');
const claude = require('../src/claude');
const store = require('../src/store');
const view = require('../src/view');

after(fx.cleanup);

const THREAD = 'https://acme.slack.com/archives/C04ABC/p1700000000123456?thread_ts=1700000000.000100&cid=C04ABC';
const REPLY = 'https://acme.slack.com/archives/C04ABC/p1700000099000200?thread_ts=1700000000.000100&cid=C04ABC';
const GDOC = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing&token=SECRET';
const WHEN = new Date(Date.now() - 60000).toISOString();

const line = (o) => Buffer.from(JSON.stringify({ isSidechain: false, timestamp: WHEN, ...o }));
const user = (text, extra) => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
const said = (text, extra) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const call = (id, name, input = {}) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, extra) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...extra }] } });

function read(...lines) {
  const into = R.fresh();
  for (const l of lines) R.readLine(l, into);
  return into.items;
}

test('links are recognised by kind, on the real hosts only', () => {
  assert.equal(R.classify('https://github.com/acme/app/pull/12/files').url, 'https://github.com/acme/app/pull/12');
  assert.match(R.classify(THREAD).label, /^Thread · Nov 1[45]$/); // the day the thread started, in local time
  assert.equal(R.classify('https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Search+Plan').label, 'Search Plan');
  assert.equal(R.classify('https://claude.ai/code/artifact/abcd1234-ef').kind, 'artifact');
  for (const bad of [
    'http://acme.slack.com/archives/C04ABC/p1700000000123456',
    'https://acme.slack.com.evil.test/archives/C04ABC/p1700000000123456',
    'https://evil.test/docs.google.com/document/d/1AbCdEfGhIjKlMnOp',
    'https://user:pw@github.com/acme/app/pull/12',
    'https://github.com/acme/app/issues/12',
    'javascript:alert(1)',
  ]) assert.equal(R.classify(bad), null, bad);
});

test('a token in a link never reaches the board', () => {
  assert.equal(R.classify(GDOC).url, 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp');
  assert.ok(!JSON.stringify(read(user(`see ${GDOC}`))).includes('SECRET'));
});

test('what the user wrote, what Claude said and what a tool created all count', () => {
  const got = read(
    user(`look at ${THREAD} and https://github.com/acme/app/pull/9.`),
    said('The plan is in [Search rollout plan](https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit).'),
    call('w1', 'mcp__abc__slack_send_message'),
    result('w1', 'Sent: https://acme.slack.com/archives/C09XYZ/p1700000200000300')
  );
  assert.deepEqual(got.map((r) => r.kind).sort(), ['doc', 'pr', 'slack', 'slack']);
  assert.equal(got.find((r) => r.kind === 'doc').label, 'Search rollout plan');
});

test('search results, injected text, subagents and failed posts do not count', () => {
  const got = read(
    call('s1', 'mcp__abc__slack_search_public'),
    result('s1', THREAD),
    user(`<system-reminder>${THREAD}</system-reminder>hello`),
    user(`skill text ${THREAD}`, { isMeta: true }),
    said(`from a subagent ${THREAD}`, { isSidechain: true }),
    said('Claude mentioning https://github.com/acme/app/pull/44'),
    call('w2', 'mcp__abc__slack_send_message'),
    result('w2', `could not post ${THREAD}`, { is_error: true })
  );
  assert.deepEqual(got, []);
});

test('replies in one thread are one conversation', () => {
  assert.equal(read(user(THREAD), user(REPLY)).length, 1);
});

const READ_TS = '1700000000.000100';
const slackRead = (id, tool, input) => call(id, `mcp__conn__slack_${tool}`, input);
function linksFrom(...lines) {
  const into = R.fresh();
  for (const l of lines) R.readLine(l, into);
  return R.forSession({ prs: [], artifacts: [] }, [{ links: into }]);
}

test('a Slack thread read through a tool gets a link in the right workspace', () => {
  const got = linksFrom(
    user('https://acme.slack.com/archives/C04ABC/p1699999999000001'),
    slackRead('r1', 'read_thread', { channel_id: 'C04ABC', message_ts: READ_TS }),
    result('r1', '{"messages":[{"text":"no link in here"}]}')
  );
  const thread = got.find((r) => r.key === `slack:acme/C04ABC/${READ_TS}`);
  assert.equal(thread.url, 'https://acme.slack.com/archives/C04ABC/p1700000000000100');
  assert.match(thread.label, /^Thread · /);
});

test('with no sign of the workspace, a Slack read gets no link', () => {
  assert.deepEqual(linksFrom(slackRead('r2', 'read_thread', { channel_id: 'C04ABC', message_ts: READ_TS }), result('r2', '{"messages":[]}')), []);
});

test('the connector\'s workspace is used only when it clearly has one', () => {
  const search = (id, hosts) => [slackRead(id, 'search_public', { query: 'x' }), result(id, hosts.map((h, n) => `https://${h}.slack.com/archives/C0OTHER${n}/p1700000000000100`).join(' '))];
  const thread = [slackRead('r3', 'read_thread', { channel_id: 'C09NEW', message_ts: READ_TS }), result('r3', '{"messages":[]}')];
  const clear = linksFrom(...search('s3', ['acme', 'acme', 'acme', 'acme', 'other']), ...thread);
  assert.deepEqual(clear.map((r) => r.url), ['https://acme.slack.com/archives/C09NEW/p1700000000000100']);
  assert.deepEqual(linksFrom(...search('s4', ['acme', 'other']), ...thread), []);
});

test('a channel known in two workspaces is not guessed', () => {
  const got = linksFrom(
    user('https://acme.slack.com/archives/C04ABC https://other.slack.com/archives/C04ABC'),
    slackRead('r4', 'read_thread', { channel_id: 'C04ABC', message_ts: READ_TS }),
    result('r4', '{"messages":[]}')
  );
  assert.equal(got.filter((r) => r.key.endsWith(READ_TS)).length, 0);
});

test('failed reads and person ids get no Slack link', () => {
  const known = user('https://acme.slack.com/archives/C04ABC/p1699999999000001');
  const only = (...lines) => linksFrom(known, ...lines).filter((r) => r.key.endsWith(READ_TS) || r.key.includes('U04PERSON'));
  assert.deepEqual(only(slackRead('f1', 'read_thread', { channel_id: 'C04ABC', message_ts: READ_TS }), result('f1', 'nope', { is_error: true })), []);
  assert.deepEqual(only(slackRead('f2', 'read_thread', { channel_id: 'C04ABC', message_ts: READ_TS }), result('f2', '{"ok":false,"error":"thread_not_found"}')), []);
  assert.deepEqual(only(slackRead('f3', 'read_channel', { channel_id: 'U04PERSON' }), result('f3', '{"messages":[]}')), []);
});

test('a read adds nothing when the same conversation is already linked', () => {
  const got = linksFrom(
    user(THREAD),
    slackRead('d1', 'read_thread', { channel_id: 'C04ABC', message_ts: READ_TS }),
    result('d1', '{"messages":[]}'),
    slackRead('d2', 'read_channel', { channel_id: 'C04ABC' }),
    result('d2', '{"messages":[]}')
  );
  assert.equal(got.length, 1);
  assert.ok(got[0].url.includes('thread_ts='), 'the link someone shared is the one kept');
});

test('a card with many sessions keeps every link', () => {
  const lists = [0, 1, 2].map((s) => Array.from({ length: 30 }, (_, n) => ({ key: `slack:acme/C1/${s}-${n}`, kind: 'slack', url: 'https://acme.slack.com/archives/C1', label: 'x', at: n })));
  assert.equal(R.merge(lists).length, 90);
});

test('link text that is part of a sentence is not used as a name', () => {
  const [slack] = read(said(`I [replied in the thread](${THREAD})`));
  assert.match(slack.label, /^Thread · /);
  const [prose] = read(said(`Here it is: [that doc](${GDOC})`));
  assert.equal(prose.label, 'Google Doc');
  const [named] = read(said(`[Search rollout plan](${GDOC})`));
  assert.equal(named.label, 'Search rollout plan');
});

test('a card gathers its sessions\' links, once each, and only when it has any', async () => {
  const empty = store.apply('card.create', { title: 'No links' });
  const made = store.apply('card.create', { title: 'With links' });
  const ids = [8, 9].map((n) => `local_${fx.uuid(n)}`);
  fx.desktopSession(ids[0], 8, {
    prs: [{ prNumber: 7, repo: 'acme/app', url: 'https://github.com/acme/app/pull/7', state: 'OPEN' }],
    publishedArtifacts: [{ url: 'https://claude.ai/code/artifact/abcd1234-ef', title: 'Rollout page' }],
  });
  fx.desktopSession(ids[1], 9, {});
  const write = (n, lines) => fs.writeFileSync(path.join(P.PROJECTS_DIR, '-work-app', `${fx.uuid(n)}.jsonl`), lines.map(String).join('\n') + '\n');
  write(108, [user(`${THREAD} https://github.com/acme/app/pull/7`)]);
  write(109, [user(`${REPLY} ${GDOC}`)]);
  claude.scan();
  await claude.scanTranscript(fx.uuid(108));
  await claude.scanTranscript(fx.uuid(109));
  store.apply('session.link', { card: made.id, sessionIds: ids });

  const state = view.buildState(store.load(), claude.scan());
  const related = state.cards.find((c) => c.id === made.id).view.resources;
  assert.deepEqual(related.map((r) => r.kind).sort(), ['artifact', 'doc', 'slack']); // PR 7 is tracked, so it shows with its state
  assert.equal(related.find((r) => r.kind === 'artifact').label, 'Rollout page');
  assert.deepEqual(state.cards.find((c) => c.id === empty.id).view.resources, []);
});

test('a transcript read before this feature gets its links, and new lines add to them', async () => {
  const id = fx.uuid(110);
  const file = path.join(P.PROJECTS_DIR, '-work-app', `${id}.jsonl`);
  fs.writeFileSync(file, `${user(THREAD)}\n`);
  claude.indexTranscripts(true);
  const d = await claude.scanTranscript(id);
  delete d.links; // as an earlier version left it, already read to the end
  delete d.linksV;
  assert.equal(claude.detailIsStale(id), true);
  assert.equal((await claude.scanTranscript(id)).links.items.length, 1);
  assert.equal(claude.detailIsStale(id), false);
  fs.appendFileSync(file, `${user(GDOC)}\n`);
  assert.equal((await claude.scanTranscript(id)).links.items.length, 2);
});
