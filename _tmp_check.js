
// ========== GLOBAL STATE ==========
let currentState = {};
let fetchedModels = [];
let currentUiSettings = { theme: 'classic', sidebarLayout: 'classic' };

// ========== UI HELPERS ==========
function toast(msg, type) {
  type = type || 'success';
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
function togglePwd(id, btn) {
  const el = document.getElementById(id);
  el.type = el.type === 'password' ? 'text' : 'password';
  btn.textContent = el.type === 'password' ? '\u{1f441}' : '\u{1f512}';
}
function maskKey(k) {
  if (!k) return '(未设置)';
  if (k.length <= 12) return k.slice(0,4) + '***';
  return k.slice(0,8) + '...' + k.slice(-4);
}

// Tab switching
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
  const tab = document.querySelector('.tab[data-tab="' + name + '"]');
  if (tab) tab.classList.add('active');
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
  if (name === 'codex-desktop') renderUpstreamTables();
  if (name === 'models') renderMappingForms();
  if (name === 'claude-desktop') renderCDModels();
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

// Fetch source toggle
document.getElementById('fetch-source').addEventListener('change', function() {
  document.getElementById('fetch-custom-fields').style.display = this.value === 'custom' ? 'block' : 'none';
});

// ========== API CALLS ==========
async function api(path, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}

async function loadState() {
  try {
    currentState = await api('/api/state', 'GET');
    populateAllForms();
    renderStatusGrid();
    renderUpstreamTables();
    renderMappingForms();
    loadAppPaths();
    proxyRefreshStatus();
  } catch (e) {
    toast('加载配置失败: ' + e.message, 'error');
  }
}

function loadUiSettings() {
  try {
    const saved = currentState.uiSettings || { theme: 'classic', sidebarLayout: 'classic' };
    currentUiSettings.theme = saved.theme || 'classic';
    currentUiSettings.sidebarLayout = saved.sidebarLayout || 'classic';
  } catch (e) {}
  setTheme(currentUiSettings.theme);
  applySidebarLayout(currentUiSettings.sidebarLayout);
}


// ========== POPULATE FORMS ==========
function populateAllForms() {
  const s = currentState;
  const cc = s.claudeCode || {};
  const cd = s.claudeDesktop || {};
  const cx = s.codexCli || {};
  const cxd = s.codexDesktop || {};

  // Claude Code
  setVal('cc-base-url', cc.baseUrl); setVal('cc-api-key', cc.authToken);
  setVal('cc-opus-model', cc.opusModel); setVal('cc-sonnet-model', cc.sonnetModel);
  setVal('cc-haiku-model', cc.haikuModel); setVal('cc-model', cc.model);
  setVal('cc-reasoning-model', cc.reasoningModel); setVal('cc-subagent-model', cc.subagentModel);
  setVal('cc-effort', cc.effortLevel || 'high');
  setVal('cc-thinking-mode', cc.thinkingMode || 'adaptive');
  setVal('cc-thinking-budget', cc.thinkingBudget || '10000');
  onThinkingModeChange();
  setVal('cc-timeout', cc.apiTimeoutMs);
  document.getElementById('cc-disable-nonessential').checked = cc.disableNonessential !== '0';
  document.getElementById('cc-attribution-off').checked = cc.attributionHeader === '0';
  loadCCConfigs();

  // Claude Desktop
  setVal('cd-base-url', cd.baseUrl); setVal('cd-api-key', cd.apiKey);
  setVal('cd-auth-scheme', cd.authScheme || 'bearer'); setVal('cd-provider', cd.provider || 'gateway');
  setVal('cd-egress', cd.egressHosts);
  renderCDModels(cd.models);
  loadCDConfigs();

  // Codex CLI
  setVal('cx-base-url', cx.baseUrl); setVal('cx-api-key', cx.apiKey);
  setVal('cx-model', cx.model); setVal('cx-model-provider', cx.modelProvider);
  setVal('cx-provider-name', cx.providerName); setVal('cx-wire-api', cx.wireApi);
  setVal('cx-reasoning', cx.reasoningEffort);
  document.getElementById('cx-openai-auth').checked = cx.requiresOpenaiAuth !== false;
  // Codex CLI — 高级字段
  setVal('cx-reasoning-summary', cx.reasoningSummary || 'auto');
  setVal('cx-verbosity', cx.verbosity || '');
  document.getElementById('cx-disable-storage').checked = !!cx.disableResponseStorage;
  // http_headers 对象 → 文本框，每行 Key: Value
  setVal('cx-http-headers', headersObjToText(cx.httpHeaders));
  setVal('cx-request-retries', cx.requestMaxRetries || '');
  setVal('cx-stream-retries', cx.streamMaxRetries || '');
  setVal('cx-stream-idle', cx.streamIdleTimeoutMs || '');

  // Codex Desktop
  setVal('cxd-injected-url', cxd.injectedBaseUrl); setVal('cxd-injected-key', cxd.injectedApiKey);

  // Sync inputs
  const syncUrl = cc.baseUrl || cd.baseUrl || cx.baseUrl || '';
  const syncKey = cc.authToken || cd.apiKey || cx.apiKey || '';
  setVal('sync-base-url', syncUrl); setVal('sync-api-key', syncKey);
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.tagName === 'SELECT') el.value = val || el.options[0]?.value || '';
  else if (el.type === 'checkbox') el.checked = !!val;
  else el.value = val || '';
}
function getVal(id) { return document.getElementById(id)?.value || ''; }

// ========== STATUS GRID ==========
function renderStatusGrid() {
  const s = currentState;
  const items = [
    { name: 'Claude Code CLI', url: s.claudeCode?.baseUrl, key: s.claudeCode?.authToken },
    { name: 'Claude Desktop 3P', url: s.claudeDesktop?.baseUrl, key: s.claudeDesktop?.apiKey },
    { name: 'Codex CLI', url: s.codexCli?.baseUrl, key: s.codexCli?.apiKey },
    { name: 'Codex Desktop', url: s.codexDesktop?.injectedBaseUrl, key: s.codexDesktop?.injectedApiKey },
  ];
  const grid = document.getElementById('status-grid');
  grid.innerHTML = items.map(i => {
    const hasUrl = i.url && i.url.length > 0;
    return `<div class="status-card">
      <div class="name"><span class="status-dot ${hasUrl ? 'set' : 'unset'}"></span>${i.name}</div>
      <div class="url">${i.url || '(未配置)'}</div>
      <div class="key">${maskKey(i.key)}</div>
    </div>`;
  }).join('');
}

// ========== APP RESTART ==========
async function restartApp(product) {
  const el = document.getElementById('restart-status');
  el.innerHTML = '<span class="loading"></span> 正在重启...';
  try {
    const res = await api('/api/restart/' + product, 'POST');
    if (res.success) {
      if (res.relaunched) {
        toast(`${res.name || product} 已重启 (PID: ${res.pid})`);
        el.innerHTML = `<span style="color:var(--green);">&#x2705; ${res.name} 已重启</span>`;
      } else {
        toast(res.warning || `${res.name} 已关闭，请手动重开`, 'error');
        el.innerHTML = `<span style="color:var(--yellow);">&#x26a0; ${esc(res.warning || '已关闭，无法自动重启，请手动重开')}</span>`;
      }
    } else {
      toast(res.error || '重启失败', 'error');
      el.innerHTML = `<span style="color:var(--red);">&#x274c; 重启失败: ${res.error}</span>`;
    }
  } catch (e) {
    toast('重启失败: ' + e.message, 'error');
    el.innerHTML = `<span style="color:var(--red);">&#x274c; ${e.message}</span>`;
  }
  setTimeout(() => { el.innerHTML = ''; }, 6000);
}

// ========== APP PATHS CONFIG ==========
async function loadAppPaths() {
  try {
    const apps = await api('/api/paths', 'GET');
    for (const key of ['claude-desktop', 'codex-desktop', 'proxy']) {
      const a = apps[key] || {};
      const input = document.getElementById('path-' + key);
      const status = document.getElementById('path-status-' + key);
      if (input) input.value = a.customPath || a.exe || '';
      if (status) {
        if (a.exe) status.innerHTML = '<span style="color:var(--green);">&#x2705; 已检测</span>';
        else status.innerHTML = '<span style="color:var(--red);">&#x274c; 未检测到，请手动填写</span>';
      }
    }
  } catch (e) {}
}

