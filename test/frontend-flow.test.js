// Frontend flow regression tests.
// Verifies overview apply buttons create/apply new configs instead of using legacy syncAll overwrite.

const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
let pass = 0;
let fail = 0;

function check(name, ok) {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name);
  ok ? pass++ : fail++;
}

function functionBody(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  if (start < 0) return '';
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') depth--;
    if (depth === 0) return html.slice(brace + 1, i);
  }
  return '';
}

const applySyncBody = functionBody('applySyncToSelectedProducts');
const applyRelayBody = functionBody('applyRelayToSelectedProducts');
const sharedBody = functionBody('applyBaseUrlKeyToTargets');
const createApplyBody = functionBody('createAndApplyProductConfig');
const createApplyConfigBody = functionBody('createAndApplyConfig');

check('overview sync button uses applySyncToSelectedProducts', /onclick="applySyncToSelectedProducts\(\)"/.test(html));
check('standalone relay apply button removed', !/onclick="applyRelayToSelectedProducts\(\)"/.test(html));
check('legacy doSyncAll function removed', !/function\s+doSyncAll\s*\(/.test(html));
check('frontend does not post syncAll payload', !/syncAll\s*:/.test(html));
check('config apply helper creates configs', /configApi\(product,\s*'create'/.test(createApplyConfigBody));
check('config apply helper applies configs', /configApi\(product,\s*'apply'/.test(createApplyConfigBody));
check('product apply helper delegates to config helper', /createAndApplyConfig\(product,/.test(createApplyBody));
check('shared apply flow delegates to product helper', /createAndApplyProductConfig\(target,\s*baseName,\s*baseUrl,\s*apiKey\)/.test(sharedBody));
check('overview apply delegates to shared flow', /applyBaseUrlKeyToTargets\(baseUrl,\s*apiKey,\s*targets\)/.test(applySyncBody));
check('standalone relay apply function removed', applyRelayBody === '');
check('overview no longer has a standalone relay connectivity card', !/Relay Connectivity Test Card|id="test-base-url"|id="test-api-key"|id="test-apply-target"|id="test-apply-restart"/.test(html));
check('overview sync performs relay connectivity check before applying products', /checkRelayConnectivity\(/.test(applySyncBody));
check('overview sync keeps optional desktop restart control', /id="sync-apply-restart"/.test(html) && /restartApp\('claude-desktop'\)/.test(applySyncBody) && /restartApp\('codex-desktop'\)/.test(applySyncBody));
check('overview sync card has explicit test connection button', /onclick="testSyncRelayConnection\(\)"/.test(html));
check('overview sync card has real message self-test button', /onclick="testSyncRealMessage\(\)"/.test(html));
check('overview real message self-test uses test-message endpoint', /function\s+testSyncRealMessage\s*\(/.test(html) && /\/api\/test-message\?/.test(functionBody('testSyncRealMessage')));
check('standalone relay connectivity functions removed', !/function\s+testRelayConnection\s*\(|function\s+testRelayFetchModels\s*\(/.test(html));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
