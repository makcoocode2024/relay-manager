// 静态回归测试：已废弃的 Copilot -> Codex CLI 路由不应再构造 chat wire_api 配置。

const fs = require('fs');

const source = fs.readFileSync('server.js', 'utf8');

let pass = 0;
let fail = 0;

function check(name, ok) {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name);
  ok ? pass++ : fail++;
}

function routeBody(pathname) {
  const marker = `url.pathname === '${pathname}'`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const firstBrace = source.indexOf('{', start);
  let depth = 0;
  for (let i = firstBrace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(firstBrace + 1, i);
  }
  return '';
}

const body = routeBody('/api/agent-bridge/copilot-codex-cli');

check('Copilot Codex CLI route exists', body.length > 0);
check('deprecated route returns unsupported error', /sendError\(res,\s*unsupported,\s*400\)/.test(body));
check('deprecated route does not build legacy chat config', !/copilotCodexConfig\(/.test(body));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
