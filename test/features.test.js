// New-features integration test (features #2/#4/#5/#6/#7 backend APIs).
// Starts server.js with a temporary gateway.json + fake upstream, then verifies:
//  - GET /api/gateway/models     (model sync)
//  - GET/DELETE /api/logs        (debug log ring + redaction)
//  - GET /api/config/history     (backup listing)
//  - GET /api/process/status     (process detection shape)
//  - GET /api/test-message       (enhanced: duration_ms + modelsDetected)
//  - gateway network settings hot-reload (custom header + retry path)
// Run: node test/features.test.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GATEWAY_JSON = path.join(ROOT, 'gateway.json');
const GATEWAY_BAK = path.join(ROOT, 'gateway.json.featbak');
const UI_SETTINGS_JSON = path.join(ROOT, 'ui-settings.json');
const UI_SETTINGS_BAK = path.join(ROOT, 'ui-settings.json.featbak');
const MAIN_PORT = 19876;
const GATEWAY_PORT = 19898;

let pass = 0, fail = 0;
const check = (n, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ': ' + n); ok ? pass++ : fail++; };

let hadConfig = false;
if (fs.existsSync(GATEWAY_JSON)) { fs.copyFileSync(GATEWAY_JSON, GATEWAY_BAK); hadConfig = true; }
let hadUiSettings = false;
if (fs.existsSync(UI_SETTINGS_JSON)) { fs.copyFileSync(UI_SETTINGS_JSON, UI_SETTINGS_BAK); hadUiSettings = true; }
function cleanup() {
  try {
    if (hadConfig) { fs.copyFileSync(GATEWAY_BAK, GATEWAY_JSON); fs.unlinkSync(GATEWAY_BAK); }
    else if (fs.existsSync(GATEWAY_JSON)) fs.unlinkSync(GATEWAY_JSON);
    if (hadUiSettings) { fs.copyFileSync(UI_SETTINGS_BAK, UI_SETTINGS_JSON); fs.unlinkSync(UI_SETTINGS_BAK); }
    else if (fs.existsSync(UI_SETTINGS_JSON)) fs.unlinkSync(UI_SETTINGS_JSON);
    const log = path.join(ROOT, 'gateway-requests.log');
    if (fs.existsSync(log)) fs.unlinkSync(log);
  } catch (e) {}
}

// Fake upstream: /v1/models returns 2 models; /v1/messages echoes; records custom header.
let lastCustomHeader = null;
const upstream = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    lastCustomHeader = req.headers['x-relay-test'] || null;
    let parsedBody = {};
    try { parsedBody = JSON.parse(body || '{}'); } catch (e) {}
    if (req.url.includes('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'glm-5.2' }, { id: 'deepseek-v4' }] }));
      return;
    }
    if (req.url.includes('/v1/chat/completions') && parsedBody.model === 'fail-copilot') {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Failed to perform, curl: (35) Recv failure: Connection was reset.', type: 'upstream_error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: parsedBody }));
  });
});

upstream.listen(0, '127.0.0.1', () => {
  const upPort = upstream.address().port;
  fs.writeFileSync(GATEWAY_JSON, JSON.stringify({
    port: GATEWAY_PORT,
    upstreamBaseUrl: `http://127.0.0.1:${upPort}`,
    upstreamApiKey: 'sk-upstream',
    routes: { 'claude-opus-4-8': 'glm-5.2' },
    thinkingMode: 'passthrough',
    logging: true,
    network: { requestTimeoutSec: 30, readTimeoutSec: 0, maxRetries: 1, retryBackoffMs: 50, customHeaders: { 'X-Relay-Test': 'hello' } },
  }, null, 2));

  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(MAIN_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false;
  const fin = (code) => { try { srv.kill(); } catch (e) {} upstream.close(); cleanup(); process.exit(code); };
  srv.stdout.on('data', d => { if (!started && /RelayManager running/.test(d.toString())) { started = true; setTimeout(() => runTests(upPort, fin), 400); } });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  setTimeout(() => { if (!started) { console.error('server did not start'); fin(1); } }, 8000);
});

function get(p, cb) {
  http.get({ host: '127.0.0.1', port: MAIN_PORT, path: p, headers: { Host: 'localhost:' + MAIN_PORT } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => cb(res.statusCode, b)); }).on('error', e => cb(0, 'ERR ' + e.message));
}
function del(p, cb) {
  const req = http.request({ host: '127.0.0.1', port: MAIN_PORT, path: p, method: 'DELETE', headers: { Host: 'localhost:' + MAIN_PORT } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => cb(res.statusCode, b)); });
  req.on('error', e => cb(0, 'ERR ' + e.message)); req.end();
}
function post(p, body, cb) {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1',
    port: MAIN_PORT,
    path: p,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Host: 'localhost:' + MAIN_PORT },
  }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => cb(res.statusCode, b)); });
  req.on('error', e => cb(0, 'ERR ' + e.message)); req.write(data); req.end();
}
function gwPost(port, p, body, cb) {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Host: '127.0.0.1:' + port } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => cb(res.statusCode, b)); });
  req.on('error', e => cb(0, 'ERR ' + e.message)); req.write(data); req.end();
}

