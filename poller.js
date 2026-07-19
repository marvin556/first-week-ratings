// Poller: reads "First shift takes place on:" and creates the 5 rating tasks.
// Idempotent two ways: state file + live check of existing task names in Factorial,
// so a lost state file never causes duplicate tasks.
// Run manually: node poller.js   (also scheduled in-process by server.js)
const fs = require('fs');
const path = require('path');
const api = require('./factorial');
const { sign } = require('./token');
const cfg = require('./config.json');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const APP_URL = process.env.APP_URL || 'http://localhost:3141';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { tasks: {}, submitted: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// day 1 = firstShift date; days 2..5 = following working days (Mon-Fri)
function workingDays(firstShift, count) {
  const days = [];
  const d = new Date(firstShift + 'T00:00:00Z');
  while (days.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

const taskName = (dayNum, fullName) => `Rate day ${dayNum} of ${cfg.days_to_rate} - ${fullName}`;

async function run() {
  const state = loadState();

  // 1. All employees (id -> record), to resolve managers
  const employees = await api.getAll('employees/employees');
  const byId = Object.fromEntries(employees.map(e => [e.id, e]));

  // 2. Existing tasks, to dedupe by name even if the state file was lost
  const allTasks = await api.getAll('tasks/tasks');
  const tasksByName = new Map(allTasks.filter(t => t.status !== 'discarded').map(t => [t.name, t]));
  const tasksById = new Map(allTasks.map(t => [String(t.id), t]));

  // 3. All values of the trigger field
  const values = (await api.getAll('custom_fields/values', { field_id: cfg.trigger_field_id }))
    .filter(v => v.field_id === cfg.trigger_field_id && v.value);

  let created = 0, skipped = 0;
  for (const v of values) {
    const emp = byId[v.valuable_id];
    if (!emp) continue;
    const manager = byId[emp.manager_id];
    if (!manager) { console.warn(`No manager for ${emp.full_name}, skipping`); continue; }

    const days = workingDays(v.value, cfg.days_to_rate);
    for (let i = 0; i < days.length; i++) {
      const dayNum = i + 1;
      const key = `${emp.id}-${dayNum}`;
      const name = taskName(dayNum, emp.full_name);
      let existing = state.tasks[key];

      // Self-heal: if the task in our state was discarded or deleted in Factorial, forget it
      if (existing) {
        const live = tasksById.get(String(existing.taskId));
        if (!live || live.status === 'discarded') { delete state.tasks[key]; existing = undefined; }
      }

      // Recover task reference from Factorial if state was lost
      if (!existing && tasksByName.has(name)) {
        const t = tasksByName.get(name);
        existing = { taskId: t.id, due_on: t.due_on };
        state.tasks[key] = existing;
      }

      if (existing && (existing.due_on === days[i] || state.submitted[key])) { skipped++; continue; }

      const token = sign({
        e: emp.id, d: dayNum, date: days[i], m: manager.id,
        exp: Math.floor(new Date(days[i] + 'T00:00:00Z').getTime() / 1000) + 14 * 86400,
      });
      const link = `${APP_URL}/rate/${token}`;
      const content = `How did ${emp.first_name}'s day ${dayNum} go? Rate it here (takes less than a minute): ${link}`;

      if (existing) {
        // first-shift date changed: move due date + refresh link
        await api.put(`tasks/tasks/${existing.taskId}`, { name, content, due_on: days[i], status: 'todo' });
        state.tasks[key] = { taskId: existing.taskId, due_on: days[i] };
        console.log(`Rescheduled ${name} -> ${days[i]}`);
      } else {
        const task = await api.post('tasks/tasks', {
          name, content, due_on: days[i],
          assignee_ids: [Number(manager.access_id)],
          status: 'todo',
        });
        state.tasks[key] = { taskId: task.id, due_on: days[i] };
        created++;
        console.log(`Created task ${task.id}: ${name} (manager ${manager.full_name}, due ${days[i]})`);
      }
    }
  }
  saveState(state);
  console.log(`[poller] Done. Created ${created}, unchanged ${skipped}.`);
  return { created, skipped };
}

module.exports = { run };

if (require.main === module) {
  run().catch(e => { console.error(e); process.exit(1); });
}
