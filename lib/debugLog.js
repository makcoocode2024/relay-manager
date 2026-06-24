// In-memory debug log ring buffer (feature #4).
// Keeps the most recent N entries. Secrets (Authorization / api_key / token) are
// redacted to first+last 4 chars before storage, so the buffer can be exposed via
// GET /api/logs without leaking credentials.

const MAX_LOGS = 500;
let logs = [];

// Redact a secret string to "abcd…wxyz" (first4…last4). Short strings -> "****".
function redactSecret(v) {
  if (v == null) return v;
  const s = String(v);
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

// Redact a value that may be a "Bearer xxxx" header or a raw key.
function redactAuthValue(v) {
  if (v == null) return v;
  const s = String(v);
  const m = s.match(/^(Bearer|Basic)\s+(.+)$/i);
  if (m) return m[1] + ' ' + redactSecret(m[2]);
  return redactSecret(s);
}

// Add one log entry. `entry` fields: method, url, status, duration_ms,
// error_message, and optionally headers (object, will be redacted) / model info.
function addLog(entry) {
  const e = {
    timestamp: new Date().toISOString(),
    method: entry.method || '',
    url: entry.url || '',
    status: entry.status != null ? entry.status : '',
    duration_ms: entry.duration_ms != null ? entry.duration_ms : '',
    error_message: entry.error_message || '',
  };
  // Optional extras (model rewrite info), already non-sensitive.
  if (entry.model) e.model = entry.model;
  if (entry.mappedTo) e.mappedTo = entry.mappedTo;
  // If raw headers were passed, store a redacted copy for debugging.
  if (entry.headers && typeof entry.headers === 'object') {
    const h = {};
    for (const k of Object.keys(entry.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'authorization') h[k] = redactAuthValue(entry.headers[k]);
      else if (lk === 'x-api-key' || lk === 'api-key' || /key|token|secret/.test(lk)) h[k] = redactSecret(entry.headers[k]);
      else h[k] = entry.headers[k];
    }
    e.headers = h;
  }
  logs.push(e);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  return e;
}

function getLogs() { return logs.slice(); }
function clearLogs() { logs = []; }

module.exports = { addLog, getLogs, clearLogs, redactSecret, redactAuthValue, MAX_LOGS };
