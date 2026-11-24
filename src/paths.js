'use strict';
// Every location the board reads from or writes to. The three roots can be
// overridden with environment variables, which is how the tests run against
// fixtures instead of the real Claude folders.
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.TASKBOARD_CLAUDE_DIR || path.join(HOME, '.claude');
const DESKTOP_DIR =
  process.env.TASKBOARD_DESKTOP_DIR || path.join(HOME, 'Library', 'Application Support', 'Claude');
const DATA_DIR = process.env.TASKBOARD_DATA_DIR || path.join(CLAUDE_DIR, 'taskboard');
const PORT = parseInt(process.env.TASKBOARD_PORT || '4780', 10);

module.exports = {
  HOME,
  CLAUDE_DIR,
  DESKTOP_DIR,
  DATA_DIR,
  PORT,
  HOST: '127.0.0.1',
  // written by the board
  BOARD_FILE: path.join(DATA_DIR, 'board.json'),
  BACKUP_DIR: path.join(DATA_DIR, 'backups'),
  CARDS_DIR: path.join(DATA_DIR, 'cards'),
  OVERVIEW_FILE: path.join(DATA_DIR, 'BOARD.md'),
  CACHE_DIR: path.join(DATA_DIR, 'cache'),
  DIARY_DIR: path.join(DATA_DIR, 'diary'),
  ATTACH_DIR: path.join(DATA_DIR, 'attachments'),
  LOG_FILE: path.join(DATA_DIR, 'server.log'),
  PID_FILE: path.join(DATA_DIR, 'server.pid'),
  // read from Claude (never written)
  DESKTOP_SESSIONS_DIR: path.join(DESKTOP_DIR, 'claude-code-sessions'),
  DESKTOP_CONFIG: path.join(DESKTOP_DIR, 'claude_desktop_config.json'),
  PROJECTS_DIR: path.join(CLAUDE_DIR, 'projects'),
  LIVE_DIR: path.join(CLAUDE_DIR, 'sessions'),
  HISTORY_FILE: path.join(CLAUDE_DIR, 'history.jsonl'),
  boardUrl: (hash) => `http://127.0.0.1:${PORT}/${hash ? '#' + hash : ''}`,
};
