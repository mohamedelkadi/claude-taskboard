'use strict';
// Notes as Markdown, and the files kept on a card.
const fx = require('./fixture');
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const P = require('../src/paths');
const store = require('../src/store');
const view = require('../src/view');
const attachments = require('../src/attachments');
const { md } = require('../public/markdown');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAMBAQAY3Y2wAAAAAElFTkSuQmCC', 'base64');

let server;
after(() => {
  if (server) server.kill();
  fx.cleanup();
});

function request(method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: P.PORT, path: urlPath, method, headers: { host: `127.0.0.1:${P.PORT}`, ...(headers || {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(data.toString('utf8'));
        } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, data, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const upload = (card, name, body, headers) =>
  request('POST', `/api/attachments?card=${encodeURIComponent(card)}&name=${encodeURIComponent(name)}`, { body, headers: { 'content-type': 'application/octet-stream', ...(headers || {}) } });

before(async () => {
  store.mutate((b) => (b.settings.autostart = false));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: process.env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await request('GET', '/api/health').then((r) => r.status === 200, () => false)) return;
  }
  throw new Error('server did not start');
});

test('notes render headings, lists, tasks, quotes, code and tables', () => {
  const html = md('# Title\n\nSome **bold**, *soft* and `co*de*`.\n\n1. one\n\n2. two\n   - nested\n\n- [x] shipped\n- [ ] left\n\n> quoted\n\n```js\nconst a = "<b>";\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /class="md-h md-h1"[^>]*>Title</);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>soft<\/em>/);
  assert.match(html, /<code>co\*de\*<\/code>/);
  assert.match(html, /<ol><li>one<\/li><li>two<ul><li>nested<\/li><\/ul><\/li><\/ol>/, 'a blank line does not restart the numbering');
  assert.match(html, /md-task done/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>const a = &quot;&lt;b&gt;&quot;;<\/code><\/pre>/);
  assert.match(html, /<th>A<\/th>.*<td>2<\/td>/);
  assert.doesNotMatch(md('snake_case_name and 2 * 3 * 4'), /<em>/);
});

test('what is typed in a note cannot become markup, and remote images stay links', () => {
  for (const evil of ['<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '![x](attachment:a_00000000" onerror="alert(1))', '| <script> | b |\n|---|---|\n| c | d |']) {
    const html = md(evil, { attachment: () => null });
    assert.doesNotMatch(html, /<img|<script|href="javascript/i, evil);
  }
  const remote = md('![pixel](https://example.com/p.png)');
  assert.doesNotMatch(remote, /<img/);
  assert.match(remote, /<a href="https:\/\/example\.com\/p\.png"/);
  assert.doesNotThrow(() => md('>'.repeat(5000) + ' deep'));
});

test('an attachment link shows the image, the file, or that it was removed', () => {
  const files = (id) => ({ a_11111111: { name: 'shot.png', url: '/api/attachments/a_11111111', image: true }, a_22222222: { name: 'log.txt', url: '/api/attachments/a_22222222', image: false } })[id];
  assert.match(md('![shot](attachment:a_11111111)', { attachment: files }), /<img src="\/api\/attachments\/a_11111111"/);
  assert.match(md('[log](attachment:a_22222222)', { attachment: files }), /<a class="md-file" href="\/api\/attachments\/a_22222222" download="log\.txt"/);
  assert.match(md('![gone](attachment:a_33333333)', { attachment: files }), /md-gone/);
});

test('an image is uploaded, served, and readable by Claude from its path', async () => {
  const card = store.apply('card.create', { title: 'With a screenshot' });
  const up = await upload(card.id, 'screen shot.png', PNG);
  assert.equal(up.status, 200);
  const att = up.json.result;
  assert.equal(att.type, 'image/png');
  assert.equal(att.name, 'screen shot.png');
  assert.ok(up.json.state.cards.find((c) => c.id === card.id).attachments.some((f) => f.id === att.id));

  const got = await request('GET', `/api/attachments/${att.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.match(got.headers['content-disposition'], /^inline/);
  assert.ok(got.data.equals(PNG));

  store.apply('note.add', { card: card.id, text: `First line\n- a point\n\n![shot](attachment:${att.id})` });
  const state = view.buildState(store.load(), { sessions: [], groups: [], scannedAt: 0 });
  const text = view.cardMarkdown(state.cards.find((c) => c.id === card.id), state);
  const file = store.attachmentFile(att);
  assert.ok(text.includes(`## Attachments`));
  assert.ok(text.includes(`![shot](${file})`), 'the note links the file on disk');
  assert.ok(text.includes('First line\n  - a point'), 'the note keeps its lines');
  assert.ok(fs.existsSync(file));
});

test('anything that is not a real image is only ever a download', async () => {
  const card = store.apply('card.create', { title: 'Hostile files' });
  for (const [name, body] of [['page.html', '<script>alert(1)</script>'], ['fake.png', '<script>alert(1)</script>'], ['x.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>']]) {
    const up = await upload(card.id, name, Buffer.from(body));
    assert.equal(up.json.result.type, '', name);
    const got = await request('GET', `/api/attachments/${up.json.result.id}`);
    assert.equal(got.headers['content-type'], 'application/octet-stream', name);
    assert.match(got.headers['content-disposition'], /^attachment/, name);
    assert.equal(got.headers['x-content-type-options'], 'nosniff');
    assert.match(got.headers['content-security-policy'], /sandbox/);
  }
});

test('a file name cannot choose where the bytes go', async () => {
  const card = store.apply('card.create', { title: 'Odd names' });
  const up = await upload(card.id, '../../evil\n.sh', Buffer.from('data'));
  assert.equal(up.json.result.name, 'evil.sh');
  assert.equal(path.dirname(store.attachmentFile(up.json.result)), P.ATTACH_DIR);
  assert.equal((await request('GET', '/api/attachments/..%2F..%2Fboard.json')).status, 404);
});

test('uploads from another site, of the wrong type, empty or too large are refused', async () => {
  const card = store.apply('card.create', { title: 'Refusals' });
  assert.equal((await upload(card.id, 'a.png', PNG, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await upload(card.id, 'a.png', PNG, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await upload(card.id, 'a.png', Buffer.alloc(0))).status, 400);
  assert.throws(() => attachments.add(card.id, 'big.bin', Buffer.alloc(attachments.MAX_BYTES + 1)), /25 MB/);
  assert.equal(store.findCard(store.load(), card.id).attachments.length, 0);
});

test('a browser can reuse its copy of a file only while the file still exists', async () => {
  const card = store.apply('card.create', { title: 'Cached' });
  const att = (await upload(card.id, 'shot.png', PNG)).json.result;
  const first = await request('GET', `/api/attachments/${att.id}`);
  assert.match(first.headers['cache-control'], /no-cache/);
  const again = await request('GET', `/api/attachments/${att.id}`, { headers: { 'if-none-match': first.headers.etag } });
  assert.equal(again.status, 304);
  await request('POST', '/api/op', { body: JSON.stringify({ name: 'attachment.remove', args: { card: card.id, attachment: att.id } }), headers: { 'content-type': 'application/json' } });
  const gone = await request('GET', `/api/attachments/${att.id}`, { headers: { 'if-none-match': first.headers.etag } });
  assert.equal(gone.status, 404);
});

test('removing an attachment, or its card, deletes the file', async () => {
  const card = store.apply('card.create', { title: 'Short lived' });
  const one = attachments.add(card.id, 'one.txt', Buffer.from('1'));
  const two = attachments.add(card.id, 'two.txt', Buffer.from('2'));
  store.apply('attachment.remove', { card: card.id, attachment: one.id });
  assert.equal(fs.existsSync(store.attachmentFile(one)), false);
  assert.equal(fs.existsSync(store.attachmentFile(two)), true);
  store.apply('card.delete', { card: card.id });
  assert.equal(fs.existsSync(store.attachmentFile(two)), false);
});
