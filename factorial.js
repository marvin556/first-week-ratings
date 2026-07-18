// Minimal Factorial API client (zero dependencies, Node 18+)
const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const BASE = process.env.FACTORIAL_BASE;
const KEY = process.env.FACTORIAL_API_KEY;
if (!BASE || !KEY) { console.error('Missing FACTORIAL_BASE / FACTORIAL_API_KEY in .env'); process.exit(1); }

async function api(method, resource, body, query) {
  let url = `${BASE}/resources/${resource}`;
  if (query) url += '?' + new URLSearchParams(query).toString();
  const res = await fetch(url, {
    method,
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${resource} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Follows cursor pagination (after_id) until all pages are fetched
async function getAll(resource, query = {}) {
  const out = [];
  let afterId;
  for (;;) {
    const q = { ...query, limit: '100' };
    if (afterId) q.after_id = afterId;
    const page = await api('GET', resource, null, q);
    out.push(...page.data);
    if (!page.meta || !page.meta.has_next_page) break;
    afterId = page.meta.end_cursor;
  }
  return out;
}

module.exports = {
  get: (r, q) => api('GET', r, null, q),
  getAll,
  post: (r, b) => api('POST', r, b),
  put: (r, b) => api('PUT', r, b),
};
