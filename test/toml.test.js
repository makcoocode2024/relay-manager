// Codex CLI TOML roundtrip test — verifies the parse->modify->stringify approach
// used by writeCodexCli() preserves nested tables, booleans, and existing keys.
// Run: node test/toml.test.js

const toml = require('@iarna/toml');

let pass = 0, fail = 0;
function check(name, ok) { console.log((ok ? 'PASS' : 'FAIL') + ': ' + name); ok ? pass++ : fail++; }

const raw = [
  '# my codex config (comment)',
  'model = "gpt-5.5"',
  'model_provider = "custom"',
  'model_reasoning_effort = "high"',
  '',
  '[model_providers.custom]',
  'name = "Old Provider"',
  'base_url = "http://old.com/v1"',
  'wire_api = "responses"',
].join('\n');

// Replicate writeCodexCli's transform
const obj = toml.parse(raw);
if (!obj.model_providers) obj.model_providers = {};
if (!obj.model_providers.custom) obj.model_providers.custom = {};
const custom = obj.model_providers.custom;
custom.base_url = 'http://new.com/v1';
custom.experimental_bearer_token = 'sk-test-key';
custom.requires_openai_auth = true;
custom.name = 'New Provider';
obj.model = 'gpt-6';

const out = toml.stringify(obj);
const r = toml.parse(out);

check('base_url updated', r.model_providers.custom.base_url === 'http://new.com/v1');
check('bearer token added', r.model_providers.custom.experimental_bearer_token === 'sk-test-key');
check('boolean requires_openai_auth', r.model_providers.custom.requires_openai_auth === true);
check('provider name updated', r.model_providers.custom.name === 'New Provider');
check('top-level model updated', r.model === 'gpt-6');
check('untouched model_provider preserved', r.model_provider === 'custom');
check('untouched reasoning_effort preserved', r.model_reasoning_effort === 'high');
check('untouched wire_api preserved', r.model_providers.custom.wire_api === 'responses');

// Malformed TOML should throw (writeCodexCli refuses to write in that case)
let threw = false;
try { toml.parse('this is = = not valid toml ['); } catch (e) { threw = true; }
check('malformed TOML throws (write would be refused)', threw);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