async function saveAppPaths() {
  const data = {
    'claude-desktop': getVal('path-claude-desktop'),
    'codex-desktop': getVal('path-codex-desktop'),
    'proxy': getVal('path-proxy'),
  };
  try {
    const res = await api('/api/paths', 'POST', data);
    if (res.success) {
      toast('应用路径已保存');
      loadAppPaths();
    } else {
      toast(res.error || '保存失败', 'error');
    }
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
}

// ========== AUTO-START ==========
async function loadAutostart() {
  try {
    const res = await api('/api/autostart', 'GET');
    const cb = document.getElementById('autostart-toggle');
    const status = document.getElementById('autostart-status');
    if (cb) cb.checked = !!res.enabled;
    if (status) {
      status.innerHTML = res.enabled
        ? '<span style="color:var(--green);">&#x2705; 已启用</span> — 开机将静默启动 RelayManager（' + esc(res.vbsPath) + '）'
        : '<span style="color:var(--text2);">&#x2610; 未启用</span>';
    }
  } catch (e) {}
}

async function toggleAutostart(enabled) {
  try {
    const res = await api('/api/autostart', 'POST', { enabled: !!enabled });
    if (res.success) {
      toast(enabled ? '已开启开机自启' : '已关闭开机自启');
      loadAutostart();
    } else {
      toast(res.error || '设置失败', 'error');
      loadAutostart();
    }
  } catch (e) {
    toast('设置失败: ' + e.message, 'error');
    loadAutostart();
  }
}

// ========== FETCH MODELS ==========
async function getFetchCredentials() {
  const src = document.getElementById('fetch-source').value;
  if (src === 'custom') {
    return { baseUrl: getVal('fetch-base-url'), apiKey: getVal('fetch-api-key') };
  }
  const s = currentState;
  switch (src) {
    case 'claude-code': return { baseUrl: s.claudeCode?.baseUrl, apiKey: s.claudeCode?.authToken };
    case 'claude-desktop': {
      // Use Claude Desktop configLibrary's baseUrl/apiKey directly (the real relay).
      // If it points to a local gateway (127.0.0.1, e.g. left by CC Switch) which can't
      // list models, fall back to Claude Code's relay (a real upstream) as a convenience.
      const cd = s.claudeDesktop || {};
      const loopback = cd.baseUrl && /^(https?:\/\/)(127\.|localhost)/i.test(cd.baseUrl);
      if (cd.baseUrl && cd.apiKey && !loopback) {
        return { baseUrl: cd.baseUrl, apiKey: cd.apiKey, source: 'Claude Desktop 配置' };
      }
      const cc = s.claudeCode || {};
      if (cc.baseUrl && cc.authToken) {
        return { baseUrl: cc.baseUrl, apiKey: cc.authToken, source: loopback ? 'Claude Desktop 指向本地网关，改用 Claude Code 中转站' : '改用 Claude Code 中转站' };
      }
      return { baseUrl: '', apiKey: '', source: '未找到可用中转站。Claude Desktop 的 Base URL 指向本地网关且 Claude Code 也未配置中转站，请用「自定义」填写真实中转站地址' };
    }
    case 'codex-cli': return { baseUrl: s.codexCli?.baseUrl, apiKey: s.codexCli?.apiKey };
    case 'codex-desktop': {
      const active = (s.codexDesktop?.responsesUpstream || []).filter(e => e.status === 'active').sort((a,b) => (a.priority||99)-(b.priority||99));
      return { baseUrl: active[0]?.baseUrl || '', apiKey: (active[0]?.apiKeys||[])[0] || '' };
    }
  }
  return { baseUrl: '', apiKey: '' };
}

async function fetchModels() {
  const creds = await getFetchCredentials();
  if (!creds.baseUrl || !creds.apiKey) {
    toast(creds.source || '无法获取 API 配置：所选产品的 Base URL 或 API Key 为空', 'error');
    return;
  }
  const status = document.getElementById('fetch-status');
  const sourceHint = creds.source ? '<span style="color:var(--text2);font-size:11px;">(' + esc(creds.source) + ')</span> ' : '';
  status.innerHTML = sourceHint + '<span class="loading"></span> 获取中...';
  try {
    const params = new URLSearchParams({ baseUrl: creds.baseUrl, apiKey: creds.apiKey });
    const res = await fetch('/api/models?' + params);
    const data = await res.json();
    fetchedModels = data.models || [];
    renderModelList(data);
    if (data.success) {
      status.innerHTML = sourceHint + `<span style="color:var(--green);">&#x2705; 获取到 ${data.total} 个模型</span>`;
    } else {
      status.innerHTML = `<span style="color:var(--red);">&#x274c; ${data.error || '获取失败'}</span>`;
    }
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red);">&#x274c; ${e.message}</span>`;
  }
}

function renderModelList(data) {
  const container = document.getElementById('model-list');
  // Populate datalist for Claude Desktop + gateway backend model autocomplete
  const datalist = document.getElementById('cd-model-datalist');
  const gwDatalist = document.getElementById('gw-backend-datalist');
  if (data.models && data.models.length) {
    const opts = data.models.map(m => `<option value="${esc(String(m.id))}">`).join('');
    if (datalist) datalist.innerHTML = opts;
    if (gwDatalist) gwDatalist.innerHTML = opts;
  }
  if (!data.models || data.models.length === 0) {
    container.innerHTML = '<p style="color:var(--text2);font-size:12px;">' + (data.error || '未获取到模型列表') + '</p>';
    return;
  }
  container.innerHTML = '<h3>可用模型 (' + data.models.length + ')</h3>' +
    data.models.map((m, i) => `<div class="model-item">
      <span class="model-id">${esc(String(m.id))}</span>
      <span class="model-owner">${esc(String(m.owned_by||''))}</span>
      <button class="copy-btn" onclick="copyToClipboard('${esc(String(m.id))}')" title="复制模型 ID">&#x1f4cb;</button>
    </div>`).join('');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => toast('已复制: ' + text)).catch(() => toast('复制失败', 'error'));
}

// ========== CLAUDE DESKTOP MODEL LIST EDITOR ==========
let cdModels = []; // array of {name}

function parseCDModels(modelsStr) {
  try {
    const arr = JSON.parse(modelsStr || '[]');
    if (Array.isArray(arr)) return arr.map(m => ({ name: m.name || (typeof m === 'string' ? m : '') }));
  } catch (e) {}
  return [];
}

function renderCDModels(modelsStr) {
  if (modelsStr !== undefined) cdModels = parseCDModels(modelsStr);
  const container = document.getElementById('cd-models-list');
  if (!container) return;
  if (cdModels.length === 0) {
    container.innerHTML = '<p style="color:var(--text2);font-size:12px;">暂无模型，点击下方添加</p>';
    return;
  }
  container.innerHTML = cdModels.map((m, i) => `<div class="mapping-row" style="margin-bottom:6px;">
    <span style="color:var(--text2);font-size:12px;min-width:24px;">${i+1}.</span>
    <input list="cd-model-datalist" value="${esc(m.name||'')}" data-idx="${i}" placeholder="模型 ID，如 claude-sonnet-4-5">
    <button class="btn btn-red btn-sm" onclick="removeCDModel(${i})">&#x2715;</button>
  </div>`).join('');
}

function addCDModel(name) {
  cdModels.push({ name: name || '' });
  renderCDModels();
}

function removeCDModel(idx) {
  cdModels.splice(idx, 1);
  renderCDModels();
}

function collectCDModels() {
  const inputs = document.querySelectorAll('#cd-models-list input[data-idx]');
  const map = {};
  inputs.forEach(inp => { map[inp.dataset.idx] = inp.value; });
  // Preserve order: read current cdModels, update names from inputs
  const result = cdModels
    .map((m, i) => ({ name: String((map[i] !== undefined ? map[i] : m.name) || '').trim() }))
    .filter(m => m.name);
  return JSON.stringify(result);
}

function fillCDModelsFromFetched() {
  if (!fetchedModels || fetchedModels.length === 0) {
    toast('请先在上方「获取可用模型列表」获取模型', 'error');
    return;
  }
  cdModels = fetchedModels.map(m => ({ name: String(m.id) }));
  renderCDModels();
  toast('已填充 ' + fetchedModels.length + ' 个模型，点击保存生效');
}

// ========== MODEL MAPPING FORMS ==========
function renderMappingForms() {
  const s = currentState;
  const cc = s.claudeCode || {};
  const cd = s.claudeDesktop || {};
  const cx = s.codexCli || {};
  const cxd = s.codexDesktop || {};

  // Claude Code mapping
  document.getElementById('mapping-cc').innerHTML = `
    <div class="mapping-row"><span>Opus:</span><input id="map-cc-opus" value="${esc(cc.opusModel||'')}" placeholder="deepseek-v4-pro"></div>
    <div class="mapping-row"><span>Sonnet:</span><input id="map-cc-sonnet" value="${esc(cc.sonnetModel||'')}" placeholder="deepseek-v4-flash"></div>
    <div class="mapping-row"><span>Haiku:</span><input id="map-cc-haiku" value="${esc(cc.haikuModel||'')}" placeholder="deepseek-v4-flash"></div>
    <div class="mapping-row"><span>Default:</span><input id="map-cc-default" value="${esc(cc.model||'')}" placeholder="deepseek-v4-pro"></div>
    <div class="mapping-row"><span>Reasoning:</span><input id="map-cc-reasoning" value="${esc(cc.reasoningModel||'')}" placeholder="deepseek-v4-flash"></div>`;

  // Claude Desktop mapping — edited on the Claude Desktop tab (renderCDModels)
  // (no fields on this tab)

  // Codex CLI mapping
  setVal('mapping-cx-model', cx.model || 'gpt-5.5');
  setVal('mapping-cx-effort', cx.reasoningEffort || 'high');

  // Codex Desktop mapping
  const respUp = cxd.responsesUpstream || [];
  const chatUp = cxd.chatUpstream || [];
  document.getElementById('mapping-cxd-container').innerHTML =
    '<h3>responsesUpstream</h3>' +
    respUp.map((u, i) => `<div class="mapping-row" style="margin-bottom:4px;">
      <span style="font-size:11px;color:var(--text2);min-width:80px;">${esc(u.name||'entry'+i)}</span>
      <span style="font-size:11px;color:var(--text2);min-width:20px;">→</span>
      <input id="map-cxd-${i}" value="${esc(JSON.stringify(u.modelMapping||{}))}" style="flex:1;font-size:11px;" placeholder='{"gpt-5.5":"gpt-5.5"}'>
    </div>`).join('') +
    '<h3 style="margin-top:12px;">chatUpstream</h3>' +
    chatUp.map((u, i) => `<div class="mapping-row" style="margin-bottom:4px;">
      <span style="font-size:11px;color:var(--text2);min-width:80px;">${esc(u.name||'chat'+i)}</span>
      <span style="font-size:11px;color:var(--text2);min-width:20px;">→</span>
      <input id="map-cxd-chat-${i}" value="${esc(JSON.stringify(u.modelMapping||{}))}" style="flex:1;font-size:11px;" placeholder='{"gpt-5.5":"deepseek-v4-pro"}'>
    </div>`).join('');
}