function runTests(upPort, done) {
  // 1. model sync
  get('/api/gateway/models', (code, b) => {
    let j = {}; try { j = JSON.parse(b); } catch (e) {}
    check('gateway/models returns 2 models', j.success && j.models && j.models.length === 2);

    // 2. process status shape
    get('/api/process/status?product=claude-desktop', (c2, b2) => {
      let j2 = {}; try { j2 = JSON.parse(b2); } catch (e) {}
      check('process/status returns {running, pid?}', typeof j2.running === 'boolean');

      // 3. config history shape
      get('/api/config/history?product=claude-code', (c3, b3) => {
        let j3 = {}; try { j3 = JSON.parse(b3); } catch (e) {}
        check('config/history returns backups array', Array.isArray(j3.backups));

        // 4. drive a gateway request so a log entry is created, then read logs
        gwPost(GATEWAY_PORT, '/v1/messages', { model: 'claude-opus-4-8', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }, () => {
          check('custom header forwarded to upstream', lastCustomHeader === 'hello');
          setTimeout(() => {
            get('/api/logs', (c4, b4) => {
              let j4 = {}; try { j4 = JSON.parse(b4); } catch (e) {}
              const hasEntry = j4.logs && j4.logs.length >= 1;
              check('logs captured the gateway request', hasEntry);
              check('log entry has required fields', hasEntry && 'timestamp' in j4.logs[0] && 'method' in j4.logs[0] && 'status' in j4.logs[0] && 'duration_ms' in j4.logs[0]);
              // logs must NOT contain the raw upstream key anywhere
              check('logs do not leak api key', !JSON.stringify(j4.logs).includes('sk-upstream'));

              // 5. clear logs
              del('/api/logs', (c5) => {
                get('/api/logs', (c6, b6) => {
                  let j6 = {}; try { j6 = JSON.parse(b6); } catch (e) {}
                  check('logs cleared', j6.logs && j6.logs.length === 0);

                  // 6. enhanced test-message: duration_ms + modelsDetected
                  const qs = 'baseUrl=' + encodeURIComponent('http://127.0.0.1:' + upPort) + '&apiKey=sk-x&model=glm-5.2';
                  get('/api/test-message?' + qs, (c7, b7) => {
                    let j7 = {}; try { j7 = JSON.parse(b7); } catch (e) {}
                    check('test-message has duration_ms', typeof j7.duration_ms === 'number');
                    check('test-message detected 2 models', j7.modelsDetected === 2);

                    const chatQs = 'baseUrl=' + encodeURIComponent('http://127.0.0.1:' + upPort + '/v1/chat/completions') + '&apiKey=unused&model=copilot';
                    get('/api/test-openai-chat?' + chatQs, (c8, b8) => {
                      let j8 = {}; try { j8 = JSON.parse(b8); } catch (e) {}
                      check('test-openai-chat accepts full chat/completions URL', j8.success === true && typeof j8.duration_ms === 'number');

                      const failChatQs = 'baseUrl=' + encodeURIComponent('http://127.0.0.1:' + upPort + '/v1') + '&apiKey=unused&model=fail-copilot';
                      get('/api/test-openai-chat?' + failChatQs, (c8b, b8b) => {
                        let j8b = {}; try { j8b = JSON.parse(b8b); } catch (e) {}
                        check('test-openai-chat surfaces upstream status', j8b.success === false && j8b.status === 502);
                        check('test-openai-chat surfaces upstream error type', j8b.errorType === 'upstream_error' && /curl: \(35\)/.test(j8b.error || ''));
                        check('test-openai-chat includes diagnostic body', /upstream_error/.test(j8b.errorBody || '') && /chat\/completions/.test(j8b.endpoint || ''));

                      get('/api/agent-bridge/status', (c9, b9) => {
                        let j9 = {}; try { j9 = JSON.parse(b9); } catch (e) {}
                        check('agent-bridge/status returns handoff files', Array.isArray(j9.handoffFiles));
                        check('agent-bridge/status returns command list', j9.commands && typeof j9.commands.dryRun === 'string');
                        check('agent-bridge/status returns copilot api launcher', j9.copilotApi && j9.copilotApi.defaults && j9.copilotApi.powerShellCommand);

                        post('/api/agent-bridge/copilot-api/command', {
                          projectDir: ROOT,
                          pythonPath: process.execPath,
                          port: 18000,
                          proxyUrl: 'http://127.0.0.1:7897',
                          noProxy: 'localhost,127.0.0.1,::1',
                          proxyEnabled: true,
                        }, (c9b, b9b) => {
                          let j9b = {}; try { j9b = JSON.parse(b9b); } catch (e) {}
                          check('copilot-api command includes HTTP_PROXY', j9b.powerShellCommand && j9b.powerShellCommand.includes('HTTP_PROXY') && j9b.powerShellCommand.includes('127.0.0.1:7897'));
                          check('copilot-api command includes configured port', j9b.defaults && j9b.defaults.port === '18000' && j9b.powerShellCommand.includes('$env:PORT'));

                          get('/api/agent-bridge/path-picker?dir=' + encodeURIComponent(ROOT), (c9c, b9c) => {
                            let j9c = {}; try { j9c = JSON.parse(b9c); } catch (e) {}
                            check('path-picker lists selected directory', j9c.current === ROOT && Array.isArray(j9c.entries));
                            check('path-picker returns roots and defaults', Array.isArray(j9c.roots) && j9c.defaultPython && j9c.proxyDefaults && j9c.proxyDefaults.proxyUrl);

                          post('/api/agent-bridge/copilot-api/stop-port-owner', {
                            projectDir: ROOT,
                            pythonPath: process.execPath,
                            port: 18000,
                            proxyUrl: 'http://127.0.0.1:7897',
                            proxyEnabled: true,
                          }, (c9d, b9d) => {
                            let j9d = {}; try { j9d = JSON.parse(b9d); } catch (e) {}
                            check('copilot-api stop-port-owner requires confirmation', c9d === 400 && /confirmation/i.test(j9d.error || ''));

                          get('/api/codex-cli/config/list', (c9e, b9e) => {
                            let j9e = {}; try { j9e = JSON.parse(b9e); } catch (e) {}
                            check('codex-cli config list returns effective summary', j9e.effective && typeof j9e.effective.modelProvider === 'string' && typeof j9e.appliedMatchesEffective === 'boolean');
                            check('codex-cli config list includes provider metadata', Array.isArray(j9e.configs) && j9e.configs.every(c => 'modelProvider' in c && 'wireApi' in c));

                        post('/api/save', { uiSettings: { theme: 'modern', sidebarLayout: 'sidebar' } }, (c10, b10) => {
                          let j10 = {}; try { j10 = JSON.parse(b10); } catch (e) {}
                          check('ui settings save reports backup', Array.isArray(j10.backups) && j10.backups.includes('ui-settings.json'));

                          get('/api/state', (c11, b11) => {
                            let j11 = {}; try { j11 = JSON.parse(b11); } catch (e) {}
                            check('ui settings round-trip theme', j11.uiSettings && j11.uiSettings.theme === 'modern');
                            check('ui settings round-trip layout', j11.uiSettings && j11.uiSettings.sidebarLayout === 'sidebar');
                            console.log(`\n=== ${pass} passed, ${fail} failed ===`);
                            done(fail > 0 ? 1 : 0);
                            });
                          });
                        });
                      });
                      });
                      });
                      });
                      });
                    });
                  });
                });
              });
              });
          }, 150);
        });
      });
    });
  });
}
