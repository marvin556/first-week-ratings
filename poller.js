// Poller: reads "First shift takes place on:" and creates the daily rating tasks
// in BOTH directions: manager rates the new hire, and the new hire rates the manager.
// Idempotent two ways: state file + live check of existing task names in Factorial.
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

// Two flow variants. k is carried in the signed token and state keys.
const FLOWS = {
  m: { // manager rates the new hire
    name: (d, emp) => `New Hire: Rate day ${d} of ${cfg.days_to_rate} - ${emp.full_name}`,
    content: (d, emp, link) => `How did ${emp.first_name}'s day ${d} go? <a href="${link}">Rate it here</a> - takes less than a minute.`,
    assignee: (emp, manager) => manager,
  },
  h: { // new hire rates the manager
    name: (d, emp) => `First Week: Rate your manager, day ${d} of ${cfg.days_to_rate} - ${emp.full_name}`,
    content: (d, emp, link) => `How did your manager support you today? <a href="${link}">Rate it here</a> - takes less than a minute. Your answer is not visible to your manager.`,
    assignee: (emp) => emp,
  },
};

async function run() {
  const state = loadState();

  const employees = await api.getAll('employees/employees');
  const byId = Object.fromEntries(employees.map(e => [e.id, e]));

  const allTasks = await api.getAll('tasks/tasks');
  const tasksByName = new Map(allTasks.filter(t => t.status !== 'discarded').map(t => [t.name, t]));
  const tasksById = new Map(allTasks.map(t => [String(t.id), t]));

  const values = (await api.getAll('custom_fields/values', { field_id: cfg.trigger_field_id }))
    .filter(v => v.field_id === cfg.trigger_field_id && v.value);

  let created = 0, skipped = 0;
  for (const v of values) {
    const emp = byId[v.valuable_id];
    if (!emp) continue;
    const manager = byId[emp.manager_id];
    if (!manager) { console.warn(`No manager for ${emp.full_name}, skipping`); continue; }

    const days = workingDays(v.value, cfg.days_to_rate);
    for (const k of ['m', 'h']) {
      const flow = FLOWS[k];
      for (let i = 0; i < days.length; i++) {
        const dayNum = i + 1;
        const key = `${emp.id}-${dayNum}-${k}`;
        const name = flow.name(dayNum, emp);
        let existing = state.tasks[key];

        // Self-heal: forget tasks that were discarded or deleted in Factorial
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
          e: emp.id, d: dayNum, date: days[i], m: manager.id, f: days[0], k,
          exp: Math.floor(new Date(days[i] + 'T00:00:00Z').getTime() / 1000) + 14 * 86400,
        });
        const link = `${APP_URL}/rate/${token}`;
        const content = flow.content(dayNum, emp, link);
        const assignee = flow.assignee(emp, manager);

        if (existing) {
          await api.put(`tasks/tasks/${existing.taskId}`, { name, content, due_on: days[i], status: 'todo' });
          state.tasks[key] = { taskId: existing.taskId, due_on: days[i] };
          console.log(`Rescheduled ${name} -> ${days[i]}`);
        } else {
          const task = await api.post('tasks/tasks', {
            name, content, due_on: days[i],
            assignee_ids: [Number(assignee.access_id)],
            status: 'todo',
          });
          state.tasks[key] = { taskId: task.id, due_on: days[i] };
          created++;
          console.log(`Created task ${task.id}: ${name} (assignee ${assignee.full_name}, due ${days[i]})`);
        }
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