async function saveMappingCC() {
  const data = {
    claudeCode: {
      opusModel: getVal('map-cc-opus'), sonnetModel: getVal('map-cc-sonnet'),
      haikuModel: getVal('map-cc-haiku'), model: getVal('map-cc-default'),
      reasoningModel: getVal('map-cc-reasoning'),
    }
  };
  await api('/api/save', 'POST', data);
  toast('Claude Code 模型映射已保存');
  loadState();
}

// saveMappingCD removed — Claude Desktop models now edited on the Claude Desktop tab via renderCDModels/collectCDModels

async function saveMappingCX() {
  const data = {
    codexCli: {
      model: getVal('mapping-cx-model'),
      reasoningEffort: getVal('mapping-cx-effort'),
    }
  };
  await api('/api/save', 'POST', data);
  toast('Codex CLI 模型映射已保存');
  loadState();
}

async function saveMappingCXD() {
  const s = currentState;
  const respUp = s.codexDesktop?.responsesUpstream || [];
  const chatUp = s.codexDesktop?.chatUpstream || [];
  const errors = [];

  // Validate every modelMapping field BEFORE writing anything, so one bad entry
  // can't half-save. Each must parse to a plain JSON object of string->string.
  function parseMapping(val, label) {
    let parsed;
    try { parsed = JSON.parse(val); }
    catch (e) { errors.push(label + '：JSON 语法错误（' + e.message + '）'); return null; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(label + '：必须是 JSON 对象，如 {"gpt-5.5":"deepseek-v4"}');
      return null;
    }
    for (const k of Object.keys(parsed)) {
      if (typeof parsed[k] !== 'string') {
        errors.push(label + '：键 "' + k + '" 的值必须是字符串');
        return null;
      }
    }
    return parsed;
  }

  const newResp = respUp.map((u, i) => {
    const parsed = parseMapping(getVal('map-cxd-' + i), 'responsesUpstream「' + (u.name || ('entry' + i)) + '」');
    return { u, parsed };
  });
  const newChat = chatUp.map((u, i) => {
    const parsed = parseMapping(getVal('map-cxd-chat-' + i), 'chatUpstream「' + (u.name || ('chat' + i)) + '」');
    return { u, parsed };
  });

  if (errors.length > 0) {
    toast('保存已取消，请先修正：\n' + errors.join('\n'), 'error');
    return;
  }

  // All valid — apply
  newResp.forEach(({ u, parsed }) => { u.modelMapping = parsed; });
  newChat.forEach(({ u, parsed }) => { u.modelMapping = parsed; });

  const data = { codexDesktop: {
    responsesUpstream: newResp.map(x => x.u),
    chatUpstream: newChat.map(x => x.u),
  } };
  await api('/api/save', 'POST', data);
  toast('Codex Desktop 模型映射已保存');
  loadState();
}

// ========== UPSTREAM TABLE ==========
function renderUpstreamTables() {
  const s = currentState;
  const upstreams = (s.codexDesktop && s.codexDesktop.responsesUpstream) || [];
  const table = document.getElementById('responses-upstream-table');
  if (upstreams.length === 0) {
    table.innerHTML = '<p style="color:var(--text2);font-size:12px;">暂无上游配置</p>';
    return;
  }
  table.innerHTML = `<table class="upstream-table">
    <thead><tr><th>名称</th><th>Base URL</th><th>API Key</th><th>模型映射</th><th>优先级</th><th>状态</th><th></th></tr></thead>
    <tbody>${upstreams.map((u, i) => `
      <tr>
        <td><input value="${esc(u.name||'')}" data-idx="${i}" data-field="name" style="width:100px;"></td>
        <td><input value="${esc(u.baseUrl||'')}" data-idx="${i}" data-field="baseUrl" style="width:200px;"></td>
        <td><input type="password" value="${esc((u.apiKeys||[])[0]||'')}" data-idx="${i}" data-field="apiKey0" style="width:180px;"></td>
        <td><span class="mono">${esc(JSON.stringify(u.modelMapping||{}))}</span></td>
        <td><input type="number" value="${u.priority||1}" data-idx="${i}" data-field="priority" style="width:60px;"></td>
        <td><select data-idx="${i}" data-field="status"><option value="active" ${u.status==='active'?'selected':''}>active</option><option value="suspended" ${u.status==='suspended'?'selected':''}>suspended</option></select></td>
        <td><button class="btn btn-red btn-sm" onclick="deleteUpstream(${i})">&#x2715;</button></td>
      </tr>`).join('')}
    </tbody></table>`;
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function collectUpstreamTable() {
  const inputs = document.querySelectorAll('#responses-upstream-table input, #responses-upstream-table select');
  const map = {};
  inputs.forEach(inp => {
    const idx = parseInt(inp.dataset.idx);
    if (!map[idx]) map[idx] = {};
    map[idx][inp.dataset.field] = inp.value;
  });
  const keys = Object.keys(map).sort((a,b) => parseInt(a) - parseInt(b));
  return keys.map((k, i) => {
    const orig = (currentState.codexDesktop?.responsesUpstream || [])[parseInt(k)] || {};
    return {
      ...orig,
      name: map[k].name || orig.name || '',
      baseUrl: map[k].baseUrl || orig.baseUrl || '',
      apiKeys: [map[k].apiKey0 || (orig.apiKeys||[])[0] || ''],
      priority: parseInt(map[k].priority) || orig.priority || 1,
      status: map[k].status || orig.status || 'active',
      modelMapping: orig.modelMapping || {},
      reasoningMapping: orig.reasoningMapping || {},
      serviceType: orig.serviceType || 'responses',
      reasoningParamStyle: orig.reasoningParamStyle || 'reasoning',
      codexToolCompat: orig.codexToolCompat !== undefined ? orig.codexToolCompat : false,
      autoBlacklistBalance: orig.autoBlacklistBalance !== undefined ? orig.autoBlacklistBalance : true,
      normalizeMetadataUserId: orig.normalizeMetadataUserId !== undefined ? orig.normalizeMetadataUserId : true,
      stripBillingHeader: orig.stripBillingHeader || false,
      rateLimitAutoFromHeaders: orig.rateLimitAutoFromHeaders || false,
    };
  });
}
function addUpstream() {
  const s = currentState;
  const upstreams = s.codexDesktop?.responsesUpstream || [];
  upstreams.push({ name:'new-upstream', baseUrl:'', apiKeys:[''], modelMapping:{'gpt-5.5':'gpt-5.5'}, reasoningMapping:{'gpt-5.5':'xhigh'}, reasoningParamStyle:'reasoning', serviceType:'responses', codexToolCompat:false, priority:(upstreams.length+1), status:'active', autoBlacklistBalance:true, normalizeMetadataUserId:true, stripBillingHeader:false, rateLimitAutoFromHeaders:false });
  if (!s.codexDesktop) s.codexDesktop = {};
  s.codexDesktop.responsesUpstream = upstreams;
  renderUpstreamTables();
}
function deleteUpstream(idx) {
  const s = currentState;
  if (!s.codexDesktop || !s.codexDesktop.responsesUpstream) return;
  s.codexDesktop.responsesUpstream.splice(idx, 1);
  renderUpstreamTables();
}

// ========== SAVE FUNCTIONS ==========
async function doSyncAll() {
  const baseUrl = getVal('sync-base-url');
  const apiKey = getVal('sync-api-key');
  if (!baseUrl) { toast('请输入 Base URL', 'error'); return; }
  const data = { syncAll: {
    baseUrl, apiKey,
    claudeCode: document.getElementById('sync-cc').checked,
    claudeDesktop: document.getElementById('sync-cd').checked,
    codexCli: document.getElementById('sync-cx').checked,
    codexDesktop: document.getElementById('sync-cxd').checked,
  }};
  try {
    showLoading('sync');
    const res = await api('/api/save', 'POST', data);
    hideLoading('sync');
    if (res.success) { toast('已同步 ' + res.backups.length + ' 个配置文件'); loadState(); }
    else { toast(res.error || '保存失败', 'error'); }
  } catch (e) { toast('保存失败: ' + e.message, 'error'); }
}
async function saveClaudeCode() {
  // Optionally append [1m] to all model fields
  const add1m = document.getElementById('cc-1m').checked;
  const mk = (v) => { if (!v) return v; if (add1m && !/\[1m\]/.test(v)) return v + '[1m]'; return v; };
  const data = {
    claudeCode: {
      baseUrl: getVal('cc-base-url'), authToken: getVal('cc-api-key'),
      opusModel: mk(getVal('cc-opus-model')), sonnetModel: mk(getVal('cc-sonnet-model')),
      haikuModel: mk(getVal('cc-haiku-model')), model: mk(getVal('cc-model')),
      reasoningModel: mk(getVal('cc-reasoning-model')), subagentModel: mk(getVal('cc-subagent-model')),
      effortLevel: getVal('cc-effort'),
      apiTimeoutMs: getVal('cc-timeout'),
      disableNonessential: document.getElementById('cc-disable-nonessential').checked,
      attributionHeader: document.getElementById('cc-attribution-off').checked ? '0' : '1',
      thinkingMode: getVal('cc-thinking-mode'),
      thinkingBudget: getVal('cc-thinking-budget'),
    }
  };
  await api('/api/save', 'POST', data);
  // 若存在「生效中」的预设，把本次保存内容同步进去，保持预设与 settings.json 一致。
  try {
    const list = await api('/api/claude-code/configs', 'GET');
    if (list.appliedId) await api('/api/claude-code/config/update', 'POST', { id: list.appliedId, config: data.claudeCode });
  } catch (e) { /* 无预设时忽略 */ }
  toast('Claude Code 配置已保存' + (add1m ? '（已追加 [1m]）' : '')); loadState();
}

function unifyCCModels() {
  const def = getVal('cc-model');
  if (!def) { toast('请先填写 Default Model', 'error'); return; }
  setVal('cc-opus-model', def);
  setVal('cc-sonnet-model', def);
  setVal('cc-haiku-model', def);
  setVal('cc-reasoning-model', def);
  setVal('cc-subagent-model', def);
  toast('已将 Opus/Sonnet/Haiku/Reasoning/Subagent 统一为 ' + def + '，记得保存');
}
function normalizeCDBaseUrl() {
  let v = (getVal('cd-base-url') || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;   // 自动补协议头
  v = v.replace(/\/+$/, '');                            // 去末尾多余斜杠
  setVal('cd-base-url', v);
  return v;
}

async function saveClaudeDesktop() {
  const baseUrl = normalizeCDBaseUrl();
  // /v1 结尾通常是 OpenAI 协议地址，Claude Desktop 用的是 Anthropic 协议
  if (/\/v\d+$/.test(baseUrl)) {
    const ok = confirm('⚠️ Base URL 以 /v' + baseUrl.match(/\/v(\d+)$/)[1] + ' 结尾，这通常是 OpenAI 协议地址。\nClaude Desktop 走的是 Anthropic 协议，多数情况应填不带 /v1 的根地址。\n\n仍要按当前地址保存吗？');
    if (!ok) return;
  }
  const data = { claudeDesktop: {
    baseUrl: baseUrl, apiKey: (getVal('cd-api-key') || '').trim(),
    authScheme: getVal('cd-auth-scheme'), provider: getVal('cd-provider') || 'gateway',
    egressHosts: getVal('cd-egress'), models: collectCDModels(),
    disableDeploymentChooser: true,
  }};
  await api('/api/save', 'POST', data);
  toast('Claude Desktop 配置已保存，记得重启 Claude Desktop 生效'); loadState();
}

// Fill Claude Desktop Base URL + API Key from Claude Code's config (a known-working relay)
function fillCDFromClaudeCode() {
  const cc = currentState.claudeCode || {};
  if (!cc.baseUrl) { toast('Claude Code 未配置中转站 Base URL', 'error'); return; }
  setVal('cd-base-url', cc.baseUrl);
  setVal('cd-api-key', cc.authToken || '');
  toast('已填入 Claude Code 的中转站：' + cc.baseUrl + '，点击保存生效');
}

// Test whether the current Claude Desktop Base URL + API Key can reach the relay
async function testCDConnection() {
  const baseUrl = normalizeCDBaseUrl();
  const apiKey = (getVal('cd-api-key') || '').trim();
  const authScheme = getVal('cd-auth-scheme') || 'bearer';
  const status = document.getElementById('cd-conn-status');
  if (!baseUrl || (!apiKey && authScheme !== 'none')) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请先填写 Base URL 和 API Key</span>';
    return;
  }
  // 取模型列表第一个作为测试模型
  const first = (collectCDModelsArray()[0] || '');
  if (!first) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请先在下方模型列表至少填一个模型</span>';
    return;
  }
  status.innerHTML = '<span class="loading"></span> 正在向 /v1/messages 发起测试请求...';
  try {
    const params = new URLSearchParams({ baseUrl, apiKey, model: first, authScheme, maxTokens: '128' });
    const res = await fetch('/api/test-message?' + params);
    const data = await res.json();
    if (data.success) {
      status.innerHTML = '<span style="color:var(--green);">&#x2705; 配置连通正常，模型 ' + esc(first) + ' 可正常调用（HTTP ' + data.status + '）</span>';
    } else {
      let html = '<span style="color:var(--red);">&#x274c; 失败' + (data.status ? '（HTTP ' + data.status + '）' : '') + '：' + esc(data.error || '未知错误') + '</span>';
      if (data.hint) html += '<br><span style="color:var(--yellow);">&#x1f4a1; ' + esc(data.hint) + '</span>';
      status.innerHTML = html;
    }
  } catch (e) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请求失败：' + esc(e.message) + '</span>';
  }
}

