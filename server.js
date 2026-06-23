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

// Backup file with timestamp
async function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const backupDir = path.join(dir, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${base}-${timestamp()}${ext}`);
  await fsp.copyFile(filePath, backupPath);
  return backupPath;
}

// ========== READ FUNCTIONS ==========

function readClaudeCode() {
  const obj = readJSON(PATHS.claudeCode);
  if (!obj || !obj.env) return { authToken: '', baseUrl: '', opusModel: '', sonnetModel: '', haikuModel: '', model: '', reasoningModel: '', subagentModel: '', apiTimeoutMs: '3000000', disableNonessential: '1', attributionHeader: '0', effortLevel: 'high' };
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
  };
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
  obj.env.ANTHROPIC_AUTH_TOKEN = data.authToken || '';
  obj.env.ANTHROPIC_BASE_URL = data.baseUrl || '';
  if (data.opusModel) obj.env.ANTHROPIC_DEFAULT_OPUS_MODEL = data.opusModel;
  if (data.sonnetModel) obj.env.ANTHROPIC_DEFAULT_SONNET_MODEL = data.sonnetModel;
  if (data.haikuModel) obj.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = data.haikuModel;
  if (data.model) { obj.env.ANTHROPIC_MODEL = data.model; obj.model = data.model; }
  if (data.reasoningModel) obj.env.ANTHROPIC_REASONING_MODEL = data.reasoningModel;
  if (data.subagentModel !== undefined) obj.env.CLAUDE_CODE_SUBAGENT_MODEL = data.subagentModel;
  if (data.apiTimeoutMs !== undefined) obj.env.API_TIMEOUT_MS = String(data.apiTimeoutMs);
  if (data.disableNonessential !== undefined) obj.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = data.disableNonessential ? '1' : '0';
  if (data.attributionHeader !== undefined) obj.env.CLAUDE_CODE_ATTRIBUTION_HEADER = data.attributionHeader ? '1' : '0';
  if (data.effortLevel) { obj.effortLevel = data.effortLevel; obj.env.CLAUDE_CODE_EFFORT_LEVEL = data.effortLevel; }
  await backupFile(filePath);
  await atomicWrite(filePath, JSON.stringify(obj, null, 2) + '\n');
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

  let portListening = false;
  try {
    const sock = new net.Socket();
    sock.setTimeout(1000);
    sock.connect(parseInt(port), '127.0.0.1', () => { portListening = true; sock.destroy(); });
    sock.on('error', () => { sock.destroy(); });
    // Need to wait synchronously... use a simple approach:
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
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

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

server.listen(PORT, () => {
  console.log(`RelayManager running at http://localhost:${PORT}`);
  console.log(`Config path: ${PATHS.claudeCode}`);
  console.log(`Clash Verge: ${clashExe} (${fs.existsSync(clashExe) ? 'found' : 'NOT FOUND'})`);
  startGatewayServer();
});
