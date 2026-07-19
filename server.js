// Rating form server: serves the form from the task link and writes submissions to Factorial.
// Run: node server.js   (default port 3141, override with PORT)
const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('./factorial');
const { verify } = require('./token');
const cfg = require('./config.json');

const PORT = process.env.PORT || 3141;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const FORM_TEMPLATE = fs.readFileSync(path.join(__dirname, 'form.html'), 'utf8');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { tasks: {}, submitted: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function page(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const msgPage = (title, text) => `<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;justify-content:center;padding-top:80px"><div style="text-align:center"><h2>${title}</h2><p style="color:#666">${text}</p></div></body></html>`;

async function handleForm(res, tokenStr) {
  const t = verify(tokenStr);
  if (!t) return page(res, 400, msgPage('Link invalid or expired', 'Ask HR to send you a new rating link.'));

  const state = loadState();
  if (state.submitted[`${t.e}-${t.d}`]) {
    return page(res, 200, msgPage('Already submitted', `Day ${t.d} was already rated. Thanks!`));
  }
  const emp = await api.get(`employees/employees/${t.e}`);
  const dateStr = new Date(t.date + 'T00:00:00Z')
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  const html = FORM_TEMPLATE
    .replaceAll('{{TOKEN}}', tokenStr)
    .replaceAll('{{DAY}}', String(t.d))
    .replaceAll('{{TOTAL}}', String(cfg.days_to_rate))
    .replaceAll('{{DATE}}', dateStr.toUpperCase())
    .replaceAll('{{NAME}}', emp.full_name)
    .replaceAll('{{FIRST_NAME}}', emp.first_name)
    .replaceAll('{{PROGRESS}}', Array.from({ length: cfg.days_to_rate }, (_, i) =>
      `<i class="${i + 1 < t.d ? 'done' : i + 1 === t.d ? 'today' : ''}"></i>`).join(''));
  page(res, 200, html);
}

async function handleSubmit(res, body) {
  const { token, rating, comment } = body;
  const t = verify(token);
  if (!t) return json(res, 400, { error: 'invalid_token' });
  const r = Number(rating);
  if (!(r >= 1 && r <= 5)) return json(res, 400, { error: 'invalid_rating' });

  const state = loadState();
  const key = `${t.e}-${t.d}`;
  if (state.submitted[key]) return json(res, 409, { error: 'already_submitted' });

  const manager = await api.get(`employees/employees/${t.m}`);
  const emp = await api.get(`employees/employees/${t.e}`);

  // 1. One row per employee: find their existing record, otherwise create it
  state.rows = state.rows || {};
  let rowId = state.rows[t.e];
  if (!rowId) {
    // recover from Factorial in case state was lost
    // NOTE: server-side schema_id filters are ignored on these endpoints; filter client-side
    const existing = (await api.getAll('custom_resources/resources'))
      .find(res => String(res.attachable_id) === String(t.e) && String(res.schema_id) === String(cfg.schema_id));
    if (existing) rowId = existing.id;
  }
  const writes = [];
  if (!rowId) {
    const first = await api.post('custom_resources/values', {
      schema_id: cfg.schema_id, employee_id: t.e,
      field_id: cfg.row_fields.first_shift_date, value: t.f || t.date,
    });
    rowId = first.resource_id;
    writes.push([cfg.row_fields.rated_by, manager.full_name]);
  }
  state.rows[t.e] = rowId;

  // 2. Day-specific values go into that same row
  const day = cfg.day_fields[String(t.d)];
  writes.push([day.rating, String(r)]);
  if (comment && String(comment).trim()) writes.push([day.comment, String(comment).trim().slice(0, 2000)]);
  for (const [field_id, value] of writes) {
    await api.post('custom_resources/values', {
      schema_id: cfg.schema_id, employee_id: t.e, custom_resource_id: rowId, field_id, value,
    });
  }

  // 2. Mark the task done
  const taskRef = state.tasks[key];
  if (taskRef) {
    try {
      await api.put(`tasks/tasks/${taskRef.taskId}`, {
        name: `New Hire: Rate day ${t.d} of ${cfg.days_to_rate} - ${emp.full_name}`, status: 'done', due_on: t.date,
      });
    } catch (e) { console.warn('Could not mark task done:', e.message); }
  }

  state.submitted[key] = { rowId, rating: r, at: new Date().toISOString() };
  saveState(state);
  json(res, 200, { ok: true, rowId });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url.startsWith('/rate/')) {
      return await handleForm(res, decodeURIComponent(req.url.slice(6)));
    }
    if (req.method === 'POST' && req.url === '/api/submit') {
      let data = '';
      req.on('data', c => data += c);
      req.on('end', async () => {
        try { await handleSubmit(res, JSON.parse(data)); }
        catch (e) { console.error(e); json(res, 500, { error: 'server_error' }); }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
    page(res, 404, msgPage('Not found', ''));
  } catch (e) {
    console.error(e);
    page(res, 500, msgPage('Something went wrong', 'Please try again or contact HR.'));
  }
});

server.listen(PORT, () => console.log(`Rating form server on http://localhost:${PORT}`));

// In-process poller schedule (no separate cron service needed on Render)
const pollerHours = Number(process.env.RUN_POLLER_EVERY_HOURS || 6);
if (pollerHours > 0) {
  const poller = require('./poller');
  const tick = () => poller.run().catch(e => console.error('[poller]', e.message));
  setTimeout(tick, 10_000); // once shortly after boot
  setInterval(tick, pollerHours * 3600 * 1000);
  console.log(`Poller scheduled every ${pollerHours}h`);
}
