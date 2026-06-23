const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execSync, spawn } = require('child_process');
const toml = require('@iarna/toml');
const net = require('net');

const PORT = 9876;
const HOME = process.env.USERPROFILE || 'C:\\Users\\admin';

// ========== CONFIG FILE PATHS ==========
const PATHS = {
  claudeCode: path.join(HOME, '.claude', 'settings.json'),
  claudeDesktopMeta: path.join(HOME, 'AppData', 'Local', 'Claude-3p', 'configLibrary', '_meta.json'),
  claudeDesktopDir: path.join(HOME, 'AppData', 'Local', 'Claude-3p', 'configLibrary'),
  codexCli: path.join(HOME, '.codex', 'config.toml'),
  codexDesktopConfig: path.join(HOME, 'AppData', 'Roaming', 'ccx-desktop', '.config', 'config.json'),
  codexDesktopInjection: path.join(HOME, 'AppData', 'Roaming', 'ccx-desktop', 'agent-config-state', 'codex.json'),
  proxyEnv: path.join(HOME, '.codex', '.env'),
  clashVergeDir: 'C:\\Program Files\\Clash Verge',
};
// Find clash-verge exe
let clashExe = path.join(PATHS.clashVergeDir, 'Clash Verge.exe');
if (!fs.existsSync(clashExe)) {
  const alt = path.join(PATHS.clashVergeDir, 'clash-verge.exe');
  if (fs.existsSync(alt)) clashExe = alt;
}

// ========== APP RESTART PATHS ==========
// Auto-detected defaults; user can override via paths.json (GET/POST /api/paths)
function detectExe(candidates) {
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return null;
}

