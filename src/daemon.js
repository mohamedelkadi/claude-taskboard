'use strict';
// Starting, finding and stopping the board's web server as a background
// process. Used by the CLI, and by the MCP server so the board comes up on its
// own whenever a Claude session starts.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./paths');

function health(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: P.HOST, port: P.PORT, path: '/api/health', timeout: timeoutMs || 600 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j && j.app === 'taskboard' ? j : null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function start() {
  const up = await health();
  if (up) return { started: false, pid: up.pid };
  fs.mkdirSync(P.DATA_DIR, { recursive: true });
  const log = fs.openSync(P.LOG_FILE, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    detached: true,
    stdio: ['ignore', log, log],
    cwd: P.DATA_DIR,
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const h = await health(400);
    if (h) return { started: true, pid: h.pid };
  }
  throw new Error(`The board server did not come up. See ${P.LOG_FILE}.`);
}

async function stop() {
  const up = await health();
  if (!up) return { stopped: false };
  try {
    process.kill(up.pid, 'SIGTERM');
  } catch (_) {}
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!(await health(300))) return { stopped: true, pid: up.pid };
  }
  return { stopped: false, pid: up.pid };
}

module.exports = { health, start, stop };