// 收集当前模型输入框里的模型名数组（去空格去空行）
function collectCDModelsArray() {
  try { return JSON.parse(collectCDModels()).map(m => m.name); } catch (e) { return []; }
}


async function saveCodexCli() {
  const data = { codexCli: {
    baseUrl: getVal('cx-base-url'), apiKey: getVal('cx-api-key'),
    model: getVal('cx-model'), modelProvider: getVal('cx-model-provider'),
    providerName: getVal('cx-provider-name'), wireApi: getVal('cx-wire-api'),
    reasoningEffort: getVal('cx-reasoning'),
    requiresOpenaiAuth: document.getElementById('cx-openai-auth').checked,
    // 高级字段
    reasoningSummary: getVal('cx-reasoning-summary'),
    verbosity: getVal('cx-verbosity'),
    disableResponseStorage: document.getElementById('cx-disable-storage').checked,
    httpHeaders: headersTextToObj(getVal('cx-http-headers')),
    requestMaxRetries: getVal('cx-request-retries'),
    streamMaxRetries: getVal('cx-stream-retries'),
    streamIdleTimeoutMs: getVal('cx-stream-idle'),
  }};
  await api('/api/save', 'POST', data);
  toast('Codex CLI 配置已保存'); loadState();
}

// http_headers 对象 ↔ 文本（每行 "Key: Value"）互转
function headersObjToText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.keys(obj).map(function(k){ return k + ': ' + obj[k]; }).join('\n');
}
function headersTextToObj(text) {
  const out = {};
  (text || '').split('\n').forEach(function(line){
    const t = line.trim();
    if (!t) return;
    const i = t.indexOf(':');
    if (i <= 0) return; // 没有冒号或冒号在开头的行跳过
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k) out[k] = v;
  });
  return out;
}

// Codex CLI 连通性测试：Codex 走 OpenAI 协议，用 GET /v1/models 探测（复用 /api/models），
// 而非 Anthropic 的 /v1/messages（/api/test-message）。
async function testCXConnection() {
  const baseUrl = (getVal('cx-base-url') || '').trim();
  const apiKey = (getVal('cx-api-key') || '').trim();
  const status = document.getElementById('cx-conn-status');
  if (!baseUrl || !apiKey) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请先填写 Base URL 和 API Key</span>';
    return;
  }
  status.innerHTML = '<span class="loading"></span> 正在向 /v1/models 发起测试请求...';
  try {
    const params = new URLSearchParams({ baseUrl, apiKey });
    const res = await fetch('/api/models?' + params);
    const data = await res.json();
    if (data.success && data.total > 0) {
      status.innerHTML = '<span style="color:var(--green);">&#x2705; 连接成功，可用模型 ' + data.total + ' 个</span>';
    } else if (data.error && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|reset|timeout/i.test(data.error)) {
      status.innerHTML = '<span style="color:var(--red);">&#x274c; 无法连接：' + esc(data.error) + '（检查地址是否正确、是否需要代理）</span>';
    } else if (data.error && /401|403|Invalid token|未授权|unauthor|额度/i.test(data.error)) {
      status.innerHTML = '<span style="color:var(--yellow);">&#x26a0; 地址可达但 API Key 无效或额度用尽：' + esc(data.error) + '</span>';
    } else {
      status.innerHTML = '<span style="color:var(--yellow);">&#x26a0; ' + esc(data.error || '响应异常，未获取到模型列表') + '</span>';
    }
  } catch (e) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请求失败：' + esc(e.message) + '</span>';
  }
}
async function saveCodexDesktopInjection() {
  const data = { codexDesktop: { injectedBaseUrl: getVal('cxd-injected-url'), injectedApiKey: getVal('cxd-injected-key') } };
  await api('/api/save', 'POST', data);
  toast('Codex Desktop 注入配置已保存'); loadState();
}
async function saveCodexDesktopUpstream() {
  const upstreams = collectUpstreamTable();
  const data = { codexDesktop: { responsesUpstream: upstreams, chatUpstream: currentState.codexDesktop?.chatUpstream || [] } };
  await api('/api/save', 'POST', data);
  toast('Codex Desktop 上游配置已保存'); loadState();
}