const APPS = {
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
const STARTUP_DIR = path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const AUTOSTART_VBS = path.join(STARTUP_DIR, 'RelayManager.vbs');
const NODE_EXE = process.execPath;
const SERVER_JS_PATH = path.join(__dirname, 'server.js');

function isAutostartEnabled() {
  return fs.existsSync(AUTOSTART_VBS);
}
function enableAutostart() {
  fs.mkdirSync(STARTUP_DIR, { recursive: true });
  const cmd = `"${NODE_EXE}" "${SERVER_JS_PATH}"`;
  const vbsCmd = '"' + cmd.replace(/"/g, '""') + '"';
  const vbs = `' RelayManager auto-start (silent, no console window)\r\nCreateObject("WScript.Shell").Run ${vbsCmd}, 0, False\r\n`;
  fs.writeFileSync(AUTOSTART_VBS, vbs, 'utf-8');
}
function disableAutostart() {
  try { if (fs.existsSync(AUTOSTART_VBS)) fs.unlinkSync(AUTOSTART_VBS); } catch (e) {}
}

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
  if (!fs.existsSync(PATHS.codexCli)) return { baseUrl: '', apiKey: '', model: 'gpt-5.5', modelProvider: 'custom', providerName: 'My Codex', wireApi: 'responses', requiresOpenaiAuth: true, reasoningEffort: 'high' };
  const raw = fs.readFileSync(PATHS.codexCli, 'utf-8');
  const obj = toml.parse(raw);
  const custom = (obj.model_providers && obj.model_providers.custom) || {};
  return {
    baseUrl: custom.base_url || '',
    apiKey: custom.experimental_bearer_token || '',
    model: obj.model || 'gpt-5.5',
    modelProvider: obj.model_provider || 'custom',
    providerName: custom.name || 'My Codex',
    wireApi: custom.wire_api || 'responses',
    requiresOpenaiAuth: custom.requires_openai_auth !== false,
    reasoningEffort: obj.model_reasoning_effort || 'high',
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

async function writeClaudeDesktop(data) {
  const meta = readJSON(PATHS.claudeDesktopMeta);
  if (!meta || !meta.appliedId) throw new Error('Claude Desktop 3P config not found (_meta.json missing)');
  const configId = meta.appliedId;
  const filePath = path.join(PATHS.claudeDesktopDir, `${configId}.json`);
  let obj = readJSON(filePath) || {};
  if (data.apiKey !== undefined) obj.inferenceGatewayApiKey = data.apiKey;
  if (data.baseUrl !== undefined) obj.inferenceGatewayBaseUrl = data.baseUrl;
  if (data.authScheme !== undefined) obj.inferenceGatewayAuthScheme = data.authScheme;
  if (data.provider !== undefined) obj.inferenceProvider = data.provider;
  if (data.models !== undefined) obj.inferenceModels = data.models; // Keep as JSON string
  if (data.egressHosts !== undefined) obj.coworkEgressAllowedHosts = data.egressHosts.split(',').map(s => s.trim()).filter(Boolean);
  if (data.disableDeploymentChooser !== undefined) obj.disableDeploymentModeChooser = data.disableDeploymentChooser;
  await backupFile(filePath);
  await atomicWrite(filePath, JSON.stringify(obj, null, 2) + '\n');
}

async function writeCodexCli(data) {
  const filePath = PATHS.codexCli;
  let raw = fs.readFileSync(filePath, 'utf-8');

  // Helper: replace or append a key=value under a section
  function setTomlValue(section, key, value) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let valStr;
    if (typeof value === 'boolean') valStr = String(value);
    else if (typeof value === 'string') valStr = `"${value}"`;
    else valStr = String(value);

    if (section) {
      // Find the section header, then find the key after it (before next section or EOF)
      const sectionEscaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const sectionRegex = new RegExp(`(\\[${sectionEscaped}\\][^\\[]*?)(${escapedKey}\\s*=\\s*)([^\\n]*)`, 's');
      if (sectionRegex.test(raw)) {
        raw = raw.replace(sectionRegex, `$1$2${valStr}`);
      } else {
        // Key not found in section — append after the section header
        const appendRegex = new RegExp(`(\\[${sectionEscaped}\\]\\s*\\n)`, 's');
        if (appendRegex.test(raw)) {
          raw = raw.replace(appendRegex, `$1${key} = ${valStr}\n`);
        }
      }
    } else {
      // Top-level key
      const topRegex = new RegExp(`^(${escapedKey}\\s*=\\s*)([^\\n]*)`, 'm');
      if (topRegex.test(raw)) {
        raw = raw.replace(topRegex, `$1${valStr}`);
      } else {
        raw += `\n${key} = ${valStr}\n`;
      }
    }
  }

  setTomlValue('model_providers.custom', 'base_url', data.baseUrl || '');
  setTomlValue('model_providers.custom', 'experimental_bearer_token', data.apiKey || '');
  if (data.model) setTomlValue(null, 'model', data.model);
  if (data.modelProvider) setTomlValue(null, 'model_provider', data.modelProvider);
  if (data.reasoningEffort) setTomlValue(null, 'model_reasoning_effort', data.reasoningEffort);
  if (data.providerName) setTomlValue('model_providers.custom', 'name', data.providerName);
  if (data.wireApi !== undefined) setTomlValue('model_providers.custom', 'wire_api', data.wireApi);
  if (data.requiresOpenaiAuth !== undefined) setTomlValue('model_providers.custom', 'requires_openai_auth', data.requiresOpenaiAuth);

  await backupFile(filePath);
  await atomicWrite(filePath, raw);
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

  const content = `# Clash Verge / mihomo mixed proxy
HTTP_PROXY=${proxyUrl}
HTTPS_PROXY=${proxyUrl}
ALL_PROXY=${proxyUrl}
http_proxy=${proxyUrl}
https_proxy=${proxyUrl}
all_proxy=${proxyUrl}
NO_PROXY=${noProxy}
no_proxy=${noProxy}
${wsOn ? `WS_PROXY=${proxyUrl}\nws_proxy=${proxyUrl}\n` : ''}${wssOn ? `WSS_PROXY=${proxyUrl}\nwss_proxy=${proxyUrl}\n` : ''}`;

  await backupFile(filePath);
  await atomicWrite(filePath, content);
}

// ========== PROXY MANAGEMENT ==========

function checkProxyStatus() {
  const port = (readProxy()).proxyPort || '7897';
  let processRunning = false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq clash-verge.exe" /FO CSV /NH 2>nul', { encoding: 'utf-8', timeout: 3000 });
    if (out.includes('clash-verge.exe')) processRunning = true;
  } catch (e) { /* not running */ }
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq verge-mihomo.exe" /FO CSV /NH 2>nul', { encoding: 'utf-8', timeout: 3000 });
    if (out.includes('verge-mihomo.exe')) processRunning = true;
  } catch (e) { /* not running */ }

  // Synchronous port check via netstat. (A previous version also created a
  // net.Socket here, but the async connect could never settle before the
  // synchronous execSync below returned, so it was dead code — removed.)
  let portListening = false;
  try {
    const result = execSync(`netstat -ano 2>nul | findstr ":${port} " | findstr "LISTENING"`, { encoding: 'utf-8', timeout: 2000 });
    if (result.trim()) portListening = true;
  } catch (e) { portListening = false; }

  return { processRunning, portListening, port: parseInt(port) };
}

