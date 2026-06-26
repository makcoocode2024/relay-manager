const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const toml = require('@iarna/toml');
const net = require('net');
const debugLog = require('./lib/debugLog');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) || 9876 : 9876;

// ========== PLATFORM DETECTION ==========
// Requirement #5: cross-platform Windows / macOS. We branch on process.platform
// for config paths (AppData vs ~/Library), process management (tasklist/taskkill
// vs pgrep/pkill), app launching (spawn exe vs `open -a`), and autostart
// (Startup-folder VBS vs LaunchAgents plist).
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
// os.homedir() works on every platform; USERPROFILE was Windows-only.
const HOME = os.homedir();

// ========== CONFIG FILE PATHS ==========
// Codex paths live under ~/.codex on all platforms. Claude Desktop 3P and Codex
// Desktop store data in OS-specific app-data dirs, so those branch by platform.
function macAppSupport(...parts) {
  return path.join(HOME, 'Library', 'Application Support', ...parts);
}

const PATHS = (() => {
  const codexCli = path.join(HOME, '.codex', 'config.toml');
  const claudeCode = path.join(HOME, '.claude', 'settings.json');
  const proxyEnv = path.join(HOME, '.codex', '.env');
  const codexCliStore = path.join(__dirname, 'codex-cli-configs.json');
  const codexDesktopStore = path.join(__dirname, 'codex-desktop-configs.json');

  if (IS_WIN) {
    return {
      claudeCode,
      claudeDesktopMeta: path.join(HOME, 'AppData', 'Local', 'Claude-3p', 'configLibrary', '_meta.json'),
      claudeDesktopDir: path.join(HOME, 'AppData', 'Local', 'Claude-3p', 'configLibrary'),
      codexCli,
      codexCliStore,
      codexDesktopConfig: path.join(HOME, 'AppData', 'Roaming', 'ccx-desktop', '.config', 'config.json'),
      codexDesktopInjection: path.join(HOME, 'AppData', 'Roaming', 'ccx-desktop', 'agent-config-state', 'codex.json'),
      codexDesktopStore,
      proxyEnv,
      clashVergeDir: 'C:\\Program Files\\Clash Verge',
    };
  }
  // macOS (and Linux fallback to mac-like layout)
  return {
    claudeCode,
    claudeDesktopMeta: macAppSupport('Claude-3p', 'configLibrary', '_meta.json'),
    claudeDesktopDir: macAppSupport('Claude-3p', 'configLibrary'),
    codexCli,
    codexCliStore,
    codexDesktopConfig: macAppSupport('ccx-desktop', '.config', 'config.json'),
    codexDesktopInjection: macAppSupport('ccx-desktop', 'agent-config-state', 'codex.json'),
    codexDesktopStore,
    proxyEnv,
    clashVergeDir: '/Applications/Clash Verge.app',
  };
})();

// Find clash-verge exe (platform-specific)
let clashExe = '';
if (IS_WIN) {
  clashExe = path.join(PATHS.clashVergeDir, 'Clash Verge.exe');
  if (!fs.existsSync(clashExe)) {
    const alt = path.join(PATHS.clashVergeDir, 'clash-verge.exe');
    if (fs.existsSync(alt)) clashExe = alt;
  }
} else if (IS_MAC) {
  // On macOS the .app bundle is launched via `open -a`; record the bundle path.
  clashExe = PATHS.clashVergeDir;
  if (!fs.existsSync(clashExe)) {
    const alt = path.join(HOME, 'Applications', 'Clash Verge.app');
    if (fs.existsSync(alt)) clashExe = alt;
  }
}

// ========== APP RESTART PATHS ==========
// Auto-detected defaults; user can override via paths.json (GET/POST /api/paths)
function detectExe(candidates) {
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return null;
}

const APPS = IS_WIN ? {
  'claude-desktop': {
    name: 'Claude Desktop',
    processes: ['Claude.exe', 'Claude Desktop.exe'],
    exe: detectExe([
      path.join(HOME, 'AppData', 'Local', 'Claude-3p', 'Claude.exe'),
      path.join(HOME, 'AppData', 'Local', 'Claude', 'Claude.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Claude-3p', 'Claude.exe'),
    ]),
  },
  'codex-desktop': {
    name: 'Codex Desktop',
    processes: ['ccx-desktop.exe'],
    exe: detectExe([
      'G:\\Program Files\\CCX\\CCX Desktop\\ccx-desktop.exe',
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'CCX', 'CCX Desktop', 'ccx-desktop.exe'),
    ]),
  },
  'proxy': {
    name: 'Clash Verge',
    processes: ['clash-verge.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe'],
    exe: clashExe,
  },
} : {
  // macOS: processes are matched by name via pgrep; exe is the .app bundle for `open -a`.
  'claude-desktop': {
    name: 'Claude Desktop',
    processes: ['Claude'],
    exe: detectExe([
      '/Applications/Claude.app',
      path.join(HOME, 'Applications', 'Claude.app'),
    ]),
  },
  'codex-desktop': {
    name: 'Codex Desktop',
    processes: ['ccx-desktop', 'CCX Desktop'],
    exe: detectExe([
      '/Applications/CCX Desktop.app',
      path.join(HOME, 'Applications', 'CCX Desktop.app'),
    ]),
  },
  'proxy': {
    name: 'Clash Verge',
    processes: ['Clash Verge', 'verge-mihomo', 'clash-verge'],
    exe: clashExe || '/Applications/Clash Verge.app',
  },
};

// Load user-configured exe paths (overrides auto-detected)
const PATHS_CONFIG_FILE = path.join(__dirname, 'paths.json');
function loadPathsConfig() {
  try { return JSON.parse(fs.readFileSync(PATHS_CONFIG_FILE, 'utf-8')); }
  catch (e) { return {}; }
}
function applyPathsConfig() {
  const cfg = loadPathsConfig();
  for (const key of Object.keys(APPS)) {
    if (cfg[key] && fs.existsSync(cfg[key])) {
      APPS[key].exe = cfg[key];
      APPS[key].customPath = cfg[key];
    }
  }
}
applyPathsConfig();

function getAppsInfo() {
  return Object.fromEntries(Object.entries(APPS).map(([k, v]) => [k, {
    name: v.name, exe: v.exe || '', customPath: v.customPath || '', processes: v.processes,
  }]));
}

// ========== AUTO-START ON BOOT ==========
// Windows: a silent VBS in the Startup folder. macOS: a LaunchAgent plist in
// ~/Library/LaunchAgents loaded via launchctl.
const NODE_EXE = process.execPath;
const SERVER_JS_PATH = path.join(__dirname, 'server.js');

// --- Windows autostart ---
const STARTUP_DIR = path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const AUTOSTART_VBS = path.join(STARTUP_DIR, 'RelayManager.vbs');

// --- macOS autostart ---
const LAUNCH_AGENTS_DIR = path.join(HOME, 'Library', 'LaunchAgents');
const LAUNCH_AGENT_LABEL = 'com.relaymanager.autostart';
const AUTOSTART_PLIST = path.join(LAUNCH_AGENTS_DIR, LAUNCH_AGENT_LABEL + '.plist');

function isAutostartEnabled() {
  return IS_WIN ? fs.existsSync(AUTOSTART_VBS) : fs.existsSync(AUTOSTART_PLIST);
}

function enableAutostart() {
  if (IS_WIN) {
    fs.mkdirSync(STARTUP_DIR, { recursive: true });
    const cmd = `"${NODE_EXE}" "${SERVER_JS_PATH}"`;
    const vbsCmd = '"' + cmd.replace(/"/g, '""') + '"';
    const vbs = `' RelayManager auto-start (silent, no console window)\r\nCreateObject("WScript.Shell").Run ${vbsCmd}, 0, False\r\n`;
    fs.writeFileSync(AUTOSTART_VBS, vbs, 'utf-8');
    return;
  }
  // macOS LaunchAgent
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_EXE}</string>
    <string>${SERVER_JS_PATH}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
  fs.writeFileSync(AUTOSTART_PLIST, plist, 'utf-8');
  try { execSync(`launchctl load "${AUTOSTART_PLIST}" 2>/dev/null`, { timeout: 5000 }); } catch (e) { /* may already be loaded */ }
}

function disableAutostart() {
  if (IS_WIN) {
    try { if (fs.existsSync(AUTOSTART_VBS)) fs.unlinkSync(AUTOSTART_VBS); } catch (e) {}
    return;
  }
  try { execSync(`launchctl unload "${AUTOSTART_PLIST}" 2>/dev/null`, { timeout: 5000 }); } catch (e) {}
  try { if (fs.existsSync(AUTOSTART_PLIST)) fs.unlinkSync(AUTOSTART_PLIST); } catch (e) {}
}

// Backward-compat alias used by the autostart status endpoint.
const AUTOSTART_PATH = IS_WIN ? AUTOSTART_VBS : AUTOSTART_PLIST;

// ========== UTILITY FUNCTIONS ==========

function json(data, code = 200) {
  return { code, body: JSON.stringify(data, null, 2), type: 'application/json' };
}

function error(msg, code = 500) {
  return json({ error: msg }, code);
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Read JSON file, return null if not found
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Atomic write: write to .tmp then rename
async function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp.' + Date.now();
  await fsp.writeFile(tmp, content, 'utf-8');
  await fsp.rename(tmp, filePath);
}

// Keep at most this many timestamped backups per file; older ones are pruned.
const MAX_BACKUPS_PER_FILE = 20;

