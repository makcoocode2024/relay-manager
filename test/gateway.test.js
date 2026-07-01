// Gateway integration test — no external deps, pure Node.
// Spins up a fake upstream, writes a temporary gateway.json, starts server.js,
// then exercises the gateway: model rewrite, thinking injection, auth headers,
// error normalization, and SSE clean termination.
//
// Run: node test/gateway.test.js   (exits non-zero on any failure)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GATEWAY_JSON = path.join(ROOT, 'gateway.json');
const GATEWAY_BAK = path.join(ROOT, 'gateway.json.testbak');
const GATEWAY_PORT = 19999;
const MAIN_PORT = 19877;

let pass = 0, fail = 0;
function check(name, ok) { console.log((ok ? 'PASS' : 'FAIL') + ': ' + name); ok ? pass++ : fail++; }

// Preserve any existing gateway.json so the test never clobbers real config/secrets.
let hadConfig = false;
if (fs.existsSync(GATEWAY_JSON)) { fs.copyFileSync(GATEWAY_JSON, GATEWAY_BAK); hadConfig = true; }

function cleanup() {
  try {
    if (hadConfig) { fs.copyFileSync(GATEWAY_BAK, GATEWAY_JSON); fs.unlinkSync(GATEWAY_BAK); }
    else if (fs.existsSync(GATEWAY_JSON)) fs.unlinkSync(GATEWAY_JSON);
    const log = path.join(ROOT, 'gateway-requests.log');
    if (fs.existsSync(log)) fs.unlinkSync(log);
  } catch (e) { /* best effort */ }
}

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.endsWith('/error-test')) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'rate limited by upstream', code: 'too_many' }));
      return;
    }
    if (/"stream":\s*true/.test(body)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.write('event: content_block_delta\ndata: {"text":"hi"}\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      received: JSON.parse(body || '{}'),
      authHeader: req.headers['authorization'],
      xapikey: req.headers['x-api-key'],
    }));
  });
});

upstream.listen(0, '127.0.0.1', () => {
  const upPort = upstream.address().port;
  fs.writeFileSync(GATEWAY_JSON, JSON.stringify({
    port: GATEWAY_PORT,
    upstreamBaseUrl: `http://127.0.0.1:${upPort}`,
    upstreamApiKey: 'sk-upstream',
    routes: { 'claude-opus-4-8': 'backend-x' },
    thinkingMode: 'inject',
    thinkingBudget: 8000,
    logging: false,
  }, null, 2));

  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(MAIN_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false;
  const fin = (code) => { try { srv.kill(); } catch (e) {} upstream.close(); cleanup(); process.exit(code); };
  srv.stdout.on('data', d => {
    if (!started && /Relay gateway on/.test(d.toString())) { started = true; runTests(fin); }
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  setTimeout(() => { if (!started) { console.error('server did not start in time'); fin(1); } }, 8000);
});

function post(reqPath, body, cb) {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port: GATEWAY_PORT, path: reqPath, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Host': '127.0.0.1:' + GATEWAY_PORT },
  }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => cb(res.statusCode, b, res.headers)); });
  req.on('error', e => cb(0, 'ERR ' + e.message, {}));
  req.write(data); req.end();
}

function runTests(done) {
  post('/v1/messages', { model: 'claude-opus-4-8', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, (code, b) => {
    let j = {}; try { j = JSON.parse(b); } catch (e) {}
    const r = j.received || {};
    check('model rewritten claude-opus-4-8 -> backend-x', r.model === 'backend-x');
    check('thinking injected with configured budget', r.thinking && r.thinking.type === 'enabled' && r.thinking.budget_tokens === 8000);
    check('max_tokens raised above budget', r.max_tokens === 8000 + 1024);
    check('temperature/top_p/top_k stripped', r.temperature === undefined && r.top_p === undefined && r.top_k === undefined);
    check('auth header set to upstream key', /sk-upstream/.test(j.authHeader || ''));
    check('x-api-key set to upstream key', j.xapikey === 'sk-upstream');

    post('/v1/error-test', { model: 'claude-opus-4-8', messages: [] }, (code2, b2) => {
      let e = {}; try { e = JSON.parse(b2); } catch (x) {}
      check('error status passed through (429)', code2 === 429);
      check('error normalized to anthropic shape', e.type === 'error' && e.error && e.error.type === 'rate_limit');

      const data = JSON.stringify({ model: 'claude-opus-4-8', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      const req = http.request({
        host: '127.0.0.1', port: GATEWAY_PORT, path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Host': '127.0.0.1:' + GATEWAY_PORT },
      }, res => {
        let chunks = ''; res.on('data', c => chunks += c); res.on('end', () => {
          check('SSE content-type', /event-stream/.test(res.headers['content-type'] || ''));
          check('SSE forwarded message events', chunks.includes('message_start') && chunks.includes('content_block_delta'));
          check('SSE clean termination', chunks.includes('[DONE]') || chunks.includes('event: done'));
          console.log(`\n=== ${pass} passed, ${fail} failed ===`);
          done(fail > 0 ? 1 : 0);
        });
      });
      req.write(data); req.end();
    });
  });
}