function normalizeRelayBaseUrl(value) {
  let v = (value || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;   // 自动补协议头
  v = v.replace(/\/+$/, '');                            // 去末尾多余斜杠
  return v;
}

function getSelectedRelayTargets() {
  const root = document.getElementById('test-apply-target');
  if (!root) return [];
  return Array.from(root.querySelectorAll('input[type="checkbox"]:checked')).map(el => el.value).filter(Boolean);
}

function fillRelayTestFields() {
  const baseUrl = normalizeRelayBaseUrl(getVal('test-base-url'));
  const apiKey = (getVal('test-api-key') || '').trim();
  setVal('test-base-url', baseUrl);
  setVal('test-api-key', apiKey);
  return { baseUrl, apiKey };
}

async function applyRelayToSelectedProducts() {
  const { baseUrl, apiKey } = fillRelayTestFields();
  const targets = getSelectedRelayTargets();
  if (!baseUrl) { toast('请先填写 Base URL', 'error'); return; }
  if (targets.length === 0) { toast('请先选择至少一个目标产品', 'error'); return; }
  if (!apiKey) { toast('请先填写 API Key', 'error'); return; }

  if (targets.includes('claude-code')) {
    setVal('cc-base-url', baseUrl);
    setVal('cc-api-key', apiKey);
  }
  if (targets.includes('claude-desktop')) {
    setVal('cd-base-url', baseUrl);
    setVal('cd-api-key', apiKey);
  }
  if (targets.includes('codex-cli')) {
    setVal('cx-base-url', baseUrl);
    setVal('cx-api-key', apiKey);
  }
  if (targets.includes('codex-desktop')) {
    const s = currentState.codexDesktop || {};
    const resp = Array.isArray(s.responsesUpstream) ? s.responsesUpstream.map(u => ({ ...u })) : [];
    const chat = Array.isArray(s.chatUpstream) ? s.chatUpstream.map(u => ({ ...u })) : [];
    const activeResp = resp.filter(e => e.status === 'active').sort((a, b) => (a.priority || 99) - (b.priority || 99));
    const activeChat = chat.filter(e => e.status === 'active').sort((a, b) => (a.priority || 99) - (b.priority || 99));
    if (activeResp[0]) { activeResp[0].baseUrl = baseUrl; activeResp[0].apiKeys = [apiKey]; }
    if (activeChat[0]) { activeChat[0].baseUrl = baseUrl; activeChat[0].apiKeys = [apiKey]; }
  }

  const saved = [];
  if (targets.includes('claude-code')) { await saveClaudeCode(); saved.push('Claude Code'); }
  if (targets.includes('claude-desktop')) { await saveClaudeDesktop(); saved.push('Claude Desktop'); }
  if (targets.includes('codex-cli')) { await saveCodexCli(); saved.push('Codex CLI'); }
  if (targets.includes('codex-desktop')) { await saveCodexDesktopUpstream(); saved.push('Codex Desktop'); }
  if (document.getElementById('test-apply-restart')?.checked) {
    if (targets.includes('claude-desktop')) await restartApp('claude-desktop');
    if (targets.includes('codex-desktop')) await restartApp('codex-desktop');
  }
  toast('已应用并保存到：' + saved.join('、'));
}

// ========== PROXY ==========
async function proxyRefreshStatus() {
  try {
    const res = await api('/api/proxy/status', 'GET');
    updateProxyUI(res);
  } catch (e) {}
}
function updateProxyUI(status) {
  const on = status.processRunning || status.portListening;
  const dot = on ? '<span class="indicator on"></span>' : '<span class="indicator off"></span>';
  const text = on
    ? `<span style="color:var(--green);">代理运行中</span> — 端口 ${status.port} ${status.portListening ? '&#x2705; 监听中' : '&#x26a0; 未监听'}`
    : '<span style="color:var(--red);">代理未运行</span>';
  const html = dot + '<div class="info">' + text + '</div>';
  const el1 = document.getElementById('proxy-status-overview');
  const el2 = document.getElementById('proxy-status-detail');
  if (el1) el1.innerHTML = html;
  if (el2) el2.innerHTML = html;
}
async function proxyStart() {
  try {
    const res = await api('/api/proxy/start', 'POST');
    if (res.success) { toast('Clash Verge 已启动 (PID: ' + res.pid + ')'); }
    else { toast(res.error || '启动失败', 'error'); }
    setTimeout(proxyRefreshStatus, 3000);
  } catch (e) { toast('启动失败: ' + e.message, 'error'); }
}
async function proxyStop() {
  try {
    const res = await api('/api/proxy/stop', 'POST');
    if (res.success) { toast('Clash Verge 已停止'); }
    else { toast(res.error || '停止失败', 'error'); }
    setTimeout(proxyRefreshStatus, 1000);
  } catch (e) { toast('停止失败: ' + e.message, 'error'); }
}
async function saveProxy() {
  const data = { proxy: {
    proxyHost: getVal('px-host'), proxyPort: getVal('px-port'),
    noProxy: getVal('px-no-proxy'),
    wsProxy: document.getElementById('px-ws').checked,
    wssProxy: document.getElementById('px-wss').checked,
  }};
  await api('/api/save', 'POST', data);
  toast('代理配置已保存'); loadState();
}
function showLoading() {
  const btn = document.querySelector('.btn-lg');
  if (btn) { btn.dataset.origText = btn.innerHTML; btn.innerHTML = '<span class="loading"></span> 保存中...'; btn.disabled = true; }
}
function hideLoading() {
  const btn = document.querySelector('.btn-lg');
  if (btn && btn.dataset.origText) { btn.innerHTML = btn.dataset.origText; delete btn.dataset.origText; btn.disabled = false; }
}

// ========== INIT ==========
loadState();
loadGateway();
loadAutostart();

// ========== RELAY CONNECTIVITY TEST ==========
async function testRelayConnection() {
  const baseUrl = getVal('test-base-url');
  const apiKey = getVal('test-api-key');
  const status = document.getElementById('test-status');
  if (!baseUrl || !apiKey) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请填写 Base URL 和 API Key</span>';
    return;
  }
  status.innerHTML = '<span class="loading"></span> 测试中...';
  try {
    const params = new URLSearchParams({ baseUrl, apiKey });
    const res = await fetch('/api/models?' + params);
    const data = await res.json();
    if (data.success && data.total > 0) {
      status.innerHTML = '<span style="color:var(--green);">&#x2705; 连接成功，可用模型 ' + data.total + ' 个</span>';
    } else if (data.error && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|reset|bad_response/i.test(data.error)) {
      status.innerHTML = '<span style="color:var(--red);">&#x274c; 无法连接：' + esc(data.error) + '（检查地址是否正确、是否需要代理）</span>';
    } else if (data.error && /401|Invalid token|未授权|unauthorized|额度已用完/i.test(data.error)) {
      status.innerHTML = '<span style="color:var(--yellow);">&#x26a0; 地址可达但 API Key 无效或额度已用完：' + esc(data.error) + '</span>';
    } else {
      status.innerHTML = '<span style="color:var(--yellow);">&#x26a0; ' + esc(data.error || '响应异常') + '</span>';
    }
    document.getElementById('test-models-list').innerHTML = '';
  } catch (e) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请求失败：' + esc(e.message) + '</span>';
  }
}

async function testRelayFetchModels() {
  const baseUrl = getVal('test-base-url');
  const apiKey = getVal('test-api-key');
  const status = document.getElementById('test-status');
  const list = document.getElementById('test-models-list');
  if (!baseUrl || !apiKey) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请填写 Base URL 和 API Key</span>';
    return;
  }
  status.innerHTML = '<span class="loading"></span> 获取中...';
  list.innerHTML = '';
  try {
    const params = new URLSearchParams({ baseUrl, apiKey });
    const res = await fetch('/api/models?' + params);
    const data = await res.json();
    if (data.success) {
      status.innerHTML = '<span style="color:var(--green);">&#x2705; 获取到 ' + data.total + ' 个模型</span>';
      list.innerHTML = '<h3 style="margin-bottom:8px;">可用模型 (' + data.total + ')</h3>' +
        data.models.map(m => '<div class="model-item"><span class="model-id">' + esc(String(m.id)) + '</span><span class="model-owner">' + esc(String(m.owned_by||'')) + '</span><button class="copy-btn" onclick="copyToClipboard(\'' + esc(String(m.id)) + '\')" title="复制模型 ID">&#x1f4cb;</button></div>').join('');
    } else {
      status.innerHTML = '<span style="color:var(--red);">&#x274c; ' + esc(data.error || '获取失败') + '</span>';
    }
  } catch (e) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请求失败：' + esc(e.message) + '</span>';
  }
}

// ========== RELAY GATEWAY ==========
let gwRoutes = []; // array of {anthropic, backend}
const GW_DEFAULT_CLAUDE_MODELS = ['claude-sonnet-4-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4-6'];

