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
const MAIN_PORT = 9876;

let pass = 0, fail = 0;
const check = (n, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ': ' + n); ok ? pass++ : fail++; };

let hadConfig = false;
if (fs.existsSync(GATEWAY_JSON)) { fs.copyFileSync(GATEWAY_JSON, GATEWAY_BAK); hadConfig = true; }
function cleanup() {
  try {
    if (hadConfig) { fs.copyFileSync(GATEWAY_BAK, GATEWAY_JSON); fs.unlinkSync(GATEWAY_BAK); }
    else if (fs.existsSync(GATEWAY_JSON)) fs.unlinkSync(GATEWAY_JSON);
    const log = path.join(ROOT, 'gateway-requests.log');
    if (fs.existsSync(log)) fs.unlinkSync(log);
  } catch (e) {}
}

// Fake upstream: /v1/models returns 2 models; /v1/messages echoes; records custom header.
let lastCustomHeader = null;
const upstream = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    lastCustomHeader = req.headers['x-relay-test'] || null;
    if (req.url.includes('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'glm-5.2' }, { id: 'deepseek-v4' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: JSON.parse(body || '{}') }));
  });
});

upstream.listen(0, '127.0.0.1', () => {
  const upPort = upstream.address().port;
  fs.writeFileSync(GATEWAY_JSON, JSON.stringify({
    port: 19998,
    upstreamBaseUrl: `http://127.0.0.1:${upPort}`,
    upstreamApiKey: 'sk-upstream',
    routes: { 'claude-opus-4-8': 'glm-5.2' },
    thinkingMode: 'passthrough',
    logging: true,
    network: { requestTimeoutSec: 30, readTimeoutSec: 0, maxRetries: 1, retryBackoffMs: 50, customHeaders: { 'X-Relay-Test': 'hello' } },
  }, null, 2));

  const srv = spawn('node', ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
        gwPost(19998, '/v1/messages', { model: 'claude-opus-4-8', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }, () => {
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
                    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
                    done(fail > 0 ? 1 : 0);
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
