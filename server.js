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

const flowKey = (t) => `${t.e}-${t.d}-${t.k || 'm'}`;

async function handleForm(res, tokenStr) {
  const t = verify(tokenStr);
  if (!t) return page(res, 400, msgPage('Link invalid or expired', 'Ask HR to send you a new rating link.'));

  const state = loadState();
  if (state.submitted[flowKey(t)]) {
    return page(res, 200, msgPage('Already submitted', `Day ${t.d} was already rated. Thanks!`));
  }
  const emp = await api.get(`employees/employees/${t.e}`);
  const hireFlow = t.k === 'h';
  const texts = hireFlow ? {
    heading: 'How did your manager support you today?',
    sub: `Day ${t.d} of your first week, ${emp.first_name}. Your feedback helps us improve onboarding. Takes less than a minute.`,
    privacy: 'Your rating is stored securely and visible to HR only. It is not visible to your manager.',
  } : {
    heading: `How did ${emp.full_name}'s day go?`,
    sub: `You are rating day ${t.d} of ${emp.first_name}'s first week. Takes less than a minute.`,
    privacy: `Your rating is stored securely and visible to HR only. It is not visible to ${emp.first_name}.`,
  };
  const dateStr = new Date(t.date + 'T00:00:00Z')
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  const html = FORM_TEMPLATE
    .replaceAll('{{TOKEN}}', tokenStr)
    .replaceAll('{{DAY}}', String(t.d))
    .replaceAll('{{TOTAL}}', String(cfg.days_to_rate))
    .replaceAll('{{DATE}}', dateStr.toUpperCase())
    .replaceAll('{{HEADING}}', texts.heading)
    .replaceAll('{{SUBTEXT}}', texts.sub)
    .replaceAll('{{PRIVACY}}', texts.privacy)
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
  const key = flowKey(t);
  if (state.submitted[key]) return json(res, 409, { error: 'already_submitted' });

  const manager = await api.get(`employees/employees/${t.m}`);
  const emp = await api.get(`employees/employees/${t.e}`);
  const hireFlow = t.k === 'h';
  // Both tables live on the new hire's profile. "Rated by"/"Manager" column:
  // manager flow records who rated; hire flow records which manager is rated.
  const flow = hireFlow ? cfg.hire_rates_manager : cfg.manager_rates_hire;

  // 1. Create the row for this day (one row per day). The first call creates the
  //    record; the remaining cells attach to it via custom_fields/values with
  //    valuable_type CustomResources::Value - posting more custom_resources/values
  //    would render as separate rows in the Factorial UI.
  const row = await api.post('custom_resources/values', {
    schema_id: flow.schema_id, employee_id: t.e, field_id: flow.fields.day, value: `Day ${t.d}`,
  });
  const rowId = row.id;
  const cells = [
    [flow.fields.date, t.date],
    [flow.fields.rating, String(r)],
    [flow.fields.rated_by, manager.full_name],
  ];
  if (comment && String(comment).trim()) cells.push([flow.fields.comment, String(comment).trim().slice(0, 2000)]);
  for (const [field_id, value] of cells) {
    await api.post('custom_fields/values', {
      field_id, valuable_type: 'CustomResources::Value', valuable_id: String(rowId), value,
    });
  }

  // 2. Mark the task done
  const taskRef = state.tasks[key];
  if (taskRef) {
    const taskName = hireFlow
      ? `First Week: Rate your manager, day ${t.d} of ${cfg.days_to_rate} - ${emp.full_name}`
      : `New Hire: Rate day ${t.d} of ${cfg.days_to_rate} - ${emp.full_name}`;
    try {
      await api.put(`tasks/tasks/${taskRef.taskId}`, { name: taskName, status: 'done', due_on: t.date });
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
