// Signed single-purpose tokens for rating links (HMAC-SHA256)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Ensure .env is loaded even when this module is used standalone
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const SECRET = process.env.TOKEN_SECRET || 'change-me-in-production';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verify(token) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expect = b64url(crypto.createHmac('sha256', SECRET).update(body).digest());
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  const payload = JSON.parse(unb64url(body));
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

module.exports = { sign, verify };
