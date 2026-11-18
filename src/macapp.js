'use strict';
// Builds Taskboard.app from the two Swift files in ../macapp and puts it in
// ~/Applications. Needs the Swift compiler that comes with Xcode; without it
// the board still works in the browser and from `taskboard`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SOURCE = path.join(__dirname, '..', 'macapp');
const APP = path.join(os.homedir(), 'Applications', 'Taskboard.app');
const BUNDLE_ID = 'local.taskboard.app';

const INFO_PLIST = (version) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Taskboard</string>
  <key>CFBundleDisplayName</key><string>Taskboard</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>Taskboard</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>A local board over your Claude sessions.</string>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>Taskboard</string>
    <key>CFBundleURLSchemes</key><array><string>taskboard</string></array>
  </dict></array>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed:\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-12).join('\n')}`);
  return r.stdout;
}

function available() {
  if (process.platform !== 'darwin') return false;
  return spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0;
}

const installed = () => fs.existsSync(path.join(APP, 'Contents', 'MacOS', 'Taskboard'));

function isRunning() {
  return spawnSync('pgrep', ['-x', 'Taskboard'], { encoding: 'utf8' }).status === 0;
}

function quit() {
  if (!isRunning()) return false;
  spawnSync('pkill', ['-x', 'Taskboard']);
  for (let i = 0; i < 30 && isRunning(); i++) spawnSync('sleep', ['0.1']);
  return true;
}

/** Compile, sign and install the app. Returns its path. */
function build() {
  if (!available()) throw new Error('The Swift compiler is not installed (it comes with Xcode), so the Mac app was not built.');
  const version = require('../package.json').version;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-app-'));
  try {
    const bundle = path.join(work, 'Taskboard.app');
    const contents = path.join(bundle, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'Info.plist'), INFO_PLIST(version));

    const iconTool = path.join(work, 'icon');
    const iconset = path.join(work, 'AppIcon.iconset');
    run('xcrun', ['swiftc', '-O', '-swift-version', '5', path.join(SOURCE, 'icon.swift'), '-o', iconTool]);
    run(iconTool, [iconset]);
    run('iconutil', ['-c', 'icns', iconset, '-o', path.join(contents, 'Resources', 'AppIcon.icns')]);

    run('xcrun', ['swiftc', '-O', '-swift-version', '5', path.join(SOURCE, 'main.swift'), '-o', path.join(contents, 'MacOS', 'Taskboard')]);
    run('codesign', ['--force', '--sign', '-', bundle]); // signed for this Mac only

    const wasRunning = quit();
    fs.mkdirSync(path.dirname(APP), { recursive: true });
    fs.rmSync(APP, { recursive: true, force: true });
    fs.cpSync(bundle, APP, { recursive: true });
    spawnSync('touch', [APP]); // so Finder and the Dock pick up a changed icon
    return { path: APP, wasRunning };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function remove() {
  quit();
  fs.rmSync(APP, { recursive: true, force: true });
}

/** Bring the app forward, optionally at a place: "card/TB-3", "needs", … */
function open(place) {
  if (place) return spawnSync('open', [`taskboard://${place}`]).status === 0;
  return spawnSync('open', [APP]).status === 0;
}

module.exports = { APP, available, installed, isRunning, build, remove, open, quit };