async function loadGateway() {
  try {
    const cfg = await api('/api/gateway', 'GET');
    setVal('gw-upstream-url', cfg.upstreamBaseUrl || '');
    setVal('gw-upstream-key', cfg.upstreamApiKey || '');
    setVal('gw-port', cfg.port || 9877);
    setVal('gw-thinking-mode', cfg.thinkingMode || 'passthrough');
    setVal('gw-thinking-budget', cfg.thinkingBudget || 10000);
    const gwLog = document.getElementById('gw-logging');
    if (gwLog) gwLog.checked = !!cfg.logging;
    onGWThinkingChange();
    gwRoutes = Object.entries(cfg.routes || {}).map(([k, v]) => ({ anthropic: k, backend: v }));
    renderGWRoutes();
    var _n = cfg.network || {};
    setVal('net-req-timeout', _n.requestTimeoutSec || '');
    setVal('net-read-timeout', _n.readTimeoutSec || '');
    setVal('net-max-retries', _n.maxRetries || '');
    setVal('net-retry-backoff', _n.retryBackoffMs || '');
    netHeaders = Object.entries(_n.customHeaders || {}).map(function(e){return {k:e[0],v:e[1]};});
    renderNetHeaders();
    const status = document.getElementById('gw-status');
    if (status) {
      const port = cfg.port || 9877;
      status.innerHTML = '网关地址: <span style="color:var(--accent);">http://127.0.0.1:' + port + '</span>（Claude Desktop 的 Base URL 应指向此地址，勿加 /v1，Claude Desktop 会自动拼 /v1/messages）';
    }
  } catch (e) {}
}

function renderGWRoutes() {
  const container = document.getElementById('gw-routes-list');
  if (!container) return;
  if (gwRoutes.length === 0) {
    container.innerHTML = '<p style="color:var(--text2);font-size:12px;">暂无映射，点击下方添加</p>';
    return;
  }
  container.innerHTML = gwRoutes.map((r, i) => `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">
    <input value="${esc(r.anthropic||'')}" data-idx="${i}" data-field="anthropic" placeholder="claude-sonnet-4-5" style="flex:1;min-width:160px;">
    <span style="color:var(--text2);font-size:12px;">→</span>
    <input list="gw-backend-datalist" value="${esc(r.backend||'')}" data-idx="${i}" data-field="backend" placeholder="glm-5.2" style="flex:1;min-width:160px;">
    <button class="btn btn-red btn-sm" onclick="removeGWRoute(${i})">&#x2715;</button>
  </div>`).join('');
}

function addGWRoute(anthropic, backend) {
  gwRoutes.push({ anthropic: anthropic || '', backend: backend || '' });
  renderGWRoutes();
}

function addGWRouteDefaults() {
  const existing = new Set(gwRoutes.map(r => r.anthropic));
  let added = 0;
  for (const m of GW_DEFAULT_CLAUDE_MODELS) {
    if (!existing.has(m)) { gwRoutes.push({ anthropic: m, backend: '' }); added++; }
  }
  renderGWRoutes();
  toast(added > 0 ? '已添加 ' + added + ' 个常用 Claude 模型' : '常用模型已全部存在');
}

function removeGWRoute(idx) { gwRoutes.splice(idx, 1); renderGWRoutes(); }

function collectGWRoutes() {
  const inputs = document.querySelectorAll('#gw-routes-list input[data-idx]');
  const map = {};
  inputs.forEach(inp => {
    const idx = inp.dataset.idx;
    if (!map[idx]) map[idx] = {};
    map[idx][inp.dataset.field] = inp.value;
  });
  return gwRoutes.map((r, i) => ({
    anthropic: (map[i] && map[i].anthropic !== undefined) ? map[i].anthropic : r.anthropic,
    backend: (map[i] && map[i].backend !== undefined) ? map[i].backend : r.backend,
  })).filter(r => r.anthropic);
}

function fillGWFromClaudeCode() {
  const cc = currentState.claudeCode || {};
  if (!cc.baseUrl) { toast('Claude Code 未配置中转站', 'error'); return; }
  setVal('gw-upstream-url', cc.baseUrl);
  setVal('gw-upstream-key', cc.authToken || '');
  // Pre-fill backend with Claude Code's main model
  if (gwRoutes.length === 0) addGWRoute('claude-sonnet-4-5', cc.model || 'glm-5.2');
  else if (!gwRoutes[0].backend) gwRoutes[0].backend = cc.model || 'glm-5.2';
  renderGWRoutes();
  toast('已用 Claude Code 中转站填充上游，模型名可按需调整');
}

async function saveGateway() {
  if (!requireGWFields()) { toast('请填写上游 URL 和 API Key', 'error'); return; }
  const routes = collectGWRoutes();
  // Validation: warn about routes whose backend (right column) is empty — these
  // forward the Anthropic name unchanged, which usually isn't what the user wants.
  const emptyBackends = routes.filter(r => !r.backend || !r.backend.trim()).map(r => r.anthropic);
  if (emptyBackends.length > 0) {
    const ok = confirm('⚠️ 以下映射的「后端模型」为空，将原样转发 Anthropic 模型名（多数中转站会拒绝）：\n\n' +
      emptyBackends.join('\n') + '\n\n仍要保存吗？');
    if (!ok) return;
  }
  const data = {
    upstreamBaseUrl: getVal('gw-upstream-url'),
    upstreamApiKey: getVal('gw-upstream-key'),
    port: getVal('gw-port'),
    thinkingMode: getVal('gw-thinking-mode'),
    thinkingBudget: getVal('gw-thinking-budget'),
    logging: document.getElementById('gw-logging') ? document.getElementById('gw-logging').checked : false,
    routes: routes,
    network: (function(){ var ch={}; collectNetHeaders().forEach(function(h){ if(h.k.trim()) ch[h.k.trim()]=h.v; }); return {
      requestTimeoutSec: getVal('net-req-timeout') || 0,
      readTimeoutSec: getVal('net-read-timeout') || 0,
      maxRetries: getVal('net-max-retries') || 0,
      retryBackoffMs: getVal('net-retry-backoff') || 500,
      customHeaders: ch,
    }; })(),
  };
  try {
    const res = await api('/api/gateway', 'POST', data);
    if (res.success) {
      toast('网关配置已保存（路由即时生效，改端口需重启服务）');
      loadGateway();
    } else { toast(res.error || '保存失败', 'error'); }
  } catch (e) { toast('保存失败: ' + e.message, 'error'); }
}

async function applyGatewayToClaudeDesktop() {
  try {
    const res = await api('/api/gateway/apply-claude-desktop', 'POST');
    if (res.success) {
      toast('已把 Claude Desktop 指向本地网关，请重启 Claude Desktop');
      const status = document.getElementById('gw-status');
      if (status) status.innerHTML += '<br><span style="color:var(--green);">&#x2705; Claude Desktop Base URL 已设为 ' + esc(res.gatewayUrl) + '，inferenceModels=' + esc(JSON.stringify(res.inferenceModels.map(m=>m.name))) + '</span>';
      loadState();
    } else { toast(res.error || '应用失败', 'error'); }
  } catch (e) { toast('应用失败: ' + e.message, 'error'); }
}


// 思考模式切换：仅「固定预算」显示预算输入框
function onThinkingModeChange() {
  const mode = getVal('cc-thinking-mode');
  const wrap = document.getElementById('cc-thinking-budget-wrap');
  if (wrap) wrap.style.display = (mode === 'fixed') ? '' : 'none';
}

// 真实对话连通自测：打 /v1/messages，而不是只列模型
async function testCCMessage() {
  const baseUrl = getVal('cc-base-url');
  const apiKey = getVal('cc-api-key');
  const model = getVal('cc-sonnet-model') || getVal('cc-model') || '';
  const status = document.getElementById('cc-test-status');
  if (!baseUrl || !apiKey) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请先填写 Base URL 和 API Key</span>';
    return;
  }
  status.innerHTML = '<span class="loading"></span> 正在发起真实对话请求...';
  try {
    const params = new URLSearchParams({ baseUrl, apiKey, model });
    const res = await fetch('/api/test-message?' + params);
    const data = await res.json();
    if (data.success) {
      status.innerHTML = '<span style="color:var(--green);">&#x2705; 对话调用成功（HTTP ' + data.status + '，模型 ' + esc(data.model || '默认') + '）—— Claude Code 可正常使用此中转站</span>';
    } else {
      let html = '<span style="color:var(--red);">&#x274c; 调用失败' + (data.status ? '（HTTP ' + data.status + '）' : '') + '：' + esc(data.error || '未知错误') + '</span>';
      if (data.hint) html += '<br><span style="color:var(--yellow);">&#x1f4a1; 排查方向：' + esc(data.hint) + '</span>';
      status.innerHTML = html;
    }
  } catch (e) {
    status.innerHTML = '<span style="color:var(--red);">&#x274c; 请求失败：' + esc(e.message) + '</span>';
  }
}

// ========== Claude Desktop 多套配置管理 ==========
let cdConfigList = [];

async function loadCDConfigs() {
  try {
    const data = await api('/api/claude-desktop/configs', 'GET');
    cdConfigList = data.configs || [];
    const sel = document.getElementById('cd-config-select');
    if (!sel) return;
    if (cdConfigList.length === 0) {
      sel.innerHTML = '<option value="">（无配置，点「新建」创建）</option>';
      return;
    }
    sel.innerHTML = cdConfigList.map(c =>
      `<option value="${esc(c.id)}" ${c.applied ? 'selected' : ''}>${esc(c.name)}${c.applied ? '（生效中）' : ''} — ${esc(c.baseUrl || '未设地址')}</option>`
    ).join('');
  } catch (e) { /* CD 未安装时静默 */ }
}

