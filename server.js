// Rating form server: multi-day page per flow; submissions and "no information
// received" both write a row to the Factorial custom table and mark the day's
// task as done. Task status in Factorial is the source of truth for what's open.
// Run: node server.js   (default port 3141, override with PORT)
const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('./factorial');
const { verify } = require('./token');
const cfg = require('./config.json');
const { FLOWS } = require('./flows');

const PORT = process.env.PORT || 3141;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const FORM_TEMPLATE = fs.readFileSync(path.join(__dirname, 'form.html'), 'utf8');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function workingDays(start, count) {
  const days = [];
  const d = new Date(start + 'T00:00:00Z');
  while (days.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function page(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const msgPage = (title, text) => `<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;justify-content:center;padding-top:80px"><div style="text-align:center"><h2>${title}</h2><p style="color:#666">${text}</p></div></body></html>`;

const fmtLong = (iso) => new Date(iso + 'T00:00:00Z')
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtShort = (iso) => new Date(iso + 'T00:00:00Z')
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// Task status per day, resolved live from Factorial by deterministic task name.
async function dayStatuses(t, emp, flow, state) {
  const days = workingDays(t.f, cfg.days_to_rate);
  const allTasks = await api.getAll('tasks/tasks');
  const byName = new Map(allTasks.filter(x => x.status !== 'discarded').map(x => [x.name, x]));
  return days.map((date, i) => {
    const d = i + 1;
    const key = `${t.e}-${d}-${t.k}`;
    const sub = state.submitted && state.submitted[key];
    const task = byName.get(flow.taskName(d, emp));
    let status = 'open';
    if (sub) status = sub.noInfo ? 'noinfo' : 'done';
    else if (task && task.status === 'done') status = 'done';
    return { d, date, dateShort: fmtShort(date), dateLong: fmtLong(date), status, taskId: task ? task.id : null };
  });
}

async function handleForm(res, tokenStr) {
  const t = verify(tokenStr);
  if (!t || !t.k || !t.f) return page(res, 400, msgPage('Link invalid or expired', 'Ask HR to send you a new rating link.'));
  const state = loadState();
  const emp = await api.get(`employees/employees/${t.e}`);
  const flow = FLOWS[t.k];
  const days = await dayStatuses(t, emp, flow, state);
  const data = {
    token: tokenStr,
    chip: `${emp.full_name.toUpperCase()} · FIRST WEEK`,
    texts: flow.texts(emp),
    days: days.map(({ taskId, ...rest }) => rest),
  };
  page(res, 200, FORM_TEMPLATE.replace('{{DATA}}', JSON.stringify(data)));
}

async function writeRow(t, dayNum, date, fields, cells) {
  const row = await api.post('custom_resources/values', {
    schema_id: fields.schema_id, employee_id: t.e, field_id: fields.fields.day, value: `Day ${dayNum}`,
  });
  for (const [field_id, value] of [[fields.fields.date, date], ...cells]) {
    await api.post('custom_fields/values', {
      field_id, valuable_type: 'CustomResources::Value', valuable_id: String(row.id), value,
    });
  }
  return row.id;
}

async function handleWrite(res, body, noInfo) {
  const { token, day, rating, comment } = body;
  const t = verify(token);
  if (!t || !t.k || !t.f) return json(res, 400, { error: 'invalid_token' });
  const d = Number(day);
  if (!(d >= 1 && d <= cfg.days_to_rate)) return json(res, 400, { error: 'invalid_day' });
  const r = Number(rating);
  if (!noInfo && !(r >= 1 && r <= 5)) return json(res, 400, { error: 'invalid_rating' });

  const state = loadState();
  const key = `${t.e}-${d}-${t.k}`;
  if (state.submitted && state.submitted[key]) return json(res, 409, { error: 'already_submitted' });

  const emp = await api.get(`employees/employees/${t.e}`);
  const manager = await api.get(`employees/employees/${t.m}`);
  const flow = FLOWS[t.k];
  const flowCfg = cfg[flow.cfgKey];
  const days = await dayStatuses(t, emp, flow, state);
  const dayInfo = days.find(x => x.d === d);
  if (!dayInfo || dayInfo.status !== 'open') return json(res, 409, { error: 'already_submitted' });

  const cells = [[flowCfg.fields.rated_by, manager.full_name],
                 [flowCfg.fields.status, noInfo ? 'No information received' : 'Submitted']];
  if (!noInfo) {
    cells.push([flowCfg.fields.rating, String(r)]);
    if (comment && String(comment).trim()) cells.push([flowCfg.fields.comment, String(comment).trim().slice(0, 2000)]);
  }
  const rowId = await writeRow(t, d, dayInfo.date, flowCfg, cells);

  if (dayInfo.taskId) {
    try {
      await api.put(`tasks/tasks/${dayInfo.taskId}`, {
        name: flow.taskName(d, emp), status: 'done', due_on: dayInfo.date,
      });
    } catch (e) { console.warn('Could not mark task done:', e.message); }
  }

  state.submitted = state.submitted || {};
  state.submitted[key] = { rowId, rating: noInfo ? null : r, noInfo: !!noInfo, at: new Date().toISOString() };
  saveState(state);
  json(res, 200, { ok: true, rowId });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url.startsWith('/rate/')) {
      return await handleForm(res, decodeURIComponent(req.url.slice(6).split('?')[0]));
    }
    if (req.method === 'POST' && (req.url === '/api/submit' || req.url === '/api/no-info')) {
      const noInfo = req.url === '/api/no-info';
      let data = '';
      req.on('data', c => data += c);
      req.on('end', async () => {
        try { await handleWrite(res, JSON.parse(data), noInfo); }
        catch (e) { console.error(e); json(res, 500, { error: 'server_error' }); }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/logo.png') {
      const p = path.join(__dirname, 'aro-logo.png');
      if (fs.existsSync(p)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        return res.end(fs.readFileSync(p));
      }
      return json(res, 404, { error: 'no_logo' });
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
