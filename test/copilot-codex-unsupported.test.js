// 回归测试：Windows Copilot API 不能直接写入 Codex CLI。
// 该限制应作为普通 400 响应返回，不应在控制台打印全局 Error 日志。

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 19879;

let pass = 0;
let fail = 0;

function check(name, ok) {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name);
  ok ? pass++ : fail++;
}

function post(pathname, body, cb) {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1',
    port: PORT,
    path: pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      Host: 'localhost:' + PORT,
    },
  }, res => {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => cb(null, res.statusCode, raw));
  });
  req.on('error', err => cb(err));
  req.write(data);
  req.end();
}

const srv = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
let started = false;

function finish(code) {
  try { srv.kill(); } catch (e) {}
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(code);
}

srv.stdout.on('data', data => {
  stdout += data.toString();
  if (!started && /RelayManager running/.test(stdout)) {
    started = true;
    setTimeout(run, 300);
  }
});

srv.stderr.on('data', data => {
  stderr += data.toString();
});

srv.on('exit', code => {
  if (!started) {
    console.error('server exited before test started: ' + code);
    console.error(stderr);
    finish(1);
  }
});

setTimeout(() => {
  if (!started) {
    console.error('server did not start');
    console.error(stderr);
    finish(1);
  }
}, 8000);

function run() {
  post('/api/agent-bridge/copilot-codex-cli', {
    action: 'create',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKey: 'unused',
    model: 'copilot',
  }, (err, statusCode, raw) => {
    if (err) {
      console.error(err.message);
      finish(1);
      return;
    }

    let body = {};
    try { body = JSON.parse(raw); } catch (e) {}

    check('unsupported Copilot Codex route returns 400', statusCode === 400);
    check('unsupported response explains wire_api limit', /wire_api/.test(body.error || ''));
    check('unsupported route does not emit global Error log', !/Error:\s*Codex CLI .*wire_api\s*=\s*"chat"/.test(stderr));

    finish(fail ? 1 : 0);
  });
}