async function switchCDConfig() {
  const id = getVal('cd-config-select');
  if (!id) return;
  try {
    await api('/api/claude-desktop/config/apply', 'POST', { id });
    toast('已切换生效配置，正在加载…');
    await loadState();   // 重载表单为新生效配置
  } catch (e) { toast('切换失败：' + e.message, 'error'); }
}

async function newCDConfig() {
  const name = prompt('新配置名称：', '新中转配置');
  if (name === null) return;
  try {
    // 用当前表单内容作为新配置初始值（方便“复制一份再改”）
    const config = {
      baseUrl: getVal('cd-base-url'), apiKey: getVal('cd-api-key'),
      authScheme: getVal('cd-auth-scheme'), provider: getVal('cd-provider') || 'gateway',
      egressHosts: getVal('cd-egress') || '*', models: collectCDModels(),
    };
    const res = await api('/api/claude-desktop/config/create', 'POST', { name, config });
    await api('/api/claude-desktop/config/apply', 'POST', { id: res.id });
    toast('已创建并切换到「' + name + '」，并写入实际配置');
    await loadState();
  } catch (e) { toast('创建失败：' + e.message, 'error'); }
}

async function renameCDConfigUI() {
  const id = getVal('cd-config-select');
  if (!id) { toast('请先选择一个配置', 'error'); return; }
  const cur = cdConfigList.find(c => c.id === id);
  const name = prompt('重命名配置：', cur ? cur.name : '');
  if (name === null || !name.trim()) return;
  try {
    await api('/api/claude-desktop/config/rename', 'POST', { id, name: name.trim() });
    toast('已重命名'); await loadCDConfigs();
  } catch (e) { toast('重命名失败：' + e.message, 'error'); }
}

