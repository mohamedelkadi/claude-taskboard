'use strict';
// The two processes other programs talk to: the web server and the MCP server.
const fx = require('./fixture');
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const P = require('../src/paths');
const store = require('../src/store');

let server;
after(() => {
  if (server) server.kill();
  fx.cleanup();
});

function request(method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: P.PORT, path: urlPath, method, headers: { host: `127.0.0.1:${P.PORT}`, ...(headers || {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const op = (name, args) => request('POST', '/api/op', { body: { name, args }, headers: { 'content-type': 'application/json' } });

before(async () => {
  // the MCP server would otherwise start a board of its own
  store.mutate((b) => (b.settings.autostart = false));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: process.env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const ok = await request('GET', '/api/health').then((r) => r.status === 200, () => false);
    if (ok) return;
  }
  throw new Error('server did not start');
});

test('the server serves the page, the state and applies operations', async () => {
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Taskboard<\/title>/);

  const state = await request('GET', '/api/state');
  assert.equal(state.json.sessions.length, 6);
  assert.equal(state.json.columns.length, 6);

  const made = await op('card.create', { title: 'From the API', sessionIds: [fx.ids.other] });
  assert.equal(made.json.ok, true);
  const card = made.json.state.cards.find((c) => c.title === 'From the API');
  assert.equal(card.view.subs[0].sessionId, fx.ids.other);
  assert.ok(made.json.state.version > state.json.version);

  const bad = await op('card.update', { card: 'no such card', title: 'x' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /No card matches/);

  const detail = await request('GET', `/api/session?id=${fx.ids.root}`);
  assert.equal(detail.json.detail.plan.length, 3);
});

test('the launcher endpoints: summary for the menu bar, brief for a new session', async () => {
  const sum = await request('GET', '/api/summary');
  assert.deepEqual(sum.json.needs.map((n) => [n.title, n.ask]), [['Daily report', 'log in again'], ['PROJ-100 search root', 'answer the question']], 'one entry per scheduled task, newest first');
  assert.equal(sum.json.running.length, 0);
  assert.equal(typeof sum.json.unsorted, 'number');

  const made = await op('card.create', { title: 'Brief me' });
  const key = made.json.result.key;
  const brief = await request('POST', '/api/new-session', { body: { card: key, copyOnly: true }, headers: { 'content-type': 'application/json' } });
  assert.match(brief.json.brief, new RegExp(`^Work on Taskboard card ${key} "Brief me"\\.`));
  assert.match(brief.json.brief, /board_link_session/);
  assert.equal(brief.json.folder, '', 'a card with no project and no sessions has no folder');
  const missing = await request('POST', '/api/new-session', { body: { card: 'nope' }, headers: { 'content-type': 'application/json' } });
  assert.equal(missing.status, 400);
});

test('the server only answers local, same-origin requests', async () => {
  const rebind = await request('GET', '/api/state', { headers: { host: 'evil.example' } });
  assert.equal(rebind.status, 403);
  const crossSite = await request('POST', '/api/op', { body: { name: 'card.create', args: { title: 'x' } }, headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  const form = await request('POST', '/api/op', { headers: { 'content-type': 'text/plain' } });
  assert.equal(form.status, 415);
  const traversal = await request('GET', '/../src/store.js');
  assert.equal(traversal.status, 404);
  const open = await request('POST', '/api/open', { body: { sessionId: 'local_x; rm -rf' }, headers: { 'content-type': 'application/json' } });
  assert.equal(open.status, 400);
});

test('the MCP server lists its tools and changes the board', async () => {
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp.js')], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  let pending = '';
  mcp.stdout.on('data', (chunk) => {
    pending += chunk;
    for (let nl; (nl = pending.indexOf('\n')) !== -1; ) {
      const msg = JSON.parse(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      if (replies.has(msg.id)) replies.get(msg.id)(msg);
    }
  });
  let seq = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      replies.set(id, resolve);
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args || {} })).result;

  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'taskboard');
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await call('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('board_overview') && names.includes('board_link_session'));
    assert.ok(list.result.tools.every((t) => t.description && t.inputSchema && t.inputSchema.type === 'object'));

    // this test process is not a Claude session, so nothing is linked by default
    const created = await tool('board_create_card', { title: 'Made by Claude', ticket: 'abc-12', subtasks: ['first step'] });
    assert.match(created.content[0].text, /Created TB-\d+\./);
    assert.match(created.content[0].text, /\[ \] first step/);

    const linked = await tool('board_link_session', { card: 'Made by Claude', session_id: fx.ids.root });
    assert.match(linked.content[0].text, /Waiting on the user: answer the question/);

    const moved = await tool('board_update_card', { card: 'Made by Claude', status: 'In review', note: 'ready for a look' });
    assert.match(moved.content[0].text, /Status: \*\*In review\*\*/);
    assert.match(moved.content[0].text, /Moved from To do to In review\. ready for a look/);

    const overview = await tool('board_overview', {});
    // 3 sub-tasks: the checklist item, the linked session, and the session it started (which joined on its own)
    assert.match(overview.content[0].text, /## In review \(1\)\n- TB-\d+ Made by Claude \[ABC-12\] — 1\/3 sub-tasks, 1 waiting on the user/);

    const found = await tool('board_find_sessions', { state: 'needs_you' });
    assert.match(found.content[0].text, /PROJ-100 search root/);

    const noCard = await tool('board_get_card', {});
    assert.equal(noCard.isError, true);
    assert.match(noCard.content[0].text, /not linked to a card/);

    const unknown = await call('nope/nope', {});
    assert.equal(unknown.error.code, -32601);
  } finally {
    mcp.kill();
  }
});