function startProxy() {
  if (!fs.existsSync(clashExe)) {
    throw new Error(`Clash Verge not found at: ${clashExe}`);
  }
  const proc = spawn(clashExe, [], { detached: true, stdio: 'ignore', windowsHide: false });
  proc.unref();
  return { pid: proc.pid, exe: clashExe };
}

function stopProxy() {
  const results = [];
  for (const name of ['clash-verge.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe']) {
    try {
      const out = execSync(`taskkill /f /im "${name}" 2>nul`, { encoding: 'utf-8', timeout: 5000 });
      results.push({ process: name, result: out.trim() || 'terminated' });
    } catch (e) {
      results.push({ process: name, result: 'not running' });
    }
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

function findProcesses(names) {
  const found = [];
  for (const name of names) {
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /FO CSV /NH 2>nul`, { encoding: 'utf-8', timeout: 3000 });
      for (const line of out.trim().split('\n')) {
        const m = line.match(/"([^"]+)","(\d+)"/);
        if (m) found.push({ name: m[1], pid: parseInt(m[2]) });
      }
    } catch (e) {}
  }
  return found;
}

function killApp(processNames) {
  const killed = [];
  for (const name of processNames) {
    try {
      execSync(`taskkill /f /im "${name}" 2>nul`, { encoding: 'utf-8', timeout: 5000 });
      killed.push(name);
    } catch (e) {}
  }
  return killed;
}

function startApp(exePath) {
  if (!exePath || !fs.existsSync(exePath)) throw new Error('App not found: ' + exePath);
  const proc = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false });
  proc.unref();
  return { pid: proc.pid };
}

function restartApp(product) {
  const app = APPS[product];
  if (!app) throw new Error('Unknown product: ' + product);
  const killed = killApp(app.processes);
  execSync('timeout /t 1 /nobreak >nul 2>&1', { timeout: 2000 });
  // If we have a valid exe path, relaunch; otherwise just kill (user reopens manually)
  if (app.exe && fs.existsSync(app.exe)) {
    const started = startApp(app.exe);
    return { product, name: app.name, killed, pid: started.pid, relaunched: true };
  }
  return {
    product, name: app.name, killed, relaunched: false,
    warning: '未配置 ' + app.name + ' 的 exe 路径，已关闭进程但无法自动重启。请在「应用路径」中填写 exe 路径，或手动重新打开 ' + app.name + '。',
  };
}

// ========== RELAY GATEWAY (model-name rewriting proxy) ==========
// Replaces CC Switch's local gateway. Claude Desktop sends Anthropic model names
// (e.g. claude-sonnet-4-5) here; the gateway rewrites them to backend models
// (e.g. glm-5.2) per user config, then forwards to the real relay.

const GATEWAY_CONFIG_FILE = path.join(__dirname, 'gateway.json');
const GATEWAY_DEFAULT_PORT = 9877;

function readGatewayConfig() {
  try { return JSON.parse(fs.readFileSync(GATEWAY_CONFIG_FILE, 'utf-8')); }
  catch (e) {
    return { port: GATEWAY_DEFAULT_PORT, upstreamBaseUrl: '', upstreamApiKey: '', routes: {} };
  }
}
async function writeGatewayConfig(cfg) {
  await atomicWrite(GATEWAY_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

function forwardToUpstream(req, clientRes, reqPath, body, cfg) {
  if (!cfg.upstreamBaseUrl) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: { message: 'Relay gateway: 上游中转站未配置，请在 RelayManager 中设置' } }));
    return;
  }
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
  const upstreamReq = httpMod.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (isHttps ? 443 : 80),
    path: fullPath,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(clientRes); // stream response (supports SSE)
  });
  upstreamReq.on('error', (e) => {
    try {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { message: 'Relay gateway upstream error: ' + e.message } }));
    } catch (_) {}
  });
  upstreamReq.write(body);
  upstreamReq.end();
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
        try {
          const parsed = JSON.parse(body);
          if (parsed.model && routes[parsed.model]) {
            parsed.model = routes[parsed.model]; // Anthropic name -> backend model
          }
          outBody = JSON.stringify(parsed);
        } catch (e) { /* non-JSON, forward as-is */ }
        forwardToUpstream(req, res, u.pathname + u.search, outBody, currentCfg);
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
function testMessageAPI(baseUrl, apiKey, model) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(baseUrl); } catch (e) { return resolve({ error: 'Base URL 格式无效: ' + baseUrl }); }
    let apiPath = u.pathname.replace(/\/+$/, '');
    const messagesUrl = /\/v\d+$/.test(apiPath)
      ? u.origin + apiPath + '/messages'
      : u.origin + (apiPath || '') + '/v1/messages';
    const payload = JSON.stringify({
      model: model || 'claude-3-5-sonnet-20241022',
      max_tokens: 16,
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
        'Authorization': 'Bearer ' + apiKey,   // Bearer scheme
        'x-api-key': apiKey,                    // x-api-key scheme (dual auth)
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
        else if (/model/i.test(msg) && /not.*found|invalid|不存在|无权/i.test(msg)) hint = '模型名不被中转站接受，请检查分层模型映射填的名字';
        else if (/thinking|budget|max_thinking/i.test(msg)) hint = '中转站不兼容 thinking 字段，请把「思考模式」切到「关闭思考」';
        else if (code === 404) hint = '/v1/messages 接口 404，Base URL 可能错误（注意是否该带 /anthropic 后缀）';
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
        const bp = await writeClaudeDesktopPrep(data.claudeDesktop);
        if (bp) backups.push(bp);
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
      if (data.syncAll) {
        const syncBackups = await syncAll({ syncAll: data.syncAll });
        backups.push(...syncBackups);
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
      if (!baseUrl || !apiKey) {
        const r = error('Missing baseUrl or apiKey query parameter', 400);
        res.writeHead(r.code, { 'Content-Type': r.type }); res.end(r.body); return;
      }
      const result = await testMessageAPI(baseUrl, apiKey, model);
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
      const r = json({ enabled: isAutostartEnabled(), vbsPath: AUTOSTART_VBS });
      res.writeHead(r.code, { 'Content-Type': r.type });
      res.end(r.body);
      return;
    }

    // POST /api/autostart — enable/disable auto-start on boot
    if (method === 'POST' && url.pathname === '/api/autostart') {
      const data = JSON.parse(body || '{}');
      if (data.enabled) {
        enableAutostart();
        const r = json({ success: true, enabled: true, vbsPath: AUTOSTART_VBS });
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
    console.error(`端口 ${PORT} 已被占用 —— RelayManager 可能已在运行。请先关闭已有实例（双击「停止.bat」），或修改 server.js 顶部的 PORT。`);
    process.exit(1);
  }
  console.error('Server error:', e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`RelayManager running at http://localhost:${PORT}`);
  console.log(`Config path: ${PATHS.claudeCode}`);
  console.log(`Clash Verge: ${clashExe} (${fs.existsSync(clashExe) ? 'found' : 'NOT FOUND'})`);
  startGatewayServer();
});