// Backup file with timestamp, then prune old backups so the dir can't grow forever.
async function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const backupDir = path.join(dir, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${base}-${timestamp()}${ext}`);
  await fsp.copyFile(filePath, backupPath);
  await pruneBackups(backupDir, base, ext);
  return backupPath;
}

// Delete oldest backups for one source file, keeping the newest MAX_BACKUPS_PER_FILE.
async function pruneBackups(backupDir, base, ext) {
  try {
    const prefix = base + '-';
    const mine = (await fsp.readdir(backupDir))
      .filter(f => f.startsWith(prefix) && f.endsWith(ext))
      .sort(); // timestamp format is lexicographically sortable (oldest first)
    const excess = mine.length - MAX_BACKUPS_PER_FILE;
    for (let i = 0; i < excess; i++) {
      await fsp.unlink(path.join(backupDir, mine[i])).catch(() => {});
    }
  } catch (e) { /* pruning is best-effort */ }
}

// ========== READ FUNCTIONS ==========

function readClaudeCode() {
  const obj = readJSON(PATHS.claudeCode);
  if (!obj || !obj.env) return { authToken: '', baseUrl: '', opusModel: '', sonnetModel: '', haikuModel: '', model: '', reasoningModel: '', subagentModel: '', apiTimeoutMs: '3000000', disableNonessential: '1', attributionHeader: '0', effortLevel: 'high', thinkingMode: 'adaptive', thinkingBudget: '10000' };
  return {
    authToken: obj.env.ANTHROPIC_AUTH_TOKEN || '',
    baseUrl: obj.env.ANTHROPIC_BASE_URL || '',
    opusModel: obj.env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
    sonnetModel: obj.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
    haikuModel: obj.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
    model: obj.env.ANTHROPIC_MODEL || obj.model || '',
    reasoningModel: obj.env.ANTHROPIC_REASONING_MODEL || '',
    subagentModel: obj.env.CLAUDE_CODE_SUBAGENT_MODEL || '',
    apiTimeoutMs: obj.env.API_TIMEOUT_MS || '3000000',
    disableNonessential: obj.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '1',
    attributionHeader: obj.env.CLAUDE_CODE_ATTRIBUTION_HEADER || '0',
    effortLevel: obj.env.CLAUDE_CODE_EFFORT_LEVEL || obj.effortLevel || 'high',
    thinkingMode: deriveThinkingMode(obj.env),
    thinkingBudget: obj.env.MAX_THINKING_TOKENS || '10000',
  };
}

// Map the thinking-related env vars back to one of three UI modes.
//   off      -> thinking disabled (MAX_THINKING_TOKENS=0 / DISABLE_INTERLEAVED_THINKING=1)
//   fixed    -> a fixed token budget (MAX_THINKING_TOKENS set to a positive number)
//   adaptive -> let the model/gateway decide (no explicit budget pinned)
function deriveThinkingMode(env) {
  const budget = env.MAX_THINKING_TOKENS;
  if (budget === '0' || env.DISABLE_INTERLEAVED_THINKING === '1') return 'off';
  if (budget && parseInt(budget) > 0) return 'fixed';
  return 'adaptive';
}

function readClaudeDesktop() {
  const meta = readJSON(PATHS.claudeDesktopMeta);
  if (!meta || !meta.appliedId) return { apiKey: '', baseUrl: '', authScheme: 'bearer', provider: 'gateway', models: '', egressHosts: '*', disableDeploymentChooser: true };
  const configPath = path.join(PATHS.claudeDesktopDir, `${meta.appliedId}.json`);
  const obj = readJSON(configPath);
  if (!obj) return { apiKey: '', baseUrl: '', authScheme: 'bearer', provider: 'gateway', models: '', egressHosts: '*', disableDeploymentChooser: true };
  return {
    apiKey: obj.inferenceGatewayApiKey || '',
    baseUrl: obj.inferenceGatewayBaseUrl || '',
    authScheme: obj.inferenceGatewayAuthScheme || 'bearer',
    provider: obj.inferenceProvider || 'gateway',
    models: obj.inferenceModels || '',
    egressHosts: (obj.coworkEgressAllowedHosts || ['*']).join(','),
    disableDeploymentChooser: obj.disableDeploymentModeChooser !== false,
    configId: meta.appliedId,
  };
}

function readCodexCli() {
  // 默认值（文件不存在时）。新增的高级字段一并给出空/默认值，保证前端表单不会拿到 undefined。
  if (!fs.existsSync(PATHS.codexCli)) return {
    baseUrl: '', apiKey: '', model: 'gpt-5.5', modelProvider: 'custom', providerName: 'My Codex',
    wireApi: 'responses', requiresOpenaiAuth: true, reasoningEffort: 'high',
    reasoningSummary: 'auto', verbosity: '', disableResponseStorage: false,
    httpHeaders: {}, requestMaxRetries: '', streamMaxRetries: '', streamIdleTimeoutMs: '',
    configId: '',
  };
  const raw = fs.readFileSync(PATHS.codexCli, 'utf-8');
  const obj = toml.parse(raw);
  // 用实际的 model_provider 值作为表键，与 writeCodexCli 保持对称；默认回退 'custom'。
  const providerKey = obj.model_provider || 'custom';
  const custom = (obj.model_providers && obj.model_providers[providerKey]) || {};
  // 数字字段可能不存在，统一转成字符串（空串=未设置），方便前端 input 显示。
  const numOrEmpty = (v) => (v === undefined || v === null ? '' : String(v));
  // 当 experimental_bearer_token 为空而 env_key 指向环境变量时，尝试从 .codex/.env 回退读取
  let apiKey = custom.experimental_bearer_token || '';
  if (!apiKey && custom.env_key && typeof custom.env_key === 'string') {
    try {
      const envRaw = fs.readFileSync(PATHS.proxyEnv, 'utf-8');
      const prefix = custom.env_key.trim() + '=';
      for (const line of envRaw.split('\n')) {
        if (line.startsWith(prefix)) { apiKey = line.slice(prefix.length).trim(); break; }
      }
    } catch (e) { /* .env 不存在或读取失败，保持空 */ }
  }
  return {
    baseUrl: custom.base_url || '',
    apiKey,
    model: obj.model || 'gpt-5.5',
    modelProvider: obj.model_provider || 'custom',
    providerName: custom.name || 'My Codex',
    wireApi: custom.wire_api || 'responses',
    requiresOpenaiAuth: custom.requires_openai_auth !== false,
    reasoningEffort: obj.model_reasoning_effort || 'high',
    // ===== 高级字段 =====
    reasoningSummary: obj.model_reasoning_summary || 'auto', // auto/concise/detailed/none
    verbosity: obj.model_verbosity || '',                    // ''=不设置；low/medium/high（GPT-5 responses）
    disableResponseStorage: obj.disable_response_storage === true, // 中转站不支持 responses 存储时置 true
    httpHeaders: (custom.http_headers && typeof custom.http_headers === 'object') ? custom.http_headers : {}, // 自定义请求头
    requestMaxRetries: numOrEmpty(custom.request_max_retries),
    streamMaxRetries: numOrEmpty(custom.stream_max_retries),
    streamIdleTimeoutMs: numOrEmpty(custom.stream_idle_timeout_ms),
    configId: obj.__configId || '',
  };
}

function readCodexDesktop() {
  const config = readJSON(PATHS.codexDesktopConfig);
  const injection = readJSON(PATHS.codexDesktopInjection);
  return {
    injectedBaseUrl: (injection && injection.injectedBaseUrl) || '',
    injectedApiKey: (injection && injection.injectedApiKey) || '',
    responsesUpstream: (config && config.responsesUpstream) || [],
    chatUpstream: (config && config.chatUpstream) || [],
    circuitBreaker: (config && config.circuitBreaker) || {},
    fuzzyModeEnabled: config ? !!config.fuzzyModeEnabled : true,
  };
}

function readProxy() {
  if (!fs.existsSync(PATHS.proxyEnv)) {
    return { httpProxy: '', httpsProxy: '', allProxy: '', noProxy: 'localhost,127.0.0.1,::1', wsProxy: '', wssProxy: '', proxyHost: '127.0.0.1', proxyPort: '7897' };
  }
  const raw = fs.readFileSync(PATHS.proxyEnv, 'utf-8');
  const result = { proxyHost: '127.0.0.1', proxyPort: '7897', noProxy: 'localhost,127.0.0.1,::1' };
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^["']|["']$/g, '');
    if (key === 'HTTP_PROXY') { result.httpProxy = val; try { const u = new URL(val); result.proxyHost = u.hostname; result.proxyPort = u.port; } catch(e){} }
    else if (key === 'HTTPS_PROXY') result.httpsProxy = val;
    else if (key === 'ALL_PROXY') result.allProxy = val;
    else if (key === 'NO_PROXY') result.noProxy = val;
    else if (key === 'WS_PROXY') result.wsProxy = val;
    else if (key === 'WSS_PROXY') result.wssProxy = val;
  }
  return result;
}

function readUiSettings() {
  const cfg = readJSON(path.join(__dirname, 'ui-settings.json')) || {};
  return {
    theme: ['classic', 'dashboard', 'modern', 'light'].includes(cfg.theme) ? cfg.theme : 'classic',
    sidebarLayout: ['classic', 'compact', 'sidebar'].includes(cfg.sidebarLayout) ? cfg.sidebarLayout : 'classic',
  };
}

async function writeUiSettings(data) {
  const filePath = path.join(__dirname, 'ui-settings.json');
  const cfg = readUiSettings();
  if (data && typeof data === 'object') {
    if (['classic', 'dashboard', 'modern', 'light'].includes(data.theme)) cfg.theme = data.theme;
    if (['classic', 'compact', 'sidebar'].includes(data.sidebarLayout)) cfg.sidebarLayout = data.sidebarLayout;
  }
  await backupFile(filePath);
  await atomicWrite(filePath, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

// ========== WRITE FUNCTIONS ==========
async function writeClaudeCode(data) {
  const filePath = PATHS.claudeCode;
  let obj = readJSON(filePath) || {};
  if (!obj.env) obj.env = {};

  // Input normalization: strip trailing slashes from Base URL, trim whitespace
  // from the key, so third-party gateways that are picky about exact URLs work.
  const baseUrl = (data.baseUrl || '').trim().replace(/\/+$/, '');
  const key = (data.authToken || '').trim();

  obj.env.ANTHROPIC_BASE_URL = baseUrl;
  // Dual auth: set BOTH so the request works whether the gateway expects a
  // Bearer token (ANTHROPIC_AUTH_TOKEN) or an x-api-key (ANTHROPIC_API_KEY).
  obj.env.ANTHROPIC_AUTH_TOKEN = key;
  obj.env.ANTHROPIC_API_KEY = key;

  if (data.opusModel) obj.env.ANTHROPIC_DEFAULT_OPUS_MODEL = data.opusModel;
  if (data.sonnetModel) obj.env.ANTHROPIC_DEFAULT_SONNET_MODEL = data.sonnetModel;
  if (data.haikuModel) obj.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = data.haikuModel;
  if (data.model) { obj.env.ANTHROPIC_MODEL = data.model; obj.model = data.model; }
  if (data.reasoningModel) obj.env.ANTHROPIC_REASONING_MODEL = data.reasoningModel;
  if (data.subagentModel !== undefined) obj.env.CLAUDE_CODE_SUBAGENT_MODEL = data.subagentModel;
  if (data.apiTimeoutMs !== undefined) obj.env.API_TIMEOUT_MS = String(data.apiTimeoutMs);
  // Note: values may arrive as the strings "0"/"1" (both truthy!), so compare explicitly.
  const truthy = v => v === true || v === '1' || v === 1;
  if (data.disableNonessential !== undefined) obj.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = truthy(data.disableNonessential) ? '1' : '0';
  if (data.attributionHeader !== undefined) obj.env.CLAUDE_CODE_ATTRIBUTION_HEADER = truthy(data.attributionHeader) ? '1' : '0';
  if (data.effortLevel) { obj.effortLevel = data.effortLevel; obj.env.CLAUDE_CODE_EFFORT_LEVEL = data.effortLevel; }

  // Thinking mode — three states to match third-party gateway compatibility.
  applyThinkingMode(obj.env, data.thinkingMode, data.thinkingBudget);

  await backupFile(filePath);
  await atomicWrite(filePath, JSON.stringify(obj, null, 2) + '\n');

  // Also write ~/.claude.json to skip the official login/onboarding wizard,
  // which otherwise errors out in unsupported regions with a third-party relay.
  await ensureClaudeOnboardingSkipped();
}

// Set/clear thinking-related env vars based on the chosen mode.
function applyThinkingMode(env, mode, budget) {
  if (mode === undefined) return; // not provided -> leave untouched
  // Clean slate, then set per mode.
  delete env.MAX_THINKING_TOKENS;
  delete env.DISABLE_INTERLEAVED_THINKING;
  if (mode === 'off') {
    // Hard-disable: some gateways reject the `thinking` field entirely.
    env.MAX_THINKING_TOKENS = '0';
    env.DISABLE_INTERLEAVED_THINKING = '1';
  } else if (mode === 'fixed') {
    const b = parseInt(budget);
    env.MAX_THINKING_TOKENS = String(Number.isFinite(b) && b > 0 ? b : 10000);
  }
  // 'adaptive' -> set nothing, let the model/gateway decide.
}

// Write ~/.claude.json with onboarding/login flags so the CLI doesn't prompt
// for an Anthropic login (which fails behind third-party relays / in some regions).
async function ensureClaudeOnboardingSkipped() {
  const dotClaude = path.join(HOME, '.claude.json');
  let obj = readJSON(dotClaude) || {};
  obj.hasCompletedOnboarding = true;
  if (!obj.numStartups || obj.numStartups < 1) obj.numStartups = 1;
  // Some CLI versions also key off a stored onboarding version.
  if (!obj.lastOnboardingVersion) obj.lastOnboardingVersion = '1.0.0';
  await backupFile(dotClaude);
  await atomicWrite(dotClaude, JSON.stringify(obj, null, 2) + '\n');
}

// Normalize a Base URL for Claude Desktop 3P: trim, prepend https:// if no
// scheme, strip trailing slashes. Never append /v1 or /messages — 3P passes the
// URL through verbatim, so we keep exactly what the user typed (minus cruft).
function normalizeBaseUrl(raw) {
  let v = (raw || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v.replace(/\/+$/, '');
}

// inferenceModels is a STRINGIFIED JSON array of {name} objects (real 3P format).
// Accept either that string or a plain array; trim each name, drop blanks.
function normalizeInferenceModels(models) {
  let arr = [];
  try {
    const parsed = typeof models === 'string' ? JSON.parse(models || '[]') : models;
    if (Array.isArray(parsed)) {
      arr = parsed
        .map(m => (typeof m === 'string' ? m : (m && m.name) || ''))
        .map(s => String(s).trim())
        .filter(Boolean)
        .map(name => ({ name }));
    }
  } catch (e) { arr = []; }
  return JSON.stringify(arr);
}

async function writeClaudeDesktop(data) {
  const meta = readJSON(PATHS.claudeDesktopMeta);
  if (!meta || !meta.appliedId) throw new Error('Claude Desktop 3P config not found (_meta.json missing)');
  const configId = meta.appliedId;
  const filePath = path.join(PATHS.claudeDesktopDir, `${configId}.json`);
  let obj = readJSON(filePath) || {};
  if (data.apiKey !== undefined) obj.inferenceGatewayApiKey = (data.apiKey || '').trim();
  if (data.baseUrl !== undefined) obj.inferenceGatewayBaseUrl = normalizeBaseUrl(data.baseUrl);
  if (data.authScheme !== undefined) obj.inferenceGatewayAuthScheme = data.authScheme;
  if (data.provider !== undefined) obj.inferenceProvider = data.provider || 'gateway';
  if (data.models !== undefined) obj.inferenceModels = normalizeInferenceModels(data.models);
  if (data.egressHosts !== undefined) obj.coworkEgressAllowedHosts = data.egressHosts.split(',').map(s => s.trim()).filter(Boolean);
  if (data.disableDeploymentChooser !== undefined) obj.disableDeploymentModeChooser = data.disableDeploymentChooser;
  await backupFile(filePath);
  await atomicWrite(filePath, JSON.stringify(obj, null, 2) + '\n');
}

// ========== CLAUDE DESKTOP 3P — MULTI-CONFIG MANAGEMENT ==========
// _meta.json = { appliedId, entries:[{id,name}] }; each config is <id>.json.
// Managing multiple gateways = managing that entries list + switching appliedId.

function readCDMeta() {
  return readJSON(PATHS.claudeDesktopMeta) || { appliedId: '', entries: [] };
}
async function writeCDMeta(meta) {
  if (!fs.existsSync(PATHS.claudeDesktopDir)) fs.mkdirSync(PATHS.claudeDesktopDir, { recursive: true });
  await backupFile(PATHS.claudeDesktopMeta);
  await atomicWrite(PATHS.claudeDesktopMeta, JSON.stringify(meta, null, 2) + '\n');
}
function cdConfigPath(id) { return path.join(PATHS.claudeDesktopDir, id + '.json'); }

// Whitelist to official fields only — custom fields make Claude Desktop reject
// the config. Accepts either raw inference* fields or the form's short names.
function sanitizeCDConfig(d) {
  d = d || {};
  const egress = Array.isArray(d.coworkEgressAllowedHosts)
    ? d.coworkEgressAllowedHosts
    : (typeof d.egressHosts === 'string'
        ? d.egressHosts.split(',').map(x => x.trim()).filter(Boolean)
        : (typeof d.allowedEgressHosts !== 'undefined' && Array.isArray(d.allowedEgressHosts) ? d.allowedEgressHosts : ['*']));
  return {
    coworkEgressAllowedHosts: egress.length ? egress : ['*'],
    disableDeploymentModeChooser: d.disableDeploymentModeChooser !== false,
    inferenceGatewayApiKey: String(d.inferenceGatewayApiKey || d.apiKey || '').trim(),
    inferenceGatewayAuthScheme: d.inferenceGatewayAuthScheme || d.authScheme || 'bearer',
    inferenceGatewayBaseUrl: normalizeBaseUrl(d.inferenceGatewayBaseUrl || d.baseUrl || ''),
    inferenceProvider: d.inferenceProvider || d.provider || 'gateway',
    inferenceModels: normalizeInferenceModels(d.inferenceModels || d.models || '[]'),
  };
}

function listCDConfigs() {
  const meta = readCDMeta();
  const entries = Array.isArray(meta.entries) ? meta.entries : [];
  const configs = entries.map(e => {
    const obj = readJSON(cdConfigPath(e.id)) || {};
    let models = [];
    try { models = JSON.parse(obj.inferenceModels || '[]').map(m => m.name || m); } catch (x) {}
    return {
      id: e.id, name: e.name || '(未命名)',
      baseUrl: obj.inferenceGatewayBaseUrl || '',
      authScheme: obj.inferenceGatewayAuthScheme || 'bearer',
      models, applied: e.id === meta.appliedId,
    };
  });
  return { appliedId: meta.appliedId || '', configs };
}

async function createCDConfig(name, configData) {
  const meta = readCDMeta();
  if (!Array.isArray(meta.entries)) meta.entries = [];
  const id = require('crypto').randomUUID();
  if (!fs.existsSync(PATHS.claudeDesktopDir)) fs.mkdirSync(PATHS.claudeDesktopDir, { recursive: true });
  await atomicWrite(cdConfigPath(id), JSON.stringify(sanitizeCDConfig(configData), null, 2) + '\n');
  meta.entries.push({ id, name: name || '新配置' });
  if (!meta.appliedId) meta.appliedId = id;   // first config becomes active
  await writeCDMeta(meta);
  return id;
}

async function applyCDConfig(id) {
  const meta = readCDMeta();
  if (!(meta.entries || []).some(e => e.id === id)) throw new Error('配置不存在: ' + id);
  meta.appliedId = id;
  await writeCDMeta(meta);
  return id;
}

async function deleteCDConfig(id) {
  const meta = readCDMeta();
  meta.entries = (meta.entries || []).filter(e => e.id !== id);
  try { if (fs.existsSync(cdConfigPath(id))) { await backupFile(cdConfigPath(id)); fs.unlinkSync(cdConfigPath(id)); } } catch (e) {}
  if (meta.appliedId === id) meta.appliedId = meta.entries[0] ? meta.entries[0].id : '';
  await writeCDMeta(meta);
  return meta.appliedId;
}

async function renameCDConfig(id, name) {
  const meta = readCDMeta();
  const e = (meta.entries || []).find(x => x.id === id);
  if (!e) throw new Error('配置不存在');
  e.name = name || e.name;
  await writeCDMeta(meta);
}

function exportCDConfig(id, stripKey) {
  const meta = readCDMeta();
  const e = (meta.entries || []).find(x => x.id === id);
  const obj = readJSON(cdConfigPath(id)) || {};
  // Optionally redact the API key so exported/shared config files don't leak secrets.
  if (stripKey && obj && obj.inferenceGatewayApiKey) {
    obj.inferenceGatewayApiKey = '';
  }
  return { name: e ? e.name : '导出配置', config: obj };
}

// ========== CLAUDE CODE CLI — MULTI-CONFIG (PRESET) MANAGEMENT ==========
// Claude Code 原生只有一个 ~/.claude/settings.json，没有官方的多配置库。
// 因此由 RelayManager 自己维护一份预设清单 cc-configs.json：
//   { appliedId, entries:[{id,name,config:{...CC 字段...}}] }
// “切换/应用”=把选中预设的 config 写进 settings.json（沿用 writeClaudeCode，
// 自动备份+原子写），从而符合既定工作流：填参→建映射→写客户端实际读取的配置。
// 该文件含密钥，已在 .gitignore 中忽略，禁止提交。
const CC_CONFIGS_PATH = path.join(__dirname, 'cc-configs.json');
const CODEX_CONFIGS_PATH = PATHS.codexCliStore;
const CXD_CONFIGS_PATH = PATHS.codexDesktopStore;

function readCCStore() {
  const obj = readJSON(CC_CONFIGS_PATH);
  if (!obj || !Array.isArray(obj.entries)) return { appliedId: '', entries: [] };
  return { appliedId: obj.appliedId || '', entries: obj.entries };
}
async function writeCCStore(store) {
  await backupFile(CC_CONFIGS_PATH);
  await atomicWrite(CC_CONFIGS_PATH, JSON.stringify(store, null, 2) + '\n');
}

// 只保留 Claude Code 认得的字段，防止导入脏数据污染预设。
function sanitizeCCConfig(d) {
  d = d || {};
  const str = v => (v === undefined || v === null) ? '' : String(v);
  return {
    baseUrl: str(d.baseUrl),
    authToken: str(d.authToken !== undefined ? d.authToken : d.apiKey),
    opusModel: str(d.opusModel),
    sonnetModel: str(d.sonnetModel),
    haikuModel: str(d.haikuModel),
    model: str(d.model),
    reasoningModel: str(d.reasoningModel),
    subagentModel: str(d.subagentModel),
    effortLevel: d.effortLevel || 'high',
    apiTimeoutMs: str(d.apiTimeoutMs || '3000000'),
    // 复选项可能以布尔或 '0'/'1' 传入，统一存成 '0'/'1' 字符串。
    disableNonessential: (d.disableNonessential === false || d.disableNonessential === '0' || d.disableNonessential === 0) ? '0' : '1',
    attributionHeader: (d.attributionHeader === '1' || d.attributionHeader === 1 || d.attributionHeader === true) ? '1' : '0',
    thinkingMode: ['adaptive', 'fixed', 'off'].includes(d.thinkingMode) ? d.thinkingMode : 'adaptive',
    thinkingBudget: str(d.thinkingBudget || '10000'),
  };
}

function listCCConfigs() {
  const store = readCCStore();
  const configs = store.entries.map(e => ({
    id: e.id,
    name: e.name || '(未命名)',
    baseUrl: (e.config && e.config.baseUrl) || '',
    applied: e.id === store.appliedId,
  }));
  return { appliedId: store.appliedId || '', configs };
}

async function createCCConfig(name, configData) {
  const store = readCCStore();
  const id = require('crypto').randomUUID();
  store.entries.push({ id, name: name || '新配置', config: sanitizeCCConfig(configData) });
  if (!store.appliedId) store.appliedId = id; // 第一份预设默认生效
  await writeCCStore(store);
  return id;
}

// 应用预设：标记 appliedId 并把内容写入 Claude Code 实际读取的 settings.json。
async function applyCCConfig(id) {
  const store = readCCStore();
  const e = store.entries.find(x => x.id === id);
  if (!e) throw new Error('配置不存在: ' + id);
  store.appliedId = id;
  await writeCCStore(store);
  await writeClaudeCode(e.config || {}); // 沿用既有写入逻辑（含备份+跳过引导）
  return id;
}

// 更新预设内容（保存表单时让“生效中”的预设与 settings.json 保持一致）。
async function updateCCConfig(id, configData) {
  const store = readCCStore();
  const e = store.entries.find(x => x.id === id);
  if (!e) throw new Error('配置不存在: ' + id);
  e.config = sanitizeCCConfig(configData);
  await writeCCStore(store);
  if (store.appliedId === id) {
    await writeClaudeCode(e.config || {});
  }
  return id;
}

async function deleteCCConfig(id) {
  const store = readCCStore();
  store.entries = store.entries.filter(e => e.id !== id);
  if (store.appliedId === id) store.appliedId = ''; // 删除生效预设后，无预设再与 settings.json 对应
  await writeCCStore(store);
  return store.appliedId;
}

async function renameCCConfig(id, name) {
  const store = readCCStore();
  const e = store.entries.find(x => x.id === id);
  if (!e) throw new Error('配置不存在');
  e.name = (name || '').trim() || e.name;
  await writeCCStore(store);
}

function exportCCConfig(id, stripKey) {
  const store = readCCStore();
  const e = store.entries.find(x => x.id === id);
  const config = e ? Object.assign({}, e.config) : {};
  // 分享时可去除密钥，避免泄露。
  if (stripKey) config.authToken = '';
  return { name: e ? e.name : '导出配置', config };
}

// ========== CODEX CLI — 多套配置（预设）管理 ==========
// Codex CLI 原生只有一个 ~/.codex/config.toml，没有官方的多配置库。
// 与 Claude Code 一致，由 RelayManager 自维护预设清单 codex-cli-configs.json：
//   { appliedId, entries:[{id,name,config:{...Codex 字段...}}] }
// “切换/应用”=把选中预设的 config 经 writeCodexCli 写进 config.toml（TOML
// parse→modify→stringify，绝不回退正则；自动备份+原子写），符合既定工作流。
// 该文件含密钥，已 gitignore，禁止提交。CODEX_CONFIGS_PATH 已在上方定义。

function readCodexStore() {
  const obj = readJSON(CODEX_CONFIGS_PATH);
  if (!obj || !Array.isArray(obj.entries)) return { appliedId: '', entries: [] };
  return { appliedId: obj.appliedId || '', entries: obj.entries };
}
async function writeCodexStore(store) {
  await backupFile(CODEX_CONFIGS_PATH);
  await atomicWrite(CODEX_CONFIGS_PATH, JSON.stringify(store, null, 2) + '\n');
}

function sanitizeCodexConfig(d) {
  d = d || {};
  const str = v => (v === undefined || v === null) ? '' : String(v);
  let headers = {};
  if (d.httpHeaders && typeof d.httpHeaders === 'object') {
    for (const k of Object.keys(d.httpHeaders)) {
      if (k && k.trim() !== '') headers[k.trim()] = str(d.httpHeaders[k]);
    }
  }
  return {
    baseUrl: str(d.baseUrl),
    apiKey: str(d.apiKey),
    model: str(d.model || 'gpt-5.5'),
    modelProvider: str(d.modelProvider || 'custom') || 'custom',
    providerName: str(d.providerName || 'My Codex'),
    wireApi: ['responses', 'chat'].includes(d.wireApi) ? d.wireApi : 'responses',
    requiresOpenaiAuth: d.requiresOpenaiAuth !== false,
    reasoningEffort: ['low', 'medium', 'high', 'xhigh'].includes(d.reasoningEffort) ? d.reasoningEffort : 'high',
    reasoningSummary: ['auto', 'concise', 'detailed', 'none'].includes(d.reasoningSummary) ? d.reasoningSummary : 'auto',
    verbosity: ['', 'low', 'medium', 'high'].includes(d.verbosity) ? d.verbosity : '',
    disableResponseStorage: d.disableResponseStorage === true || d.disableResponseStorage === '1' || d.disableResponseStorage === 1,
    httpHeaders: headers,
    requestMaxRetries: str(d.requestMaxRetries),
    streamMaxRetries: str(d.streamMaxRetries),
    streamIdleTimeoutMs: str(d.streamIdleTimeoutMs),
  };
}

function listCodexConfigs() {
  const store = readCodexStore();
  const configs = store.entries.map(e => ({
    id: e.id,
    name: e.name || '(未命名)',
    baseUrl: (e.config && e.config.baseUrl) || '',
    applied: e.id === store.appliedId,
  }));
  return { appliedId: store.appliedId || '', configs };
}

async function createCodexConfig(name, configData) {
  const store = readCodexStore();
  const id = require('crypto').randomUUID();
  store.entries.push({ id, name: name || '新配置', config: sanitizeCodexConfig(configData) });
  if (!store.appliedId) store.appliedId = id;
  await writeCodexStore(store);
  return id;
}

async function applyCodexConfig(id) {
  const store = readCodexStore();
  const e = store.entries.find(x => x.id === id);
  if (!e) throw new Error('配置不存在: ' + id);
  store.appliedId = id;
  await writeCodexStore(store);
  await writeCodexCli(e.config || {});
  return id;
}

async function updateCodexConfig(id, configData) {
  const store = readCodexStore();
  const e = store.entries.find(x => x.id === id);
  if (!e) throw new Error('配置不存在: ' + id);
  e.config = sanitizeCodexConfig(configData);
  await writeCodexStore(store);
  if (store.appliedId === id) {
    await writeCodexCli(e.config || {});
  }
  return id;
}

async function deleteCodexConfig(id) {
  const store = readCodexStore();
  store.entries = store.entries.filter(e => e.id !== id);
  if (store.appliedId === id) store.appliedId = '';
  await writeCodexStore(store);
  return store.appliedId;
}

async function renameCodexConfig(id, name) {
  const store = readCodexStore();
  const e = store.entries.find(x => x.id === id);
  if (!e) throw new Error('配置不存在');
  e.name = (name || '').trim() || e.name;
  await writeCodexStore(store);
}

function exportCodexConfig(id, stripKey) {
  const store = readCodexStore();
  const e = store.entries.find(x => x.id === id);
  const config = e ? Object.assign({}, e.config) : {};
  if (stripKey) config.apiKey = '';
  return { name: e ? e.name : '导出配置', config };
}

// ========== CODEX DESKTOP — 多套配置（预设）管理 ==========
// Codex Desktop 原生没有多配置库，由 RelayManager 自维护预设清单
// codex-desktop-configs.json：{ appliedId, entries:[{id,name,config:{injectedBaseUrl,injectedApiKey,...}}] }
// 该文件含密钥，已 gitignore，禁止提交。CXD_CONFIGS_PATH 已在上方定义。

function readCXDStore() {
  const obj = readJSON(CXD_CONFIGS_PATH);
  if (!obj || !Array.isArray(obj.entries)) return { appliedId: '', entries: [] };
  return { appliedId: obj.appliedId || '', entries: obj.entries };
}
async function writeCXDStore(store) {
  await backupFile(CXD_CONFIGS_PATH);
  await atomicWrite(CXD_CONFIGS_PATH, JSON.stringify(store, null, 2) + '\n');
}

function sanitizeCXDConfig(d) {
  d = d || {};
  const str = v => (v === undefined || v === null) ? '' : String(v);
  return {
    injectedBaseUrl: str(d.injectedBaseUrl),
    injectedApiKey: str(d.injectedApiKey),
    responsesUpstream: Array.isArray(d.responsesUpstream) ? d.responsesUpstream : [],
    chatUpstream: Array.isArray(d.chatUpstream) ? d.chatUpstream : [],
    circuitBreaker: (d.circuitBreaker && typeof d.circuitBreaker === 'object') ? d.circuitBreaker : {},
    fuzzyModeEnabled: d.fuzzyModeEnabled !== false,
  };
}

function listCXDConfigs() {
  const store = readCXDStore();
  const configs = store.entries.map(e => ({
    id: e.id,
    name: e.name || '(未命名)',
    injectedBaseUrl: (e.config && e.config.injectedBaseUrl) || '',
    applied: e.id === store.appliedId,
  }));
  return { appliedId: store.appliedId || '', configs };
}

async function createCXDConfig(name, configData) {
  const store = readCXDStore();
  const id = require('crypto').randomUUID();
  store.entries.push({ id, name: name || '新配置', config: sanitizeCXDConfig(configData) });
  if (!store.appliedId) store.appliedId = id;
  await writeCXDStore(store);
  return id;
}

async function applyCXDConfig(id) {
  const store = readCXDStore();
  const e = store.entries.find(x => x.id === id);
  if (!e) throw new Error('配置不存在: ' + id);
  store.appliedId = id;
  await writeCXDStore(store);
  await writeCodexDesktop(e.config || {});
  return id;
}

async function updateCXDConfig(id, configData) {
  const store = readCXDStore();
  const e = store.entries.find(x => x.id === id);
  if (!e) throw new Error('配置不存在: ' + id);
  e.config = sanitizeCXDConfig(configData);
  await writeCXDStore(store);
  if (store.appliedId === id) {
    await writeCodexDesktop(e.config || {});
  }
  return id;
}

async function deleteCXDConfig(id) {
  const store = readCXDStore();
  store.entries = store.entries.filter(e => e.id !== id);
  if (store.appliedId === id) store.appliedId = '';
  await writeCXDStore(store);
  return store.appliedId;
}

async function renameCXDConfig(id, name) {
  const store = readCXDStore();
  const e = store.entries.find(x => x.id === id);
  if (!e) throw new Error('配置不存在');
  e.name = (name || '').trim() || e.name;
  await writeCXDStore(store);
}

function exportCXDConfig(id, stripKey) {
  const store = readCXDStore();
  const e = store.entries.find(x => x.id === id);
  const config = e ? Object.assign({}, e.config) : {};
  if (stripKey) config.injectedApiKey = '';
  return { name: e ? e.name : '导出配置', config };
}

async function writeCodexCli(data) {
  const filePath = PATHS.codexCli;

  // Parse the existing TOML into an object, modify it, then re-stringify. This is
  // far more robust than the old regex approach, which corrupted files containing
  // comments, nested tables, or multi-line values. The trade-off: @iarna/toml's
  // stringify drops comments. We mitigate by preserving the file structure as an
  // object and only touching the keys we manage.
  let obj = {};
  let hadFile = false;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    obj = toml.parse(raw);
    hadFile = true;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // File exists but is malformed — don't clobber it blindly.
      throw new Error('Codex config.toml 解析失败，未做修改以免损坏：' + e.message);
    }
    obj = {}; // fresh file
  }

  // 用实际的 model_provider 值作为表键，与 readCodexCli 保持对称；默认回退 'custom'。
  const providerKey = (data.modelProvider || 'custom').trim() || 'custom';
  if (!obj.model_providers || typeof obj.model_providers !== 'object') obj.model_providers = {};
  if (!obj.model_providers[providerKey] || typeof obj.model_providers[providerKey] !== 'object') obj.model_providers[providerKey] = {};
  const custom = obj.model_providers[providerKey];

  // Provider-scoped keys
  custom.base_url = (data.baseUrl || '').trim();
  custom.experimental_bearer_token = (data.apiKey || '').trim();
  // 使用 experimental_bearer_token 直接传令牌时，移除 env_key，
  // 避免 Codex CLI 因缺少 AGENT_ROUTER_TOKEN 等环境变量而报错。
  delete custom.env_key;
  if (data.providerName !== undefined) custom.name = data.providerName;
  if (data.wireApi !== undefined) custom.wire_api = data.wireApi;
  if (data.requiresOpenaiAuth !== undefined) custom.requires_openai_auth = !!data.requiresOpenaiAuth;

  // Provider-scoped 高级字段：自定义请求头 + 网络重试/超时。
  // 自定义请求头：空对象时删除该键，避免写出空表。
  if (data.httpHeaders !== undefined) {
    const hh = (data.httpHeaders && typeof data.httpHeaders === 'object') ? data.httpHeaders : {};
    const keys = Object.keys(hh).filter(k => k.trim() !== '');
    if (keys.length) {
      const clean = {};
      for (const k of keys) clean[k.trim()] = String(hh[k]); // 值统一转字符串
      custom.http_headers = clean;
    } else {
      delete custom.http_headers;
    }
  }
  // 数字字段：空串=删除该键（恢复 Codex 默认值）；否则写入整数。
  const setIntOrDelete = (obj, key, val) => {
    if (val === undefined) return;
    const s = String(val).trim();
    if (s === '') { delete obj[key]; return; }
    const n = parseInt(s, 10);
    if (!Number.isNaN(n)) obj[key] = n;
  };
  setIntOrDelete(custom, 'request_max_retries', data.requestMaxRetries);
  setIntOrDelete(custom, 'stream_max_retries', data.streamMaxRetries);
  setIntOrDelete(custom, 'stream_idle_timeout_ms', data.streamIdleTimeoutMs);

  // Top-level keys
  if (data.model) obj.model = data.model;
  if (data.modelProvider) obj.model_provider = data.modelProvider;
  if (data.reasoningEffort) obj.model_reasoning_effort = data.reasoningEffort;

  // Top-level 高级字段。
  if (data.reasoningSummary !== undefined && String(data.reasoningSummary).trim() !== '') {
    obj.model_reasoning_summary = data.reasoningSummary; // auto/concise/detailed/none
  }
  // verbosity 为空串时删除该键（不设置）。
  if (data.verbosity !== undefined) {
    const v = String(data.verbosity).trim();
    if (v === '') delete obj.model_verbosity; else obj.model_verbosity = v;
  }
  // disable_response_storage 为布尔；false 时删除键以保持文件干净（等价默认）。
  if (data.disableResponseStorage !== undefined) {
    if (data.disableResponseStorage) obj.disable_response_storage = true;
    else delete obj.disable_response_storage;
  }

  // Stringify back to TOML. @iarna/toml handles escaping/quoting correctly.
  let out;
  try {
    out = toml.stringify(obj);
  } catch (e) {
    throw new Error('Codex 配置序列化失败：' + e.message);
  }

  if (hadFile) await backupFile(filePath);
  // Make sure the directory exists (fresh install case).
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWrite(filePath, out);

  // 同步将 API Key 写入 ~/.codex/.env，确保 Codex CLI 的 env_key 机制
  // （如 env_key = "AGENT_ROUTER_TOKEN"）也能正常读取到令牌。
  if (data.apiKey && String(data.apiKey).trim()) {
    await writeCodexEnv('AGENT_ROUTER_TOKEN', String(data.apiKey).trim());
  }
}

// 将指定环境变量写入 ~/.codex/.env，同时保留已有的非代理类变量。
// 代理变量（HTTP_PROXY 等）由 writeProxy 管理，此函数不触碰它们。
async function writeCodexEnv(key, value) {
  const filePath = PATHS.proxyEnv;
  const proxyKeys = new Set([
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'WS_PROXY', 'WSS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'ws_proxy', 'wss_proxy', 'no_proxy',
  ]);
  // 读取现有文件，保留非代理行
  const lines = [];
  let foundKey = false;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
      if (m && m[1] === key) {
        lines.push(`${key}=${value}`);
        foundKey = true;
      } else if (m && proxyKeys.has(m[1])) {
        // 代理行由 writeProxy 管理，保留原样
        lines.push(line);
      } else {
        // 非代理行（注释、空行、其他 env）保留
        lines.push(line);
      }
    }
  } catch (e) {
    // 文件不存在，从头创建
  }
  if (!foundKey) lines.push(`${key}=${value}`);

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
}

async function writeCodexDesktop(data) {
  // Update upstream config (config.json)
  if (data.responsesUpstream !== undefined || data.chatUpstream !== undefined) {
    const configPath = PATHS.codexDesktopConfig;
    let obj = readJSON(configPath) || {};
    if (data.responsesUpstream !== undefined) obj.responsesUpstream = data.responsesUpstream;
    if (data.chatUpstream !== undefined) obj.chatUpstream = data.chatUpstream;
    if (data.circuitBreaker !== undefined) obj.circuitBreaker = data.circuitBreaker;
    if (data.fuzzyModeEnabled !== undefined) obj.fuzzyModeEnabled = data.fuzzyModeEnabled;
    await backupFile(configPath);
    await atomicWrite(configPath, JSON.stringify(obj, null, 2) + '\n');
  }

  // Update injection config (codex.json)
  if (data.injectedBaseUrl !== undefined || data.injectedApiKey !== undefined) {
    const injectionPath = PATHS.codexDesktopInjection;
    let obj = readJSON(injectionPath) || {};
    if (data.injectedBaseUrl !== undefined) obj.injectedBaseUrl = data.injectedBaseUrl;
    if (data.injectedApiKey !== undefined) obj.injectedApiKey = data.injectedApiKey;
    await backupFile(injectionPath);
    await atomicWrite(injectionPath, JSON.stringify(obj, null, 2) + '\n');
  }
}

async function writeProxy(data) {
  const filePath = PATHS.proxyEnv;
  const host = data.proxyHost || '127.0.0.1';
  const port = data.proxyPort || '7897';
  const proxyUrl = `http://${host}:${port}`;
  const noProxy = data.noProxy || 'localhost,127.0.0.1,::1';
  const wsOn = data.wsProxy !== undefined ? data.wsProxy : true;
  const wssOn = data.wssProxy !== undefined ? data.wssProxy : true;

  // 代理变量名集合（含大小写变体）
  const proxyKeys = new Set([
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'WS_PROXY', 'WSS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'ws_proxy', 'wss_proxy', 'no_proxy',
  ]);

  // 从现有 .env 文件中保留非代理的行（如 AGENT_ROUTER_TOKEN），避免被代理覆写覆盖
  const preservedLines = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
      if (m && !proxyKeys.has(m[1])) {
        preservedLines.push(line);
      }
    }
  } catch (e) { /* 文件不存在，无需保留 */ }

  const proxyBlock = `# Clash Verge / mihomo mixed proxy
HTTP_PROXY=${proxyUrl}
HTTPS_PROXY=${proxyUrl}
ALL_PROXY=${proxyUrl}
http_proxy=${proxyUrl}
https_proxy=${proxyUrl}
all_proxy=${proxyUrl}
NO_PROXY=${noProxy}
no_proxy=${noProxy}
${wsOn ? `WS_PROXY=${proxyUrl}\nws_proxy=${proxyUrl}\n` : ''}${wssOn ? `WSS_PROXY=${proxyUrl}\nwss_proxy=${proxyUrl}\n` : ''}`;

  const content = preservedLines.length > 0
    ? preservedLines.join('\n') + '\n' + proxyBlock
    : proxyBlock;

  await backupFile(filePath);
  await atomicWrite(filePath, content);
}

