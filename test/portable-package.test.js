// Package rule tests for both release variants.
// Uses Unicode escapes for Chinese filenames so the test is stable across shells.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');

const START_PORTABLE = '\u542f\u52a8.bat';
const START_SYSTEM_NODE = '\u542f\u52a8-\u7cfb\u7edfNode.bat';
const STOP_BAT = '\u505c\u6b62.bat';
const BUILD_PORTABLE_BAT = '\u6253\u5305\u4fbf\u643a\u7248.bat';
const BUILD_SYSTEM_NODE_BAT = '\u6253\u5305\u7cfb\u7edfNode\u7248.bat';

let pass = 0;
let fail = 0;

function check(name, ok) {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name);
  ok ? pass++ : fail++;
}

function readText(file) {
  const filePath = path.join(root, file);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function listZipEntries(zipName) {
  const zipPath = path.join(root, zipName);
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')`,
    'try {',
    '  $zip.Entries | ForEach-Object { $_.FullName }',
    '} finally {',
    '  $zip.Dispose()',
    '}',
  ].join('\n');
  const output = execFileSync('powershell', ['-NoProfile', '-Command', script], {
    cwd: root,
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .map(v => v.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function checkZipPackage(label, zipName, rootDir, rules) {
  const zipPath = path.join(root, zipName);
  check(`${label} zip exists`, fs.existsSync(zipPath));
  if (!fs.existsSync(zipPath)) return;

  const entries = listZipEntries(zipName);
  const has = pattern => entries.some(entry => pattern.test(entry));
  const lacks = pattern => !entries.some(entry => pattern.test(entry));
  const escRoot = rootDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const item of rules.mustHave) {
    check(`${label} includes ${item}`, has(new RegExp('^' + escRoot + '/' + item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')));
  }

  for (const pattern of rules.mustLack) {
    check(`${label} excludes ${pattern}`, lacks(new RegExp('^' + escRoot + '/' + pattern)));
  }

  check(`${label} excludes backups`, lacks(new RegExp('^' + escRoot + '/backups/')));
  check(`${label} excludes logs`, lacks(/\.log$/));
  check(`${label} excludes gateway.json`, lacks(new RegExp('^' + escRoot + '/gateway\\.json$')));
  check(`${label} excludes paths.json`, lacks(new RegExp('^' + escRoot + '/paths\\.json$')));
  check(`${label} excludes cc-configs.json`, lacks(new RegExp('^' + escRoot + '/cc-configs\\.json$')));
  check(`${label} excludes codex-cli-configs.json`, lacks(new RegExp('^' + escRoot + '/codex-cli-configs\\.json$')));
  check(`${label} excludes codex-desktop-configs.json`, lacks(new RegExp('^' + escRoot + '/codex-desktop-configs\\.json$')));
  check(`${label} excludes temp files`, lacks(/\.tmp(?:\.|$)/));
  check(`${label} excludes git directory`, lacks(new RegExp('^' + escRoot + '/\\.git/')));
}

check('portable Windows build entry exists', fs.existsSync(path.join(root, BUILD_PORTABLE_BAT)));
check('system Node Windows build entry exists', fs.existsSync(path.join(root, BUILD_SYSTEM_NODE_BAT)));
check('system Node startup entry exists', fs.existsSync(path.join(root, START_SYSTEM_NODE)));
check('Node package script exists', fs.existsSync(path.join(root, 'scripts', 'build-portable.js')));

check('portable build entry runs portable check', /portable:check/i.test(readText(BUILD_PORTABLE_BAT)));
check('portable build entry calls package builder in portable mode', /scripts\\build-portable\.js\s+portable/i.test(readText(BUILD_PORTABLE_BAT)));
check('system Node build entry calls package builder in system mode', /scripts\\build-portable\.js\s+system/i.test(readText(BUILD_SYSTEM_NODE_BAT)));
check('system Node startup uses system node command', /^\s*node\s+server\.js\s*$/mi.test(readText(START_SYSTEM_NODE)));
check('system Node startup does not require runtime node.exe', !/runtime\\node\\node\.exe/i.test(readText(START_SYSTEM_NODE)));

checkZipPackage('portable package', 'RelayManager-Portable.zip', 'RelayManager-Portable', {
  mustHave: [
    'server.js',
    'index.html',
    START_PORTABLE,
    STOP_BAT,
    'runtime/node/node.exe',
    'node_modules/@iarna/toml/package.json',
    'package.json',
  ],
  mustLack: [
    START_SYSTEM_NODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
  ],
});

checkZipPackage('system Node package', 'RelayManager-SystemNode.zip', 'RelayManager-SystemNode', {
  mustHave: [
    'server.js',
    'index.html',
    START_SYSTEM_NODE,
    STOP_BAT,
    'node_modules/@iarna/toml/package.json',
    'package.json',
  ],
  mustLack: [
    'runtime/node/',
    START_PORTABLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
  ],
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
