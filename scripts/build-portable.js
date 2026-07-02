// Build RelayManager release packages.
// Modes:
//   portable: bundles runtime/node and uses the portable startup script.
//   system: excludes runtime/node and uses the system Node.js startup script.
//
// The package is built from a whitelist so local keys, logs, backups, and temp
// files are not copied into release zips.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');

const START_PORTABLE = '\u542f\u52a8.bat';
const START_SYSTEM_NODE = '\u542f\u52a8-\u7cfb\u7edfNode.bat';
const STOP_BAT = '\u505c\u6b62.bat';
const BUILD_PORTABLE_BAT = '\u6253\u5305\u4fbf\u643a\u7248.bat';
const BUILD_SYSTEM_NODE_BAT = '\u6253\u5305\u7cfb\u7edfNode\u7248.bat';

const MODES = {
  portable: {
    packageName: 'RelayManager-Portable',
    startup: START_PORTABLE,
    buildEntry: BUILD_PORTABLE_BAT,
    includeRuntime: true,
  },
  system: {
    packageName: 'RelayManager-SystemNode',
    startup: START_SYSTEM_NODE,
    buildEntry: BUILD_SYSTEM_NODE_BAT,
    includeRuntime: false,
  },
};

const modeName = normalizeMode(process.argv[2] || 'portable');
const mode = MODES[modeName];
const stagingRoot = path.join(root, 'dist', mode.packageName);
const zipPath = path.join(root, mode.packageName + '.zip');

const commonFiles = [
  'server.js',
  'index.html',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  STOP_BAT,
  mode.startup,
  mode.buildEntry,
];

const commonDirs = [
  'lib',
  'scripts',
  'node_modules/@iarna/toml',
];

function normalizeMode(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (clean === 'portable' || clean === 'system') return clean;
  throw new Error('Unsupported package mode: ' + value + '. Use portable or system.');
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function removeEmptyDir(targetPath) {
  if (fs.existsSync(targetPath) && fs.readdirSync(targetPath).length === 0) {
    fs.rmdirSync(targetPath);
  }
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function copyFile(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(stagingRoot, relativePath);
  if (!fs.existsSync(source)) {
    throw new Error('Missing required file: ' + relativePath);
  }
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function shouldSkip(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (normalized === 'RelayManager-Portable.zip') return true;
  if (normalized === 'RelayManager-SystemNode.zip') return true;
  if (normalized.startsWith('backups/')) return true;
  if (normalized.startsWith('dist/')) return true;
  if (normalized.startsWith('.git/')) return true;
  if (normalized.endsWith('.log')) return true;
  if (/\.tmp(?:\.|$)/.test(normalized)) return true;
  if (/\.bak(?:\.|_|-)?/.test(normalized)) return true;

  const blockedRootFiles = new Set([
    '.env',
    '.env.local',
    'gateway.json',
    'paths.json',
    'cc-configs.json',
    'codex-cli-configs.json',
    'codex-desktop-configs.json',
    'codex-cli-proxy.json',
    'ui-settings.json',
  ]);

  return blockedRootFiles.has(normalized);
}

function copyDir(relativeDir) {
  const sourceDir = path.join(root, relativeDir);
  if (!fs.existsSync(sourceDir)) {
    throw new Error('Missing required directory: ' + relativeDir);
  }

  const stack = [sourceDir];
  while (stack.length) {
    const current = stack.pop();
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const source = path.join(current, item.name);
      const relativePath = path.relative(root, source);
      if (shouldSkip(relativePath)) continue;
      const target = path.join(stagingRoot, relativePath);
      if (item.isDirectory()) {
        ensureDir(target);
        stack.push(source);
      } else if (item.isFile()) {
        ensureDir(path.dirname(target));
        fs.copyFileSync(source, target);
      }
    }
  }
}

function compressStaging() {
  const archiveScript = [
    '$ErrorActionPreference = "Stop"',
    'Compress-Archive -LiteralPath ' + quotePs(stagingRoot) + ' -DestinationPath ' + quotePs(zipPath) + ' -Force',
  ].join('; ');

  execFileSync('powershell', ['-NoProfile', '-Command', archiveScript], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
}

function quotePs(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function main() {
  console.log('Building ' + mode.packageName + '...');

  removePath(stagingRoot);
  removePath(zipPath);
  ensureDir(stagingRoot);

  for (const file of commonFiles) {
    if (!shouldSkip(file)) copyFile(file);
  }

  for (const dir of commonDirs) {
    copyDir(dir);
  }

  if (mode.includeRuntime) {
    copyDir('runtime/node');
  }

  compressStaging();
  removePath(stagingRoot);
  removeEmptyDir(path.dirname(stagingRoot));

  const sizeMb = fs.statSync(zipPath).size / 1024 / 1024;
  console.log('Generated: ' + path.basename(zipPath));
  console.log('Size: ' + sizeMb.toFixed(2) + ' MB');
  console.log('Output: ' + zipPath);
}

main();