// ========== PROXY MANAGEMENT ==========

// Cross-platform check: is a process whose name matches `name` currently running?
function isProcessRunning(name) {
  try {
    if (IS_WIN) {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /FO CSV /NH 2>nul`, { encoding: 'utf-8', timeout: 3000 });
      return out.toLowerCase().includes(name.toLowerCase());
    }
    // macOS / Linux: pgrep -f matches against the full command line, -x against
    // the exact process name. Use -f so app-bundle names with spaces still match.
    const out = execSync(`pgrep -f ${JSON.stringify(name)} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
    return out.trim().length > 0;
  } catch (e) { return false; }
}

// Cross-platform check: is something LISTENING on `port`?
function isPortListening(port) {
  try {
    if (IS_WIN) {
      const result = execSync(`netstat -ano 2>nul | findstr ":${port} " | findstr "LISTENING"`, { encoding: 'utf-8', timeout: 2000 });
      return !!result.trim();
    }
    // macOS / Linux: lsof is the most reliable. -nP avoids slow DNS/port lookups.
    const result = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
    return !!result.trim();
  } catch (e) { return false; }
}

function checkProxyStatus() {
  const port = (readProxy()).proxyPort || '7897';
  const names = APPS.proxy ? APPS.proxy.processes : (IS_WIN ? ['clash-verge.exe', 'verge-mihomo.exe'] : ['Clash Verge', 'verge-mihomo']);
  let processRunning = false;
  for (const name of names) {
    if (isProcessRunning(name)) { processRunning = true; break; }
  }
  const portListening = isPortListening(port);
  return { processRunning, portListening, port: parseInt(port) };
}

function startProxy() {
  if (!clashExe || !fs.existsSync(clashExe)) {
    throw new Error(`Clash Verge not found at: ${clashExe || '(未配置路径)'}`);
  }
  launchApp(clashExe);
  return { exe: clashExe };
}

function stopProxy() {
  const results = [];
  const names = APPS.proxy ? APPS.proxy.processes : ['clash-verge.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe'];
  for (const name of names) {
    const ok = killProcessByName(name);
    results.push({ process: name, result: ok ? 'terminated' : 'not running' });
  }
  return results;
}

// ========== SYNC ALL LOGIC ==========

async function syncAll(data) {
  const sync = data.syncAll;
  if (!sync || !sync.baseUrl) return [];

  const baseUrl = sync.baseUrl;
  const apiKey = sync.apiKey || '';
  const backups = [];

  // 中文注释：按产品开关执行同步，保持原有保存链路不变。
  // 新增产品可在前端先回填字段，再复用这里的持久化写入逻辑。

  // 1. Claude Code CLI
  if (sync.claudeCode !== false) {
    const ccData = readClaudeCode();
    ccData.baseUrl = baseUrl;
    ccData.authToken = apiKey;
    const bp = await backupFile(PATHS.claudeCode);
    if (bp) backups.push(bp);
    await writeClaudeCode(ccData);
  }

  // 2. Claude Desktop 3P
  if (sync.claudeDesktop !== false) {
    const cdData = readClaudeDesktop();
    if (cdData.configId) {
      cdData.baseUrl = baseUrl;
      cdData.apiKey = apiKey;
      const bp = await writeClaudeDesktopPrep(cdData);
      if (bp) backups.push(bp);
    }
  }

  // 3. Codex CLI
  if (sync.codexCli !== false) {
    const cxData = readCodexCli();
    cxData.baseUrl = baseUrl;
    cxData.apiKey = apiKey;
    await writeCodexCli(cxData);
    // backup already done inside writeCodexCli
    backups.push('codex-cli-config.toml');
  }

  // 4. Codex Desktop — update primary active upstream
  if (sync.codexDesktop !== false) {
    const config = readJSON(PATHS.codexDesktopConfig);
    if (config) {
      // Update first active responsesUpstream
      const activeResp = (config.responsesUpstream || []).filter(e => e.status === 'active').sort((a, b) => (a.priority || 99) - (b.priority || 99));
      if (activeResp.length > 0) {
        activeResp[0].baseUrl = baseUrl;
        activeResp[0].apiKeys = [apiKey];
      }
      // Update first active chatUpstream
      const activeChat = (config.chatUpstream || []).filter(e => e.status === 'active').sort((a, b) => (a.priority || 99) - (b.priority || 99));
      if (activeChat.length > 0) {
        activeChat[0].baseUrl = baseUrl;
        activeChat[0].apiKeys = [apiKey];
      }
      await backupFile(PATHS.codexDesktopConfig);
      await atomicWrite(PATHS.codexDesktopConfig, JSON.stringify(config, null, 2) + '\n');
    }
  }

  return backups;
}

async function writeClaudeDesktopPrep(data) {
  const meta = readJSON(PATHS.claudeDesktopMeta);
  if (!meta || !meta.appliedId) return null;
  const filePath = path.join(PATHS.claudeDesktopDir, `${meta.appliedId}.json`);
  let obj = readJSON(filePath) || {};
  if (data.apiKey !== undefined) obj.inferenceGatewayApiKey = data.apiKey;
  if (data.baseUrl !== undefined) obj.inferenceGatewayBaseUrl = data.baseUrl;
  const bp = await backupFile(filePath);
  await atomicWrite(filePath, JSON.stringify(obj, null, 2) + '\n');
  return bp;
}

// ========== APP RESTART ==========

// Cross-platform: kill all processes matching `name`. Returns true if the kill
// command succeeded (process existed), false otherwise.
function killProcessByName(name) {
  try {
    if (IS_WIN) {
      execSync(`taskkill /f /im "${name}" 2>nul`, { encoding: 'utf-8', timeout: 5000 });
      return true;
    }
    // macOS / Linux: pkill -f matches the full command line. Exit code 0 = killed,
    // 1 = no match. execSync throws on non-zero, so the catch handles "not running".
    execSync(`pkill -f ${JSON.stringify(name)} 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

function killApp(processNames) {
  const killed = [];
  for (const name of processNames) {
    if (killProcessByName(name)) killed.push(name);
  }
  return killed;
}

// Cross-platform app launcher. On Windows we spawn the exe directly; on macOS we
// use `open -a "/path/App.app"` (or `open <bundle>`) which is the correct way to
// launch a .app bundle. Returns { pid } when available.
function launchApp(exePath) {
  if (!exePath || !fs.existsSync(exePath)) throw new Error('App not found: ' + exePath);
  if (IS_WIN) {
    const proc = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false });
    proc.unref();
    return { pid: proc.pid };
  }
  // macOS: `open` returns immediately; it has no meaningful child PID for the app.
  if (IS_MAC) {
    const proc = spawn('open', [exePath], { detached: true, stdio: 'ignore' });
    proc.unref();
    return { pid: null };
  }
  // Linux fallback
  const proc = spawn(exePath, [], { detached: true, stdio: 'ignore' });
  proc.unref();
  return { pid: proc.pid };
}

// Backward-compat alias.
function startApp(exePath) { return launchApp(exePath); }

// Sleep briefly so the OS releases the killed app before relaunch.
function sleepSync(ms) {
  if (IS_WIN) {
    try { execSync(`timeout /t ${Math.ceil(ms / 1000)} /nobreak >nul 2>&1`, { timeout: ms + 1000 }); } catch (e) {}
  } else {
    try { execSync(`sleep ${(ms / 1000).toFixed(1)}`, { timeout: ms + 1000 }); } catch (e) {}
  }
}

function restartApp(product) {
  const app = APPS[product];
  if (!app) throw new Error('Unknown product: ' + product);
  const killed = killApp(app.processes);
  sleepSync(1000);
  // If we have a valid exe/bundle path, relaunch; otherwise just kill (user reopens manually)
  if (app.exe && fs.existsSync(app.exe)) {
    const started = launchApp(app.exe);
    return { product, name: app.name, killed, pid: started.pid, relaunched: true };
  }
  return {
    product, name: app.name, killed, relaunched: false,
    warning: '未配置 ' + app.name + ' 的程序路径，已关闭进程但无法自动重启。请在「应用路径」中填写路径，或手动重新打开 ' + app.name + '。',
  };
}

// ========== PROCESS STATUS (feature #6) ==========
// Return { running, pid } for a managed product by checking its process names.
function getProcessStatus(product) {
  const app = APPS[product];
  if (!app) return { running: false, pid: null, error: 'unknown product: ' + product };
  for (const name of app.processes) {
    const pid = findFirstPid(name);
    if (pid) return { running: true, pid, name, product };
  }
  return { running: false, pid: null, product };
}

// Cross-platform: return the first PID matching `name`, or null.
function findFirstPid(name) {
  try {
    if (IS_WIN) {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /FO CSV /NH 2>nul`, { encoding: 'utf-8', timeout: 3000 });
      const m = out.match(/"[^"]+","(\d+)"/);
      return m ? parseInt(m[1]) : null;
    }
    const out = execSync(`pgrep -f ${JSON.stringify(name)} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
    const first = out.trim().split('\n')[0];
    return first ? parseInt(first) : null;
  } catch (e) { return null; }
}

// ========== CONFIG HISTORY & ROLLBACK (feature #5) ==========
// Map a product key to its live config file path. Claude Desktop resolves the
// currently-applied config via _meta.json.
function productToConfigPath(product) {
  switch (product) {
    case 'claude-code': return PATHS.claudeCode;
    case 'codex-cli': return PATHS.codexCli;
    case 'codex-desktop': return PATHS.codexDesktopConfig;
    case 'claude-desktop': {
      const meta = readJSON(PATHS.claudeDesktopMeta);
      if (!meta || !meta.appliedId) return null;
      return path.join(PATHS.claudeDesktopDir, meta.appliedId + '.json');
    }
    default: return null;
  }
}

// List timestamped backups for a product's config (from its backups/ dir).
function listConfigHistory(product) {
  const filePath = productToConfigPath(product);
  if (!filePath) return { product, configPath: '', backups: [] };
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  const backupDir = path.join(dir, 'backups');
  const items = [];
  try {
    const prefix = baseName + '-';
    for (const f of fs.readdirSync(backupDir)) {
      if (!f.startsWith(prefix) || !f.endsWith(ext)) continue;
      let mtime = null;
      try { mtime = fs.statSync(path.join(backupDir, f)).mtime.toISOString(); } catch (e) {}
      items.push({ filename: f, mtime });
    }
  } catch (e) { /* no backups dir yet */ }
  // Newest first (timestamp in name is lexicographically sortable)
  items.sort((a, b) => b.filename.localeCompare(a.filename));
  return { product, configPath: filePath, backups: items };
}

// Roll back a product's live config to a chosen backup, then restart its client.
// The current config is itself backed up first, so rollback is reversible.
async function rollbackConfig(product, filename) {
  const filePath = productToConfigPath(product);
  if (!filePath) throw new Error('无法定位该产品的配置文件: ' + product);
  if (!filename || /[\\/]|\.\./.test(filename)) throw new Error('非法的备份文件名');
  const backupDir = path.join(path.dirname(filePath), 'backups');
  const src = path.join(backupDir, filename);
  // Confine to the backups dir (defense in depth against traversal).
  if (path.dirname(path.resolve(src)) !== path.resolve(backupDir)) throw new Error('备份路径越界');
  if (!fs.existsSync(src)) throw new Error('备份文件不存在: ' + filename);
  // Back up the current file before overwriting, so the rollback is reversible.
  await backupFile(filePath);
  const content = fs.readFileSync(src, 'utf-8');
  await atomicWrite(filePath, content);
  // Restart the matching client if we manage one for this product.
  let restart = null;
  const restartKey = product === 'claude-desktop' ? 'claude-desktop' : (product === 'codex-desktop' ? 'codex-desktop' : null);
  if (restartKey && APPS[restartKey]) {
    try { restart = restartApp(restartKey); } catch (e) { restart = { error: e.message }; }
  }
  return { product, rolledBackTo: filename, configPath: filePath, restart };
}


// Replaces CC Switch's local gateway. Claude Desktop sends Anthropic model names
// (e.g. claude-sonnet-4-5) here; the gateway rewrites them to backend models
// (e.g. glm-5.2) per user config, then forwards to the real relay.

const GATEWAY_CONFIG_FILE = path.join(__dirname, 'gateway.json');
const GATEWAY_DEFAULT_PORT = 9877;

function readGatewayConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(GATEWAY_CONFIG_FILE, 'utf-8')); }
  catch (e) { cfg = {}; }
  // Apply defaults so callers don't have to null-check. `network` holds the
  // advanced settings (feature #3); they hot-reload because the gateway reads
  // config fresh on every request.
  return {
    port: cfg.port || GATEWAY_DEFAULT_PORT,
    upstreamBaseUrl: cfg.upstreamBaseUrl || '',
    upstreamApiKey: cfg.upstreamApiKey || '',
    routes: cfg.routes || {},
    thinkingMode: cfg.thinkingMode || 'passthrough',
    thinkingBudget: cfg.thinkingBudget || 10000,
    logging: !!cfg.logging,
    network: {
      requestTimeoutSec: numOr(cfg.network && cfg.network.requestTimeoutSec, 0),   // connect/overall; 0 = no extra cap
      readTimeoutSec: numOr(cfg.network && cfg.network.readTimeoutSec, 0),         // idle socket timeout; 0 = default
      maxRetries: numOr(cfg.network && cfg.network.maxRetries, 0),                 // extra attempts on failure
      retryBackoffMs: numOr(cfg.network && cfg.network.retryBackoffMs, 500),       // base backoff between retries
      customHeaders: (cfg.network && cfg.network.customHeaders && typeof cfg.network.customHeaders === 'object') ? cfg.network.customHeaders : {},
    },
  };
}
// Coerce to a finite non-negative number or fall back to `def`.
function numOr(v, def) {
  const n = parseInt(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
async function writeGatewayConfig(cfg) {
  await atomicWrite(GATEWAY_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// Build a Claude/Anthropic-shaped error object so clients can parse gateway errors.
function anthropicError(message, type) {
  return { type: 'error', error: { type: type || 'api_error', message: String(message) } };
}

// Privacy-respecting gateway request log. Honors cfg.logging (default off). Records
// ONLY model rewrite + path + timestamp — never the request body, messages, or keys,
// per the "do not cache user data" requirement. Rolls at ~2000 lines.
const GATEWAY_LOG_FILE = path.join(__dirname, 'gateway-requests.log');
function gatewayLog(cfg, info) {
  if (!cfg || !cfg.logging) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      path: info.path,
      model: info.originalModel || '',
      mappedTo: info.mappedModel || '',
      rewritten: info.originalModel !== info.mappedModel,
    }) + '\n';
    fs.appendFileSync(GATEWAY_LOG_FILE, line, 'utf-8');
    // Best-effort roll: if the file gets large, truncate to the last ~1000 lines.
    const stat = fs.statSync(GATEWAY_LOG_FILE);
    if (stat.size > 512 * 1024) {
      const lines = fs.readFileSync(GATEWAY_LOG_FILE, 'utf-8').split('\n');
      fs.writeFileSync(GATEWAY_LOG_FILE, lines.slice(-1000).join('\n'), 'utf-8');
    }
  } catch (e) { /* logging is best-effort, never break the request */ }
}

// Gateway compatibility shim — the core value of the local gateway. Auto-fills or
// strips the `thinking` field and adapts incompatible params per gateway config,
// so third-party upstreams that require (or reject) thinking just work.
//   thinkingMode: 'passthrough' (default, do nothing) | 'inject' | 'strip'
function applyGatewayCompat(parsed, cfg, routeKey) {
  const mode = cfg.thinkingMode || 'passthrough';
  if (mode === 'passthrough') return { applied: false, reason: 'passthrough' };
  if (!parsed || !Array.isArray(parsed.messages)) return { applied: false, reason: 'no_messages' };
  if (mode === 'strip') {
    delete parsed.thinking;
    // Also remove any thinking-related headers that might have been added
    return { applied: true, reason: 'stripped' };
  }
  if (mode === 'inject') {
    // Per-route thinking budget: if a specific route has a budget, use it
    let budget = parseInt(cfg.thinkingBudget) || 10000;
    if (cfg.routeBudgets && cfg.routeBudgets[routeKey]) {
      budget = parseInt(cfg.routeBudgets[routeKey]);
    }
    if (budget <= 0) budget = 10000; // fallback

    const hadThinking = !!parsed.thinking;
    parsed.thinking = { type: 'enabled', budget_tokens: budget };
    // Anthropic requires max_tokens > budget_tokens when thinking is enabled.
    // Increase if necessary, but don't decrease if user set a higher value
    if (!parsed.max_tokens || parsed.max_tokens <= budget) {
      parsed.max_tokens = budget + 1024;
    }
    // Extended thinking forbids non-default temperature/top_p/top_k — drop them
    // (only if they weren't explicitly set to non-default values)
    if (parsed.temperature !== undefined && parsed.temperature !== 1) {
      // User set a custom temperature — keep it but warn (could affect quality)
      // We'll allow it but note it might not be honored by all upstreams
    }
    // Actually, per Anthropic spec, we should remove temperature/top_p/top_k for thinking
    delete parsed.temperature;
    delete parsed.top_p;
    delete parsed.top_k;
    return { applied: true, reason: hadThinking ? 'preserved' : 'injected', budget };
  }
  return { applied: false, reason: 'unknown_mode' };
}

function forwardToUpstream(req, clientRes, reqPath, body, cfg, routeKey) {
  if (!cfg.upstreamBaseUrl) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(anthropicError('上游中转站未配置，请在 RelayManager 中设置', 'gateway_not_configured')));
    return;
  }
  const net = cfg.network || {};
  const maxRetries = numOr(net.maxRetries, 0);
  const retryBackoffMs = numOr(net.retryBackoffMs, 500);
  const started = Date.now();
  const debugStream = false; // verbose stream tracing toggle (kept off in prod)

  // Try once; on a connection-level failure (not an HTTP error from upstream,
  // and only before any bytes were sent to the client) retry up to maxRetries.
  attempt(0);

  function attempt(tryNum) {
    const upstream = new URL(cfg.upstreamBaseUrl);
    const isHttps = upstream.protocol === 'https:';
    const httpMod = isHttps ? require('https') : require('http');
    const base = upstream.pathname.replace(/\/+$/, '');
    const fullPath = base + reqPath;
    const headers = { ...req.headers };
    headers['authorization'] = 'Bearer ' + (cfg.upstreamApiKey || '');
    headers['x-api-key'] = cfg.upstreamApiKey || '';
    headers['host'] = upstream.host;
    headers['content-length'] = String(Buffer.byteLength(body));
    delete headers['accept-encoding'];
    // Advanced: append user-defined custom headers (feature #3). Applied last so
    // they can override defaults if the user really wants to.
    if (net.customHeaders && typeof net.customHeaders === 'object') {
      for (const k of Object.keys(net.customHeaders)) {
        if (k && net.customHeaders[k] !== undefined && net.customHeaders[k] !== '') {
          headers[k] = String(net.customHeaders[k]);
        }
      }
    }

    // Timeouts. requestTimeoutSec caps the whole non-stream request; readTimeoutSec
    // is the idle socket timeout. 0 = use built-in defaults (stream-friendly).
    const reqTimeoutMs = net.requestTimeoutSec > 0 ? net.requestTimeoutSec * 1000 : 120000;
    const STREAM_TIMEOUT_MS = 600000;
    const readTimeoutMs = net.readTimeoutSec > 0 ? net.readTimeoutSec * 1000 : 0;

    let sentToClient = false; // once true, we can't safely retry

    function logResult(status, errorMessage) {
      if (cfg.logging || true) { // always feed the in-memory debug ring (it's redacted + capped)
        debugLog.addLog({
          method: req.method,
          url: reqPath,
          status: status,
          duration_ms: Date.now() - started,
          error_message: errorMessage || '',
          model: routeKey || '',
          mappedTo: (cfg.routes && cfg.routes[routeKey]) || '',
        });
      }
      // Also feed the optional on-disk privacy log if enabled.
      gatewayLog(cfg, { path: reqPath, originalModel: routeKey, mappedModel: (cfg.routes && cfg.routes[routeKey]) || routeKey });
    }

    function maybeRetry(reason) {
      if (!sentToClient && tryNum < maxRetries) {
        const delay = retryBackoffMs * (tryNum + 1); // linear backoff
        setTimeout(() => attempt(tryNum + 1), delay);
        return true;
      }
      return false;
    }

    const upstreamReq = httpMod.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (isHttps ? 443 : 80),
      path: fullPath,
      method: req.method,
      headers,
      timeout: STREAM_TIMEOUT_MS,
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      const isStream = /text\/event-stream/i.test(String(upstreamRes.headers['content-type'] || ''));
      const contentType = upstreamRes.headers['content-type'] || '';

      // Error responses: buffer + normalize to Anthropic error shape (don't stream).
      if (status >= 400) {
        let errBody = '';
        upstreamRes.on('data', c => errBody += c);
        upstreamRes.on('end', () => {
          let payload;
          try {
            const p = JSON.parse(errBody);
            if (p && p.error) {
              payload = { type: 'error', error: { type: p.error.type || 'upstream_error', message: p.error.message || p.error || ('HTTP ' + status) } };
            } else {
              const msg = p && (p.message || p.error || p.msg || (typeof p === 'string' ? p : ''));
              payload = anthropicError(msg || ('上游返回 HTTP ' + status), classifyUpstreamError(status, msg, contentType));
            }
          } catch (e) {
            payload = anthropicError((errBody || '').slice(0, 500) || ('上游返回 HTTP ' + status), classifyUpstreamError(status, errBody, contentType));
          }
          logResult(status, payload.error && payload.error.message);
          try {
            sentToClient = true;
            if (!clientRes.headersSent) clientRes.writeHead(status, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify(payload));
          } catch (_) {}
        });
        upstreamRes.on('error', () => { try { clientRes.end(); } catch (_) {} });
        return;
      }

      // Success response
      sentToClient = true;
      const responseHeaders = { ...upstreamRes.headers };
      if (isStream) {
        responseHeaders['x-accel-buffering'] = 'no';
        responseHeaders['cache-control'] = 'no-cache';
        responseHeaders['connection'] = 'keep-alive';
      }
      try { clientRes.writeHead(status, responseHeaders); } catch (_) {}

      // ========== SSE STREAMING ROBUSTNESS ==========
      if (isStream) {
        upstreamReq.setTimeout(STREAM_TIMEOUT_MS, () => {});
        let heartbeatTimer;
        const HEARTBEAT_INTERVAL = 25000;
        const sendHeartbeat = () => { try { if (!clientRes.writableEnded) clientRes.write(': heartbeat\n\n'); } catch (_) {} };
        heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

        let streamBytes = 0;
        let streamChunks = 0;
        upstreamRes.on('data', (chunk) => {
          streamBytes += Buffer.byteLength(chunk);
          streamChunks += 1;
          if (debugStream) console.error('[gw] stream chunk', { routeKey, status, streamChunks, streamBytes });
          try { if (!clientRes.writableEnded) clientRes.write(chunk); } catch (_) {}
        });
        upstreamRes.on('end', () => {
          clearInterval(heartbeatTimer);
          if (debugStream) console.error('[gw] stream end', { routeKey, status, streamChunks, streamBytes });
          logResult(status, '');
          try { if (!clientRes.writableEnded) { clientRes.write('event: done\ndata: [DONE]\n\n'); clientRes.end(); } }
          catch (_) { try { clientRes.end(); } catch (_) {} }
        });
        upstreamRes.on('error', (e) => {
          clearInterval(heartbeatTimer);
          const isAbort = e.message && /aborted|reset|closed/i.test(e.message);
          if (!isAbort) console.error('Upstream stream error:', e.code);
          if (debugStream) console.error('[gw] stream error', { routeKey, status, code: e.code, message: e.message, streamChunks, streamBytes });
          logResult(status, 'stream_error: ' + (e.code || e.message));
          if (!clientRes.writableEnded) {
            try {
              const errPayload = anthropicError(isAbort ? '上游连接中断' : ('流式响应错误: ' + e.code), 'upstream_stream_error');
              clientRes.write('event: error\ndata: ' + JSON.stringify(errPayload) + '\n\n');
              clientRes.end();
            } catch (_) { try { clientRes.end(); } catch (_) {} }
          }
        });
        clientRes.on('close', () => { clearInterval(heartbeatTimer); if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy(); });
      } else {
        upstreamRes.setTimeout(reqTimeoutMs, () => {
          upstreamReq.destroy();
          logResult(504, 'upstream_timeout');
          if (!clientRes.headersSent) {
            clientRes.writeHead(504, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify(anthropicError('上游响应超时', 'upstream_timeout')));
          }
        });
        upstreamRes.on('end', () => { if (debugStream) console.error('[gw] non-stream end', { routeKey, status }); logResult(status, ''); });
        upstreamRes.pipe(clientRes, { end: true });
        upstreamRes.on('error', (e) => {
          try {
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { 'Content-Type': 'application/json' });
              clientRes.end(JSON.stringify(anthropicError('上游响应错误', 'upstream_error')));
            } else { clientRes.end(); }
          } catch (_) {}
        });
      }
    });

    // Apply idle read timeout if configured
    if (readTimeoutMs > 0) {
      upstreamReq.setTimeout(readTimeoutMs);
    }

    clientRes.on('close', () => { if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy(); });

    upstreamReq.on('error', (e) => {
      const errType = classifyConnectionError(e);
      if (maybeRetry('conn_error')) return; // retry before giving up
      logResult(0, 'conn_error: ' + (e.code || e.message));
      try {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify(anthropicError('网关无法连接上游: ' + errType, 'upstream_unreachable')));
        } else { clientRes.end(); }
      } catch (_) {}
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      if (maybeRetry('timeout')) return;
      logResult(504, 'request_timeout');
      try {
        if (!clientRes.headersSent) {
          clientRes.writeHead(504, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify(anthropicError('请求超时', 'request_timeout')));
        } else { clientRes.end(); }
      } catch (_) {}
    });

    upstreamReq.write(body);
    upstreamReq.end();
  }
}

// Classify upstream HTTP errors for better error messages
function classifyUpstreamError(status, msg, contentType) {
  const m = (msg || '').toLowerCase();
  if (/thinking|budget|max_thinking/i.test(m)) return 'thinking_unsupported';
  if (/model.*not.*found|model.*invalid|model.*not.*support/i.test(m)) return 'model_not_found';
  if (/auth|token|key|unauthorized|forbidden/i.test(m)) return 'authentication_error';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream_server_error';
  if (/content.*type|json.*parse|invalid.*request/i.test(m)) return 'invalid_request';
  return 'upstream_error';
}

// Classify connection errors for better error messages
function classifyConnectionError(e) {
  if (/ECONNREFUSED/i.test(e.code)) return '连接被拒绝，请检查中转站地址';
  if (/ENOTFOUND|ENETUNREACH/i.test(e.code)) return '无法解析域名，请检查中转站地址';
  if (/ETIMEDOUT|CONNECTIMEOUT/i.test(e.code)) return '连接超时，请检查网络或代理设置';
  if (/CERTIFICATE|SSL|TLS/i.test(e.code)) return 'SSL 证书错误，可能需要检查 HTTPS 配置';
  return '连接错误';
}

function startGatewayServer() {
  const cfg = readGatewayConfig();
  const port = cfg.port || GATEWAY_DEFAULT_PORT;
  const gw = http.createServer((req, res) => {
    // Same localhost-only posture as the main server: reject non-local Host
    // headers (DNS-rebinding) and never emit wildcard CORS. The gateway only
    // listens on 127.0.0.1, and its real client is Claude Desktop (same host).
    const gwHost = (req.headers.host || '').toLowerCase();
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(gwHost)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Forbidden: gateway only accepts local requests' } }));
      return;
    }
    const gwOrigin = req.headers.origin;
    if (gwOrigin) {
      let ok = false;
      try { const h = new URL(gwOrigin).hostname; ok = (h === 'localhost' || h === '127.0.0.1' || h === '::1'); } catch (e) {}
      if (ok) {
        res.setHeader('Access-Control-Allow-Origin', gwOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
      }
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const u = new URL(req.url, 'http://localhost');
    const currentCfg = readGatewayConfig(); // always fresh
    const routes = currentCfg.routes || {};

    // GET /v1/models — return the Anthropic model names (route keys) so Claude Desktop's probe/picker sees them
    if (req.method === 'GET' && (u.pathname === '/v1/models' || u.pathname === '/models')) {
      const data = Object.keys(routes).map(id => ({ id, object: 'model', created: 1626777600, owned_by: 'relay-manager' }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data }));
      return;
    }

    // POST /v1/messages (and any /v1/* POST) — rewrite model, forward to upstream
    if (req.method === 'POST' && u.pathname.startsWith('/v1/')) {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let outBody = body;
        let originalModel = '', mappedModel = '';
        try {
          const parsed = JSON.parse(body);
          originalModel = parsed.model || '';
          if (parsed.model && routes[parsed.model]) {
            parsed.model = routes[parsed.model]; // Anthropic name -> backend model
          }
          mappedModel = parsed.model || '';
          const compat = applyGatewayCompat(parsed, currentCfg, originalModel); // thinking auto-fill / strip + param adapt
          if (process.env.RELAY_MANAGER_DEBUG_GATEWAY === '1' && compat && compat.reason !== 'injected' && compat.reason !== 'preserved') {
            console.error('[gw] compat skipped', { routeKey: originalModel, reason: compat.reason, mode: currentCfg.thinkingMode, hasMessages: Array.isArray(parsed.messages) });
          }
          outBody = JSON.stringify(parsed);
        } catch (e) { /* non-JSON, forward as-is */ }
        // Privacy-respecting log: only model names + path, never body/key.
        gatewayLog(currentCfg, { path: u.pathname, originalModel, mappedModel });
        forwardToUpstream(req, res, u.pathname + u.search, outBody, currentCfg, originalModel);
      });
      return;
    }

    // GET / — health check
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'relay-manager-gateway', routes: Object.keys(routes) }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found: ' + u.pathname } }));
  });
  gw.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error('Gateway port ' + port + ' in use');
    else console.error('Gateway error:', e.message);
  });
  gw.listen(port, '127.0.0.1', () => {
    console.log('Relay gateway on http://127.0.0.1:' + port);
  });
  return gw;
}

// ========== FETCH MODELS ==========

function fetchModelsFromAPI(baseUrl, apiKey) {
  return new Promise((resolve) => {
    const u = new URL(baseUrl);
    // Strip trailing slashes, then build /v1/models path
    let apiPath = u.pathname.replace(/\/+$/, '');
    let modelsUrl;
    if (/\/v\d+$/.test(apiPath)) {
      // Path already ends with /v1, /v2 etc. — just append /models
      modelsUrl = u.origin + apiPath + '/models';
    } else if (apiPath === '') {
      modelsUrl = u.origin + '/v1/models';
    } else {
      modelsUrl = u.origin + apiPath + '/v1/models';
    }
    const httpModule = u.protocol === 'https:' ? require('https') : require('http');
    const req = httpModule.get(modelsUrl, {
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            resolve({ error: (parsed.error && parsed.error.message) || 'HTTP ' + res.statusCode, models: [] });
          } else {
            let models = [];
            if (Array.isArray(parsed.data)) models = parsed.data.map(m => ({ id: m.id, owned_by: m.owned_by || '' }));
            else if (Array.isArray(parsed)) models = parsed.map(m => ({ id: m.id || m, owned_by: m.owned_by || '' }));
            resolve({ success: true, models, total: models.length });
          }
        } catch (e) {
          const hint = data.trim().startsWith('<') ? ' (服务器返回了 HTML 而非 JSON，可能该中转站不支持 /v1/models 列模型接口，或 Base URL 错误)' : '';
          resolve({ error: 'Parse error: ' + e.message + hint, models: [], raw: data.slice(0, 500) });
        }
      });
    });
    req.on('error', (e) => resolve({ error: e.message, models: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timeout (15s)', models: [] }); });
  });
}

// Real end-to-end connectivity test: send an actual POST /v1/messages (the same
// endpoint Claude Code uses) so we catch gateway problems that /v1/models misses
// (thinking-field rejection, auth-header mismatch, model-name validation, etc.).
function testMessageAPI(baseUrl, apiKey, model, opts) {
  opts = opts || {};
  const authScheme = opts.authScheme;        // 'bearer' | 'x-api-key' | 'none' | undefined(=both)
  const maxTokens = opts.maxTokens || 16;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(baseUrl); } catch (e) { return resolve({ error: 'Base URL 格式无效: ' + baseUrl }); }
    let apiPath = u.pathname.replace(/\/+$/, '');
    const messagesUrl = /\/v\d+$/.test(apiPath)
      ? u.origin + apiPath + '/messages'
      : u.origin + (apiPath || '') + '/v1/messages';
    const payload = JSON.stringify({
      model: model || 'claude-3-5-sonnet-20241022',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: 'ping' }],
    });
    const httpModule = u.protocol === 'https:' ? require('https') : require('http');
    const target = new URL(messagesUrl);
    const req = httpModule.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        // Auth header(s) depend on the chosen scheme. Claude Desktop lets the
        // user pick bearer / x-api-key / none; Claude Code's probe leaves it
        // undefined and sends both for maximum compatibility.
        ...(authScheme === 'bearer'    ? { 'Authorization': 'Bearer ' + apiKey } :
            authScheme === 'x-api-key' ? { 'x-api-key': apiKey } :
            authScheme === 'none'      ? {} :
            { 'Authorization': 'Bearer ' + apiKey, 'x-api-key': apiKey }),
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        // Mimic the real Claude Code CLI as closely as possible so relays that
        // fingerprint the client ("unauthorized client detected") don't reject
        // the probe with a false negative. These mirror what the Anthropic SDK
        // (which Claude Code is built on) sends: a claude-cli User-Agent, the
        // claude-code beta flag, and the x-stainless-* SDK telemetry headers.
        'User-Agent': 'claude-cli/1.0.0 (external, cli)',
        'X-App': 'cli',
        'anthropic-beta': 'claude-code-20250219,fine-grained-tool-streaming-2025-05-14',
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-stainless-lang': 'js',
        'x-stainless-package-version': '0.55.1',
        'x-stainless-os': process.platform === 'win32' ? 'Windows' : (process.platform === 'darwin' ? 'MacOS' : 'Linux'),
        'x-stainless-arch': process.arch === 'x64' ? 'x64' : process.arch,
        'x-stainless-runtime': 'node',
        'x-stainless-runtime-version': process.versions.node,
        'x-stainless-retry-count': '0',
        'x-stainless-timeout': '60',
        'Accept': 'application/json',
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const code = res.statusCode;
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) {}
        if (code >= 200 && code < 300) {
          return resolve({ success: true, status: code, model: model, sample: (parsed && parsed.content) ? '收到模型回复' : '请求成功' });
        }
        const msg = (parsed && parsed.error && (parsed.error.message || parsed.error.type)) || data.slice(0, 300) || ('HTTP ' + code);
        // Classify common third-party gateway failures into actionable hints.
        let hint = '';
        if (/client.*detect|unauthorized client|client.*not.*allow|forbidden client/i.test(msg)) hint = '中转站检测到「非法客户端」——它在校验 User-Agent 等客户端指纹。本测试已模拟 Claude Code 客户端头；若仍失败，多为该中转站限制了非官方调用，请联系中转站确认是否允许 Claude Code 接入，或换一个中转站。';
        else if (code === 401 || code === 403 || /invalid.*key|unauthor|token/i.test(msg)) hint = 'API Key 无效或认证方式不被接受（已同时尝试 Bearer 和 x-api-key），请检查 Key 是否正确、是否过期或额度用尽';
        else if (/model/i.test(msg) && /not.*found|invalid|不存在|无权/i.test(msg)) hint = '模型名不被网关接受，请核对模型名与网关支持的是否完全一致（网关只认 claude- 开头官方名时，不能填第三方原生模型名）';
        else if (/thinking|budget|max_thinking/i.test(msg)) hint = '中转站不兼容 thinking 字段，请把「思考模式」切到「关闭思考」';
        else if (code === 400) hint = '请求格式不兼容（HTTP 400）：通常是模型名不被网关支持，或网关协议适配有问题；也可能是该网关要求补 thinking 等字段。请核对模型名是否与网关完全一致。';
        else if (code === 404) hint = 'Base URL 路径错误（HTTP 404）：/v1/messages 不存在，请确认填的是 Anthropic 兼容端点（注意是否该带 /anthropic 后缀，且不要自己拼 /v1）';
        else if (code >= 500) hint = '中转站服务端错误，稍后重试或换线路';
        resolve({ error: msg, status: code, hint });
      });
    });
    req.on('error', (e) => resolve({ error: e.message, hint: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(e.message) ? '无法连接，检查地址/网络/代理' : '' }));
    req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时 (20s)', hint: '中转站响应过慢或网络不通' }); });
    req.write(payload);
    req.end();
  });
}

// ========== HTTP SERVER ==========

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method.toUpperCase();

  // --- Security guard ---
  // RelayManager is a localhost-only tool that exposes API keys and can kill
  // processes, so we lock it down on two fronts:
  //   1. Host header must be localhost/127.0.0.1 — defends against DNS-rebinding
  //      attacks where an attacker-controlled domain resolves to 127.0.0.1.
  //   2. No wildcard CORS. Cross-origin requests (e.g. from a malicious web page
  //      you happen to have open) are rejected — defends against CSRF and key
  //      exfiltration. Same-origin requests from the UI need no CORS headers.
  const hostHeader = (req.headers.host || '').toLowerCase();
  const hostOk = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hostHeader);
  if (!hostOk) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden: RelayManager only accepts local requests' }));
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    let originOk = false;
    try {
      const oh = new URL(origin).hostname;
      originOk = (oh === 'localhost' || oh === '127.0.0.1' || oh === '::1');
    } catch (e) { originOk = false; }
    if (!originOk) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: cross-origin request rejected' }));
      return;
    }
    // Legitimate same-origin request: echo back the exact origin, never '*'.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Read body for POST
  let body = '';
  if (method === 'POST') {
    for await (const chunk of req) body += chunk;
  }

  try {
    // === ROUTES ===

    // Static: serve index.html
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(html);
      return;
    }

    // GET /api/state
    if (method === 'GET' && url.pathname === '/api/state') {
      const state = {
        claudeCode: readClaudeCode(),
        claudeDesktop: readClaudeDesktop(),
        codexCli: readCodexCli(),
        codexDesktop: readCodexDesktop(),
        proxy: readProxy(),
        uiSettings: readUiSettings(),
      };
      const r = json(state);
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // POST /api/save — full config save
    if (method === 'POST' && url.pathname === '/api/save') {
      const data = JSON.parse(body || '{}');
      const backups = [];

      if (data.claudeCode) {
        await writeClaudeCode(data.claudeCode);
        backups.push('claude-code-settings.json');
      }
      if (data.claudeDesktop) {
        // Full save (authScheme/provider/models/egress + normalization). The
        // lightweight writeClaudeDesktopPrep is only for sync-all / quick-fill.
        await writeClaudeDesktop(data.claudeDesktop);
        backups.push('claude-desktop-config.json');
      }
      if (data.codexCli) {
        await writeCodexCli(data.codexCli);
        backups.push('codex-cli-config.toml');
      }
      if (data.codexDesktop) {
        await writeCodexDesktop(data.codexDesktop);
        backups.push('codex-desktop');
      }
      if (data.proxy) {
        await writeProxy(data.proxy);
        backups.push('proxy-.env');
      }
      if (data.uiSettings) {
        await writeUiSettings(data.uiSettings);
        backups.push('ui-settings.json');
      }

      const r = json({ success: true, backups });
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // GET /api/proxy/status
    if (method === 'GET' && url.pathname === '/api/proxy/status') {
      const status = checkProxyStatus();
      const r = json(status);
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // POST /api/proxy/start
    if (method === 'POST' && url.pathname === '/api/proxy/start') {
      const result = startProxy();
      const r = json({ success: true, ...result });
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // POST /api/proxy/stop
    if (method === 'POST' && url.pathname === '/api/proxy/stop') {
      const result = stopProxy();
      const r = json({ success: true, results: result });
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // POST /api/proxy/apply — apply proxy env without full save
    if (method === 'POST' && url.pathname === '/api/proxy/apply') {
      const data = JSON.parse(body || '{}');
      await writeProxy(data);
      const r = json({ success: true });
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // POST /api/restart/:product — restart a desktop app
    const restartMatch = url.pathname.match(/^\/api\/restart\/(.+)$/);
    if (method === 'POST' && restartMatch) {
      const product = restartMatch[1];
      const result = restartApp(product);
      const r = json({ success: true, ...result });
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // GET /api/test-message?baseUrl=...&apiKey=...&model=... — real /v1/messages probe
    if (method === 'GET' && url.pathname === '/api/test-message') {
      const baseUrl = url.searchParams.get('baseUrl');
      const apiKey = url.searchParams.get('apiKey');
      const model = url.searchParams.get('model') || '';
      const authScheme = url.searchParams.get('authScheme') || undefined;
      const maxTokens = parseInt(url.searchParams.get('maxTokens')) || 16;
      if (!baseUrl || (!apiKey && authScheme !== 'none')) {
        const r = error('Missing baseUrl or apiKey query parameter', 400);
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
      // Feature #7: time the probe and additionally try GET /v1/models so the UI
      // can report "connected, detected N models" vs "connected but no model list".
      const t0 = Date.now();
      const result = await testMessageAPI(baseUrl, apiKey, model, { authScheme, maxTokens });
      result.duration_ms = Date.now() - t0;
      // Probe models regardless of message result — gives a richer summary.
      try {
        const modelsRes = await fetchModelsFromAPI(baseUrl, apiKey);
        if (modelsRes && modelsRes.success && Array.isArray(modelsRes.models)) {
          result.modelsDetected = modelsRes.models.length;
          result.modelsList = modelsRes.models.slice(0, 50).map(m => m.id);
        } else {
          result.modelsDetected = 0;
          result.modelsError = (modelsRes && modelsRes.error) || '未获取到模型列表';
        }
      } catch (e) {
        result.modelsDetected = 0;
        result.modelsError = e.message;
      }
      const r = json(result);
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // GET /api/models?baseUrl=...&apiKey=... — fetch available models from relay
    if (method === 'GET' && url.pathname === '/api/models') {
      const baseUrl = url.searchParams.get('baseUrl');
      const apiKey = url.searchParams.get('apiKey');
      if (!baseUrl || !apiKey) {
        const r = error('Missing baseUrl or apiKey query parameter', 400);
        res.writeHead(r.code, { 'Content-Type': r.type });
        res.end(r.body);
        return;
      }
      const result = await fetchModelsFromAPI(baseUrl, apiKey);
      const r = json(result);
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // GET /api/paths — read app exe paths (auto-detected + user config)
    if (method === 'GET' && url.pathname === '/api/paths') {
      const r = json(getAppsInfo());
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // GET /api/autostart — check if auto-start is enabled
    if (method === 'GET' && url.pathname === '/api/autostart') {
      const r = json({ enabled: isAutostartEnabled(), vbsPath: AUTOSTART_PATH, platform: process.platform });
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // POST /api/autostart — enable/disable auto-start on boot
    if (method === 'POST' && url.pathname === '/api/autostart') {
      const data = JSON.parse(body || '{}');
      if (data.enabled) {
        enableAutostart();
        const r = json({ success: true, enabled: true, vbsPath: AUTOSTART_PATH });
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      } else {
        disableAutostart();
        const r = json({ success: true, enabled: false });
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
    }

    // POST /api/paths — save user-configured exe paths
    if (method === 'POST' && url.pathname === '/api/paths') {
      const data = JSON.parse(body || '{}');
      const cfg = loadPathsConfig();
      for (const key of Object.keys(APPS)) {
        if (data[key] !== undefined) {
          const v = (data[key] || '').trim();
          if (v) cfg[key] = v;
          else delete cfg[key];
        }
      }
      await atomicWrite(PATHS_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
      applyPathsConfig();
      const r = json({ success: true, apps: getAppsInfo() });
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // GET /api/gateway — read gateway config
    if (method === 'GET' && url.pathname === '/api/gateway') {
      const r = json(readGatewayConfig());
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // POST /api/gateway — save gateway config (upstream + routes)
    if (method === 'POST' && url.pathname === '/api/gateway') {
      const data = JSON.parse(body || '{}');
      const cfg = readGatewayConfig();
      if (data.upstreamBaseUrl !== undefined) cfg.upstreamBaseUrl = data.upstreamBaseUrl;
      if (data.upstreamApiKey !== undefined) cfg.upstreamApiKey = data.upstreamApiKey;
      if (data.port !== undefined) cfg.port = parseInt(data.port) || GATEWAY_DEFAULT_PORT;
      if (data.thinkingMode !== undefined) cfg.thinkingMode = data.thinkingMode;
      if (data.thinkingBudget !== undefined) cfg.thinkingBudget = parseInt(data.thinkingBudget) || 10000;
      if (data.logging !== undefined) cfg.logging = !!data.logging;
      // Advanced network settings (feature #3). Persisted under cfg.network; the
      // gateway reads config fresh per-request, so these hot-reload immediately.
      if (data.network !== undefined && data.network && typeof data.network === 'object') {
        const n = data.network;
        cfg.network = {
          requestTimeoutSec: numOr(n.requestTimeoutSec, 0),
          readTimeoutSec: numOr(n.readTimeoutSec, 0),
          maxRetries: numOr(n.maxRetries, 0),
          retryBackoffMs: numOr(n.retryBackoffMs, 500),
          customHeaders: (n.customHeaders && typeof n.customHeaders === 'object') ? n.customHeaders : {},
        };
      }
      if (data.routes !== undefined) {
        // routes come as array of {anthropic, backend} from frontend
        const routes = {};
        for (const r of (data.routes || [])) {
          if (r.anthropic) routes[r.anthropic] = r.backend || r.anthropic;
        }
        cfg.routes = routes;
      }
      await writeGatewayConfig(cfg);
      const r = json({ success: true, config: cfg, gatewayUrl: 'http://127.0.0.1:' + (cfg.port || GATEWAY_DEFAULT_PORT) });
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // POST /api/gateway/apply-claude-desktop — point Claude Desktop at the local gateway
    if (method === 'POST' && url.pathname === '/api/gateway/apply-claude-desktop') {
      const cfg = readGatewayConfig();
      const port = cfg.port || GATEWAY_DEFAULT_PORT;
      const gatewayUrl = 'http://127.0.0.1:' + port;
      const models = Object.keys(cfg.routes || {}).map(name => ({ name }));
      const meta = readJSON(PATHS.claudeDesktopMeta);
      if (!meta || !meta.appliedId) {
        const r = error('Claude Desktop 3P config not found (_meta.json missing)', 400);
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
      const filePath = path.join(PATHS.claudeDesktopDir, meta.appliedId + '.json');
      let obj = readJSON(filePath) || {};
      obj.inferenceGatewayBaseUrl = gatewayUrl;
      obj.inferenceGatewayApiKey = 'relay-manager';
      obj.inferenceGatewayAuthScheme = 'bearer';
      obj.inferenceProvider = 'gateway';
      if (models.length > 0) obj.inferenceModels = JSON.stringify(models);
      await backupFile(filePath);
      await atomicWrite(filePath, JSON.stringify(obj, null, 2) + '\n');
      const r = json({ success: true, gatewayUrl, inferenceModels: models });
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // ===== Claude Desktop 3P multi-config management =====
    // GET /api/claude-desktop/configs — list all configs + which is applied
    if (method === 'GET' && url.pathname === '/api/claude-desktop/configs') {
      const r = json(listCDConfigs());
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/claude-desktop/config/create — { name, config? } (config? = import payload)
    if (method === 'POST' && url.pathname === '/api/claude-desktop/config/create') {
      const data = JSON.parse(body || '{}');
      const id = await createCDConfig(data.name, data.config);
      const r = json({ success: true, id, configs: listCDConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/claude-desktop/config/apply — { id }
    if (method === 'POST' && url.pathname === '/api/claude-desktop/config/apply') {
      const data = JSON.parse(body || '{}');
      await applyCDConfig(data.id);
      const r = json({ success: true, configs: listCDConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/claude-desktop/config/delete — { id }
    if (method === 'POST' && url.pathname === '/api/claude-desktop/config/delete') {
      const data = JSON.parse(body || '{}');
      const appliedId = await deleteCDConfig(data.id);
      const r = json({ success: true, appliedId, configs: listCDConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/claude-desktop/config/rename — { id, name }
    if (method === 'POST' && url.pathname === '/api/claude-desktop/config/rename') {
      const data = JSON.parse(body || '{}');
      await renameCDConfig(data.id, data.name);
      const r = json({ success: true, configs: listCDConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // GET /api/claude-desktop/config/export?id=...&stripKey=1 — download portable JSON
    if (method === 'GET' && url.pathname === '/api/claude-desktop/config/export') {
      const id = url.searchParams.get('id');
      if (!id) { const r = error('Missing id', 400); res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return; }
      const stripKey = url.searchParams.get('stripKey') === '1';
      const payload = exportCDConfig(id, stripKey);
      const suffix = stripKey ? '-nokey' : '';
      const fname = 'claude-desktop-' + (payload.name || 'config').replace(/[^\w.-]+/g, '_') + suffix + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + fname + '"',
      });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    // ===== Claude Code CLI — 多套配置（预设）管理 =====
    // GET /api/claude-code/configs — 列出全部预设 + 当前生效 id
    if (method === 'GET' && url.pathname === '/api/claude-code/configs') {
      const r = json(listCCConfigs());
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/claude-code/config/create — { name, config? }（config? = 导入/复制内容）
    if (method === 'POST' && url.pathname === '/api/claude-code/config/create') {
      const data = JSON.parse(body || '{}');
      const id = await createCCConfig(data.name, data.config);
      const r = json({ success: true, id, configs: listCCConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/claude-code/config/apply — { id } 写入 settings.json 并标记生效
    if (method === 'POST' && url.pathname === '/api/claude-code/config/apply') {
      const data = JSON.parse(body || '{}');
      try {
        await applyCCConfig(data.id);
        const r = json({ success: true, configs: listCCConfigs() });
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      } catch (e) {
        const r = error(e.message, 400);
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
    }
    // POST /api/claude-code/config/update — { id, config } 更新预设内容（保存时同步）
    if (method === 'POST' && url.pathname === '/api/claude-code/config/update') {
      const data = JSON.parse(body || '{}');
      try {
        await updateCCConfig(data.id, data.config);
        const r = json({ success: true, configs: listCCConfigs() });
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      } catch (e) {
        const r = error(e.message, 400);
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
    }
    // POST /api/claude-code/config/import — { name, config } 导入后创建并返回新 id
    if (method === 'POST' && url.pathname === '/api/claude-code/config/import') {
      const data = JSON.parse(body || '{}');
      try {
        const id = await createCCConfig(data.name, data.config);
        const r = json({ success: true, id, configs: listCCConfigs() });
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      } catch (e) {
        const r = error(e.message, 400);
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
    }
    // POST /api/claude-code/config/delete — { id }
    if (method === 'POST' && url.pathname === '/api/claude-code/config/delete') {
      const data = JSON.parse(body || '{}');
      const appliedId = await deleteCCConfig(data.id);
      const r = json({ success: true, appliedId, configs: listCCConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/claude-code/config/rename — { id, name }
    if (method === 'POST' && url.pathname === '/api/claude-code/config/rename') {
      const data = JSON.parse(body || '{}');
      await renameCCConfig(data.id, data.name);
      const r = json({ success: true, configs: listCCConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // GET /api/claude-code/config/export?id=...&stripKey=1 — 下载可移植 JSON
    if (method === 'GET' && url.pathname === '/api/claude-code/config/export') {
      const id = url.searchParams.get('id');
      if (!id) { const r = error('Missing id', 400); res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return; }
      const stripKey = url.searchParams.get('stripKey') === '1';
      const payload = exportCCConfig(id, stripKey);
      const suffix = stripKey ? '-nokey' : '';
      const fname = 'claude-code-' + (payload.name || 'config').replace(/[^\w.-]+/g, '_') + suffix + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + fname + '"',
      });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    // ===== CODEX CLI 预设配置路由 =====
    // GET /api/codex-cli/config/list — 列出全部预设及当前应用项
    if (method === 'GET' && url.pathname === '/api/codex-cli/config/list') {
      const r = json(listCodexConfigs());
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/codex-cli/config/create — 新建预设 { name, config }
    if (method === 'POST' && url.pathname === '/api/codex-cli/config/create') {
      const data = JSON.parse(body || '{}');
      const id = await createCodexConfig(data.name, data.config);
      const r = json({ success: true, id, configs: listCodexConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/codex-cli/config/apply — 应用预设 { id }（写入 config.toml）
    if (method === 'POST' && url.pathname === '/api/codex-cli/config/apply') {
      const data = JSON.parse(body || '{}');
      await applyCodexConfig(data.id);
      const r = json({ success: true, configs: listCodexConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/codex-cli/config/update — 更新预设 { id, config }
    if (method === 'POST' && url.pathname === '/api/codex-cli/config/update') {
      const data = JSON.parse(body || '{}');
      await updateCodexConfig(data.id, data.config);
      const r = json({ success: true, configs: listCodexConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
// POST /api/codex-cli/config/delete — 删除预设 { id }
    if (method === 'POST' && url.pathname === '/api/codex-cli/config/delete') {
      const data = JSON.parse(body || '{}');
      const appliedId = await deleteCodexConfig(data.id);
      const r = json({ success: true, appliedId, configs: listCodexConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/codex-cli/config/rename — 重命名预设 { id, name }
    if (method === 'POST' && url.pathname === '/api/codex-cli/config/rename') {
      const data = JSON.parse(body || '{}');
      await renameCodexConfig(data.id, data.name);
      const r = json({ success: true, configs: listCodexConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // GET /api/codex-cli/config/export?id=...&stripKey=1 — 下载可移植 JSON
    if (method === 'GET' && url.pathname === '/api/codex-cli/config/export') {
      const id = url.searchParams.get('id');
      if (!id) { const r = error('Missing id', 400); res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return; }
      const stripKey = url.searchParams.get('stripKey') === '1';
      const payload = exportCodexConfig(id, stripKey);
      const suffix = stripKey ? '-nokey' : '';
      const fname = 'codex-cli-' + (payload.name || 'config').replace(/[^\w.-]+/g, '_') + suffix + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + fname + '"',
      });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }
    // POST /api/codex-cli/config/import — 导入 JSON 预设 { name, config }
    if (method === 'POST' && url.pathname === '/api/codex-cli/config/import') {
      const data = JSON.parse(body || '{}');
      try {
        // 导入只创建预设，不覆写 config.toml（保守策略，与 Claude Code 版差异）
        const id = await createCodexConfig(data.name, data.config);
        const r = json({ success: true, id, configs: listCodexConfigs() });
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      } catch (e) {
        const r = error(e.message, 400);
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
    }
    // ===== CODEX DESKTOP 预设配置路由 =====
    // GET /api/codex-desktop/config/list — 列出全部预设及当前应用项
    if (method === 'GET' && url.pathname === '/api/codex-desktop/config/list') {
      const r = json(listCXDConfigs());
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/codex-desktop/config/create — 新建预设 { name, config }
    if (method === 'POST' && url.pathname === '/api/codex-desktop/config/create') {
      const data = JSON.parse(body || '{}');
      const id = await createCXDConfig(data.name, data.config);
      const r = json({ success: true, id, configs: listCXDConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/codex-desktop/config/apply — 应用预设 { id }（写入 config.json + codex.json）
    if (method === 'POST' && url.pathname === '/api/codex-desktop/config/apply') {
      const data = JSON.parse(body || '{}');
      await applyCXDConfig(data.id);
      const r = json({ success: true, configs: listCXDConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/codex-desktop/config/update — 更新预设 { id, config }
    if (method === 'POST' && url.pathname === '/api/codex-desktop/config/update') {
      const data = JSON.parse(body || '{}');
      await updateCXDConfig(data.id, data.config);
      const r = json({ success: true, configs: listCXDConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/codex-desktop/config/delete — 删除预设 { id }
    if (method === 'POST' && url.pathname === '/api/codex-desktop/config/delete') {
      const data = JSON.parse(body || '{}');
      const appliedId = await deleteCXDConfig(data.id);
      const r = json({ success: true, appliedId, configs: listCXDConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/codex-desktop/config/rename — 重命名预设 { id, name }
    if (method === 'POST' && url.pathname === '/api/codex-desktop/config/rename') {
      const data = JSON.parse(body || '{}');
      await renameCXDConfig(data.id, data.name);
      const r = json({ success: true, configs: listCXDConfigs() });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // GET /api/codex-desktop/config/export?id=...&stripKey=1 — 下载可移植 JSON
    if (method === 'GET' && url.pathname === '/api/codex-desktop/config/export') {
      const id = url.searchParams.get('id');
      if (!id) { const r = error('Missing id', 400); res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return; }
      const stripKey = url.searchParams.get('stripKey') === '1';
      const payload = exportCXDConfig(id, stripKey);
      const suffix = stripKey ? '-nokey' : '';
      const fname = 'codex-desktop-' + (payload.name || 'config').replace(/[^\w.-]+/g, '_') + suffix + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + fname + '"',
      });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }
    // POST /api/codex-desktop/config/import — 导入 JSON 预设 { name, config }
    if (method === 'POST' && url.pathname === '/api/codex-desktop/config/import') {
      const data = JSON.parse(body || '{}');
      try {
        const id = await createCXDConfig(data.name, data.config);
        const r = json({ success: true, id, configs: listCXDConfigs() });
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      } catch (e) {
        const r = error(e.message, 400);
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
    }

    // ===== Feature #2: GET /api/gateway/models — sync model list from upstream =====
    // Uses the gateway's configured upstream Base URL + key (or query overrides) to
    // fetch /v1/models, returning the list of model IDs.
    if (method === 'GET' && url.pathname === '/api/gateway/models') {
      const gw = readGatewayConfig();
      const baseUrl = url.searchParams.get('baseUrl') || gw.upstreamBaseUrl;
      const apiKey = url.searchParams.get('apiKey') || gw.upstreamApiKey;
      if (!baseUrl) { const r = error('网关上游 Base URL 未配置', 400); res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return; }
      const result = await fetchModelsFromAPI(baseUrl, apiKey);
      const r = json(result);
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }

    // ===== Feature #4: debug logs =====
    // GET /api/logs — return the in-memory ring buffer (already redacted)
    if (method === 'GET' && url.pathname === '/api/logs') {
      const r = json({ logs: debugLog.getLogs(), max: debugLog.MAX_LOGS });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // DELETE /api/logs — clear the buffer
    if (method === 'DELETE' && url.pathname === '/api/logs') {
      debugLog.clearLogs();
      const r = json({ success: true });
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }

    // ===== Feature #5: config history & rollback =====
    // GET /api/config/history?product=claude-code|claude-desktop|codex-cli|codex-desktop
    if (method === 'GET' && url.pathname === '/api/config/history') {
      const product = url.searchParams.get('product') || '';
      const result = listConfigHistory(product);
      const r = json(result);
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/config/rollback — { product, filename }
    if (method === 'POST' && url.pathname === '/api/config/rollback') {
      const data = JSON.parse(body || '{}');
      try {
        const result = await rollbackConfig(data.product, data.filename);
        const r = json({ success: true, ...result });
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      } catch (e) {
        const r = error(e.message, 400);
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
    }

    // ===== Feature #6: process status & restart =====
    // GET /api/process/status?product=claude-desktop|codex-desktop|proxy
    if (method === 'GET' && url.pathname === '/api/process/status') {
      const product = url.searchParams.get('product') || 'claude-desktop';
      const r = json(getProcessStatus(product));
      res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
    }
    // POST /api/process/restart — { product } (kill -> wait 2s -> start)
    if (method === 'POST' && url.pathname === '/api/process/restart') {
      const data = JSON.parse(body || '{}');
      const product = data.product || 'claude-desktop';
      try {
        const result = restartApp(product);
        const r = json({ success: true, ...result });
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      } catch (e) {
        const r = error(e.message, 400);
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
    }

    // 404
    const r = error('Not found', 404);
    res.writeHead(r.code, { 'Content-Type': r.type });
    res.end(r.body);

  } catch (e) {
    console.error('Error:', e.message);
    const r = error(e.message, 500);
    res.writeHead(r.code, { 'Content-Type': r.type });
    res.end(r.body);
  }
});

// Bind to 127.0.0.1 (loopback only), never 0.0.0.0 — this server exposes API
// keys via /api/state and can kill processes, so it must not be reachable from
// other devices on the LAN. The relay gateway already binds to 127.0.0.1 too.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const stopHint = IS_WIN ? '双击「停止.bat」' : '运行 ./stop.sh 或 kill 已有进程';
    console.error(`端口 ${PORT} 已被占用 —— RelayManager 可能已在运行。请先关闭已有实例（${stopHint}），或修改 server.js 顶部的 PORT。`);
    process.exit(1);
  }
  console.error('Server error:', e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`RelayManager running at http://localhost:${PORT}`);
  console.log(`Platform: ${process.platform} (${IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux'})`);
  console.log(`Config path: ${PATHS.claudeCode}`);
  console.log(`Clash Verge: ${clashExe || '(未检测到)'} (${clashExe && fs.existsSync(clashExe) ? 'found' : 'NOT FOUND'})`);
  startGatewayServer();
});