async function deleteCDConfigUI() {
  const id = getVal('cd-config-select');
  if (!id) { toast('请先选择一个配置', 'error'); return; }
  const cur = cdConfigList.find(c => c.id === id);
  if (!confirm('确定删除配置「' + (cur ? cur.name : id) + '」？\n（仅从预设清单移除，不改动当前 settings.json）')) return;
  try {
    await api('/api/claude-desktop/config/delete', 'POST', { id });
    toast('已删除'); await loadState();
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

function exportCDConfigUI() {
  const id = getVal('cd-config-select');
  if (!id) { toast('请先选择一个配置', 'error'); return; }
  // 询问是否包含密钥：分享/备份给他人时建议去除密钥，避免泄露。
  // confirm 的「确定」= 含密钥，「取消」= 不含密钥（先单独确认是否导出）。
  const choice = confirm('导出是否包含 API Key？\n\n点「确定」= 含密钥（完整备份，请勿外传）\n点「取消」= 不含密钥（可安全分享）');
  const stripKey = choice ? '' : '&stripKey=1';
  window.location.href = '/api/claude-desktop/config/export?id=' + encodeURIComponent(id) + stripKey;
  toast(choice ? '正在导出（含密钥）' : '正在导出（已去除密钥）');
}

async function importCDConfigUI(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';   // 允许重复选同一文件
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    // 兼容两种格式：{name, config:{...}} 或直接是 config 对象
    const config = parsed.config || parsed;
    const name = parsed.name || file.name.replace(/\.json$/i, '') || '导入配置';
    const res = await api('/api/claude-desktop/config/create', 'POST', { name, config });
    await api('/api/claude-desktop/config/apply', 'POST', { id: res.id });
    toast('已导入并切换到「' + name + '」');
    await loadState();
  } catch (e) { toast('导入失败：' + e.message + '（请确认是有效的配置 JSON）', 'error'); }
}

// ========== Claude Code CLI 多套配置管理 ==========
let ccConfigList = [];

// 把当前表单收集为一份 Claude Code 配置（与 saveClaudeCode 字段一致，不做 [1m] 变换）。
function collectCCConfig() {
  return {
    baseUrl: getVal('cc-base-url'), authToken: getVal('cc-api-key'),
    opusModel: getVal('cc-opus-model'), sonnetModel: getVal('cc-sonnet-model'),
    haikuModel: getVal('cc-haiku-model'), model: getVal('cc-model'),
    reasoningModel: getVal('cc-reasoning-model'), subagentModel: getVal('cc-subagent-model'),
    effortLevel: getVal('cc-effort'), apiTimeoutMs: getVal('cc-timeout'),
    disableNonessential: document.getElementById('cc-disable-nonessential').checked,
    attributionHeader: document.getElementById('cc-attribution-off').checked ? '0' : '1',
    thinkingMode: getVal('cc-thinking-mode'), thinkingBudget: getVal('cc-thinking-budget'),
  };
}

async function loadCCConfigs() {
  try {
    const data = await api('/api/claude-code/configs', 'GET');
    ccConfigList = data.configs || [];
    const sel = document.getElementById('cc-config-select');
    if (!sel) return;
    if (ccConfigList.length === 0) {
      sel.innerHTML = '<option value="">（无预设，点「新建」把当前表单存为一套）</option>';
      return;
    }
    sel.innerHTML = ccConfigList.map(c =>
      `<option value="${esc(c.id)}" ${c.applied ? 'selected' : ''}>${esc(c.name)}${c.applied ? '（生效中）' : ''} — ${esc(c.baseUrl || '未设地址')}</option>`
    ).join('');
  } catch (e) { /* 读取失败时静默 */ }
}

async function switchCCConfig() {
  const id = getVal('cc-config-select');
  if (!id) return;
  try {
    await api('/api/claude-code/config/apply', 'POST', { id });
    toast('已切换并写入 settings.json，新开的 Claude Code 会话即生效；下方表单会随之加载对应配置');
    await loadState();   // 重载表单为新生效配置
  } catch (e) { toast('切换失败：' + e.message, 'error'); }
}

async function newCCConfig() {
  const name = prompt('新配置名称：', '新中转配置');
  if (name === null) return;
  try {
    // 用当前表单内容作为新预设初值，方便“复制一份再改”。
    const res = await api('/api/claude-code/config/create', 'POST', { name, config: collectCCConfig() });
    await api('/api/claude-code/config/apply', 'POST', { id: res.id });
    toast('已创建并切换到「' + name + '」，并写入实际配置');
    await loadState();
  } catch (e) { toast('创建失败：' + e.message, 'error'); }
}

async function renameCCConfigUI() {
  const id = getVal('cc-config-select');
  if (!id) { toast('请先选择一个配置', 'error'); return; }
  const cur = ccConfigList.find(c => c.id === id);
  const name = prompt('重命名配置：', cur ? cur.name : '');
  if (name === null || !name.trim()) return;
  try {
    await api('/api/claude-code/config/rename', 'POST', { id, name: name.trim() });
    toast('已重命名'); await loadCCConfigs();
  } catch (e) { toast('重命名失败：' + e.message, 'error'); }
}

async function deleteCCConfigUI() {
  const id = getVal('cc-config-select');
  if (!id) { toast('请先选择一个配置', 'error'); return; }
  const cur = ccConfigList.find(c => c.id === id);
  if (!confirm('确定删除配置「' + (cur ? cur.name : id) + '」？\n（仅从预设清单移除，不改动当前 settings.json）')) return;
  try {
    await api('/api/claude-code/config/delete', 'POST', { id });
    toast('已删除'); await loadCCConfigs();
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

function exportCCConfigUI() {
  const id = getVal('cc-config-select');
  if (!id) { toast('请先选择一个配置', 'error'); return; }
  // 「确定」=含密钥（完整备份），「取消」=不含密钥（可安全分享）。
  const choice = confirm('导出是否包含 API Key？\n\n点「确定」= 含密钥（完整备份，请勿外传）\n点「取消」= 不含密钥（可安全分享）');
  const stripKey = choice ? '' : '&stripKey=1';
  window.location.href = '/api/claude-code/config/export?id=' + encodeURIComponent(id) + stripKey;
  toast(choice ? '正在导出（含密钥）' : '正在导出（已去除密钥）');
}

async function importCCConfigUI(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';   // 允许重复选同一文件
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    // 兼容 {name, config:{...}} 或直接 config 对象
    const config = parsed.config || parsed;
    const name = parsed.name || file.name.replace(/\.json$/i, '') || '导入配置';
    const res = await api('/api/claude-code/config/import', 'POST', { name, config });
    await api('/api/claude-code/config/apply', 'POST', { id: res.id });
    toast('已导入并切换到「' + name + '」');
    await loadState();
  } catch (e) { toast('导入失败：' + e.message + '（请确认是有效的配置 JSON）', 'error'); }
}

// 网关思考兜底：仅「补全」模式显示预算输入
function onGWThinkingChange() {
  const mode = getVal('gw-thinking-mode');
  const wrap = document.getElementById('gw-thinking-budget-wrap');
  if (wrap) wrap.style.display = (mode === 'inject') ? '' : 'none';
}

// ===== 新增功能（叠加，不动旧功能）=====
function requireGWFields(){var ok=true;['gw-upstream-url','gw-upstream-key'].forEach(function(id){var el=document.getElementById(id);var bad=!el||!(el.value||'').trim();if(el)el.style.borderColor=bad?'var(--red)':'';if(bad)ok=false;});return ok;}
function toggleAdvNet(){var bd=document.getElementById('adv-net-bd');var chev=document.getElementById('adv-net-chev');var open=bd.style.display==='none';bd.style.display=open?'block':'none';if(chev)chev.innerHTML=open?'&#x25bc;':'&#x25b6;';}
var netHeaders=[];
function renderNetHeaders(){var c=document.getElementById('net-headers-list');if(!c)return;if(!netHeaders.length){c.innerHTML='<p style="color:var(--text2);font-size:12px;">无自定义请求头</p>';return;}c.innerHTML=netHeaders.map(function(h,i){return '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;"><input value="'+esc(h.k||'')+'" data-i="'+i+'" data-f="k" placeholder="Header-Name" style="flex:1;"><span style="color:var(--text2);">:</span><input value="'+esc(h.v||'')+'" data-i="'+i+'" data-f="v" placeholder="value" style="flex:1;"><button class="btn btn-red btn-sm" onclick="removeNetHeader('+i+')">&#x2715;</button></div>';}).join('');}
function collectNetHeaders(){document.querySelectorAll('#net-headers-list input[data-i]').forEach(function(inp){netHeaders[inp.dataset.i][inp.dataset.f]=inp.value;});return netHeaders.filter(function(h){return h.k&&h.k.trim();});}
function addNetHeader(){collectNetHeaders();netHeaders.push({k:'',v:''});renderNetHeaders();}
function removeNetHeader(i){collectNetHeaders();netHeaders.splice(i,1);renderNetHeaders();}
async function syncGatewayModels(){var out=document.getElementById('gw-models-sync');out.innerHTML='<span class="loading"></span> 正在从网关上游同步…';try{var params=new URLSearchParams();var u=getVal('gw-upstream-url'),k=getVal('gw-upstream-key');if(u)params.set('baseUrl',u);if(k)params.set('apiKey',k);var d=await api('/api/gateway/models?'+params.toString(),'GET');if(d.success&&d.models&&d.models.length){var ids=d.models.map(function(m){return m.id;});var dl=document.getElementById('gw-backend-datalist');if(dl)dl.innerHTML=ids.map(function(id){return '<option value="'+esc(String(id))+'">';}).join('');out.innerHTML='<span style="color:var(--green);">&#x2705; 已探测到 '+ids.length+' 个模型</span> <span class="mono" style="color:var(--text2);">'+ids.slice(0,8).map(esc).join(', ')+(ids.length>8?'…':'')+'</span>';toast('已同步 '+ids.length+' 个模型，可在右栏下拉选择');}else{out.innerHTML='<span style="color:var(--red);">&#x274c; '+esc(d.error||'未获取到模型列表')+'</span>';toast(d.error||'未获取到模型列表','error');}}catch(e){out.innerHTML='<span style="color:var(--red);">&#x274c; '+esc(e.message)+'</span>';}}
async function refreshProcIndicator(){try{var s=await api('/api/process/status?product=claude-desktop','GET');var dot=document.getElementById('proc-dot');var txt=document.getElementById('proc-text');if(dot)dot.className=s.running?'on':'';if(txt)txt.textContent=s.running?('Claude Desktop 运行中 (PID '+s.pid+')'):'Claude Desktop 未运行';}catch(e){var t=document.getElementById('proc-text');if(t)t.textContent='状态未知';}}
var procRestarting=false;
async function restartProcessQuick(){if(procRestarting)return;procRestarting=true;var txt=document.getElementById('proc-text');if(txt)txt.textContent='重启中…';var ind=document.getElementById('proc-indicator');if(ind)ind.style.pointerEvents='none';try{var r=await api('/api/process/restart','POST',{product:'claude-desktop'});if(r.success)toast(r.relaunched?('Claude Desktop 已重启 (PID '+r.pid+')'):(r.warning||'已关闭，请手动重开'),r.relaunched?'success':'error');else toast(r.error||'重启失败','error');}catch(e){toast('重启失败: '+e.message,'error');}setTimeout(function(){procRestarting=false;if(ind)ind.style.pointerEvents='';refreshProcIndicator();},2200);}
var logPanelOpen=false;
function toggleLogPanel(ev){if(ev)ev.stopPropagation();logPanelOpen=!logPanelOpen;document.getElementById('logpanel').classList.toggle('open',logPanelOpen);document.getElementById('log-chev').innerHTML=logPanelOpen?'&#x25bc;':'&#x25b2;';if(logPanelOpen)pollLogs();}
async function pollLogs(){if(!logPanelOpen)return;try{var d=await api('/api/logs','GET');var logs=d.logs||[];document.getElementById('log-count').textContent='('+logs.length+'/'+(d.max||500)+')';var b=document.getElementById('log-body');b.innerHTML=logs.slice().reverse().map(function(l){var st=(l.status===''||l.status==null)?'':l.status;var cls=st>=400?'st-err':(st>=200&&st<300?'st-ok':(st===0?'st-warn':''));var t=(l.timestamp||'').replace('T',' ').replace(/\..*/,'');return '<div class="log-line">'+esc(t)+' <b>'+esc(l.method||'')+'</b> '+esc(l.url||'')+' <span class="'+cls+'">'+esc(String(st))+'</span> '+((l.duration_ms!==''&&l.duration_ms!=null)?esc(l.duration_ms)+'ms':'')+(l.model?' ['+esc(l.model)+((l.mappedTo&&l.mappedTo!==l.model)?'&#x2192;'+esc(l.mappedTo):'')+']':'')+(l.error_message?' <span class="st-err">'+esc(l.error_message)+'</span>':'')+'</div>';}).join('')||'<div style="color:var(--text2);padding:8px;">暂无日志</div>';}catch(e){}}
async function clearLogsUI(ev){if(ev)ev.stopPropagation();try{await api('/api/logs','DELETE');pollLogs();toast('日志已清空');}catch(e){toast('清空失败','error');}}
async function exportLogsUI(ev){if(ev)ev.stopPropagation();try{var d=await api('/api/logs','GET');var lines=(d.logs||[]).map(function(l){return [l.timestamp,l.method,l.url,l.status,l.duration_ms+'ms',l.model||'',l.error_message||''].join('\t');}).join('\n');var blob=new Blob([lines||'(无日志)'],{type:'text/plain'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='relay-logs-'+Date.now()+'.txt';a.click();URL.revokeObjectURL(a.href);}catch(e){toast('导出失败: '+e.message,'error');}}
var histProduct='';
async function openHistory(product){histProduct=product;document.getElementById('hist-modal').style.display='flex';document.getElementById('hist-title').textContent='配置历史版本 — '+product;document.getElementById('hist-list').innerHTML='<p style="color:var(--text2);">加载中…</p>';try{var d=await api('/api/config/history?product='+encodeURIComponent(product),'GET');var items=d.backups||[];if(!items.length){document.getElementById('hist-list').innerHTML='<p style="color:var(--text2);">暂无历史备份</p>';return;}document.getElementById('hist-list').innerHTML=items.map(function(it){return '<div class="hist-item"><div><div class="mono">'+esc(it.filename)+'</div><div class="meta">'+esc((it.mtime||'').replace('T',' ').replace(/\..*/,''))+'</div></div><button class="btn btn-outline btn-sm" onclick="doRollback(\''+esc(it.filename)+'\')">回滚</button></div>';}).join('');}catch(e){document.getElementById('hist-list').innerHTML='<span style="color:var(--red);">加载失败: '+esc(e.message)+'</span>';}}
function closeHistory(){document.getElementById('hist-modal').style.display='none';}
async function doRollback(filename){if(!confirm('确定回滚到「'+filename+'」？\n当前配置会先自动备份，随后写入该版本并重启对应客户端。'))return;try{var r=await api('/api/config/rollback','POST',{product:histProduct,filename:filename});if(r.success){toast('已回滚到 '+filename+((r.restart&&r.restart.relaunched)?'，客户端已重启':''));closeHistory();loadState();}else{toast(r.error||'回滚失败','error');}}catch(e){toast('回滚失败: '+e.message,'error');}}
refreshProcIndicator();
setInterval(function(){if(logPanelOpen)pollLogs();},2000);
setInterval(refreshProcIndicator,8000);

// ===== 主题切换（经典蓝 / 深色仪表板）=====
function setTheme(name){var valid=['classic','dashboard','modern','light'];if(valid.indexOf(name)<0)name='classic';document.body.setAttribute('data-theme',name);var sel=document.getElementById('theme-select');if(sel)sel.value=name;currentUiSettings.theme=name;saveUiSettings();}
function setSidebarLayout(name){var valid=['classic','compact','sidebar'];if(valid.indexOf(name)<0)name='classic';document.body.setAttribute('data-sidebar-layout',name);var sel=document.getElementById('sidebar-layout-select');if(sel)sel.value=name;currentUiSettings.sidebarLayout=name;saveUiSettings();}
function applySidebarLayout(name){var valid=['classic','compact','sidebar'];if(valid.indexOf(name)<0)name='classic';document.body.setAttribute('data-sidebar-layout',name);var sel=document.getElementById('sidebar-layout-select');if(sel)sel.value=name;}
async function saveUiSettings() {
  try {
    await api('/api/save', 'POST', { uiSettings: currentUiSettings });
  } catch (e) {
    toast('保存界面设置失败: ' + e.message, 'error');
  }
}
function initTheme(){loadUiSettings();}
initTheme();
