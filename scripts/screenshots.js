#!/usr/bin/env node
'use strict';
// Retakes the README screenshots (docs/screenshots/*.png) from the demo board
// with headless Chrome. Needs Node 22+ and Chrome; set CHROME=/path/to/chrome
// if it is not in /Applications.
//
//   node scripts/screenshots.js [name ...]     e.g. `node scripts/screenshots.js card`
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4782;
const DEBUG_PORT = 9339;
const BOARD = `http://127.0.0.1:${PORT}/`;
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// `run` is evaluated in the page after it has loaded, to open what the shot is about.
const clickSub = (text) => `[...document.querySelectorAll('.sub-title[data-act="sub-toggle"]')].find((e) => e.textContent.includes(${JSON.stringify(text)}))?.click()`;
const scrollPanelToEnd = `for (const e of [document.getElementById('drawer'), ...document.querySelectorAll('#drawer *')]) if (e.scrollHeight > e.clientHeight + 40) e.scrollTop = e.scrollHeight`;
const SHOTS = [
  { name: 'board', hash: '', width: 1440, height: 760 },
  { name: 'card', hash: 'card=TB-8', width: 1440, height: 1000, run: clickSub('card picker') },
  { name: 'card-connections', hash: 'card=TB-8', width: 1440, height: 860, run: `S.showAuto = true; renderWhenSafe(); setTimeout(() => { ${scrollPanelToEnd} }, 300)` },
  { name: 'needs-me', hash: 'needs', width: 1440, height: 700 },
  { name: 'sessions', hash: 'sessions', width: 1440, height: 860, run: `S.sessScope = 'all'; renderWhenSafe()` },
  { name: 'connections', hash: 'graph', width: 1440, height: 760, settle: 4000 },
  { name: 'board-light', hash: '', width: 1440, height: 760, theme: 'light' },
  { name: 'in-claude-pane', hash: 'needs', width: 420, height: 860 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn) {
  for (let i = 0; i < 100; i++) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const only = process.argv.slice(2);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-shots-'));
  const demo = spawn(process.execPath, [path.join(__dirname, 'demo.js')], { env: { ...process.env, TASKBOARD_DEMO_PORT: String(PORT) }, stdio: 'ignore' });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  try {
    await until('the demo board', () => fetch(`${BOARD}api/health`).then((r) => r.ok));
    const target = await until('Chrome', () => fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')));

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
    const waiting = new Map();
    let seq = 0;
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) (msg.error ? waiting.get(msg.id).reject(new Error(msg.error.message)) : waiting.get(msg.id).resolve(msg.result));
    };
    const cdp = (method, params = {}) => new Promise((resolve, reject) => (waiting.set(++seq, { resolve, reject }), ws.send(JSON.stringify({ id: seq, method, params }))));
    const evaluate = (expression) => cdp('Runtime.evaluate', { expression, returnByValue: true }).then((r) => r.result.value);

    fs.mkdirSync(OUT, { recursive: true });
    for (const shot of SHOTS) {
      if (only.length && !only.includes(shot.name)) continue;
      await cdp('Emulation.setDeviceMetricsOverride', { width: shot.width, height: shot.height, deviceScaleFactor: 2, mobile: false });
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: shot.theme || 'dark' }] });
      await cdp('Page.navigate', { url: 'about:blank' });
      await cdp('Page.navigate', { url: BOARD + (shot.hash ? '#' + shot.hash : '') });
      await until(`${shot.name} to render`, () => evaluate(`typeof S !== 'undefined' && !!S.data`));
      await sleep(600);
      if (shot.run) await evaluate(shot.run);
      await sleep(shot.settle || 900);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${shot.name}.png`), Buffer.from(data, 'base64'));
      console.log(`docs/screenshots/${shot.name}.png`);
    }
    ws.close();
  } finally {
    const gone = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    demo.kill('SIGINT');
    await Promise.race([gone, sleep(3000)]);
    // Chrome's helpers can still be writing to the profile for a moment; a
    // leftover temp folder is not worth failing the run for
    for (let i = 0; i < 25; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        break;
      } catch (_) {
        await sleep(200);
      }
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
