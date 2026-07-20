// Poller: triggers on NEW EMPLOYEES (and on the "First shift takes place on:" field
// when present) and creates 5 daily rating tasks per flow, all assigned to the
// configured coordinator (config.assignee_access_id).
// Flows: manager rates hire (m), hire's feedback about the manager (h).
// Each flow has ONE form link (multi-day page); the 5 tasks per flow share it.
// Idempotent: state file + live task-name dedupe + self-healing of discarded tasks.
const fs = require('fs');
const path = require('path');
const api = require('./factorial');
const { sign } = require('./token');
const cfg = require('./config.json');
const { FLOWS } = require('./flows');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const APP_URL = process.env.APP_URL || 'http://localhost:3141';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// day 1 = start date (moved to Monday if it falls on a weekend); then next working days
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

async function run() {
  const state = loadState();
  state.tasks = state.tasks || {};
  state.submitted = state.submitted || {};
  state.hires = state.hires || {};

  const employees = await api.getAll('employees/employees');
  const byId = Object.fromEntries(employees.map(e => [e.id, e]));

  // First run: seed the baseline so existing employees don't all trigger at once.
  if (!state.knownEmployees) {
    state.knownEmployees = employees.map(e => e.id);
    console.log(`[poller] Seeded baseline with ${state.knownEmployees.length} existing employees.`);
  }
  const known = new Set(state.knownEmployees);

  const triggerValues = (await api.getAll('custom_fields/values', { field_id: cfg.trigger_field_id }))
    .filter(v => v.field_id === cfg.trigger_field_id && v.value);
  const shiftDateByEmp = Object.fromEntries(triggerValues.map(v => [v.valuable_id, v.value]));

  // Triggered: any new employee since baseline, plus anyone with the shift-date field set.
  for (const e of employees) {
    if (!known.has(e.id)) {
      known.add(e.id);
      state.hires[e.id] = state.hires[e.id] || {};
      console.log(`[poller] New employee detected: ${e.full_name}`);
    }
  }
  for (const id of Object.keys(shiftDateByEmp)) state.hires[id] = state.hires[id] || {};
  state.knownEmployees = [...known];

  const allTasks = await api.getAll('tasks/tasks');
  const tasksByName = new Map(allTasks.filter(t => t.status !== 'discarded').map(t => [t.name, t]));
  const tasksById = new Map(allTasks.map(t => [String(t.id), t]));

  let created = 0, skipped = 0;
  for (const empId of Object.keys(state.hires)) {
    const emp = byId[empId];
    if (!emp) continue;
    const manager = byId[emp.manager_id];
    if (!manager) { console.warn(`No manager for ${emp.full_name}, skipping`); continue; }

    // Day 1: prefer the shift-date field, else the employee's creation date.
    const day1 = shiftDateByEmp[empId] || (emp.created_at || '').slice(0, 10);
    if (!day1) continue;
    const days = workingDays(day1, cfg.days_to_rate);

    for (const k of Object.keys(FLOWS)) {
      const flow = FLOWS[k];
      const token = sign({
        e: emp.id, m: manager.id, f: days[0], k,
        exp: Math.floor(new Date(days[0] + 'T00:00:00Z').getTime() / 1000) + 60 * 86400,
      });
      const link = `${APP_URL}/rate/${token}`;

      for (let i = 0; i < days.length; i++) {
        const dayNum = i + 1;
        const key = `${emp.id}-${dayNum}-${k}`;
        const name = flow.taskName(dayNum, emp);
        let existing = state.tasks[key];

        if (existing) {
          const live = tasksById.get(String(existing.taskId));
          if (!live || live.status === 'discarded') { delete state.tasks[key]; existing = undefined; }
        }
        if (!existing && tasksByName.has(name)) {
          const t = tasksByName.get(name);
          existing = { taskId: t.id, due_on: t.due_on };
          state.tasks[key] = existing;
        }
        if (existing && (existing.due_on === days[i] || state.submitted[key])) { skipped++; continue; }

        const content = flow.taskContent(emp, link);
        if (existing) {
          await api.put(`tasks/tasks/${existing.taskId}`, { name, content, due_on: days[i], status: 'todo' });
          state.tasks[key] = { taskId: existing.taskId, due_on: days[i] };
          console.log(`Rescheduled ${name} -> ${days[i]}`);
        } else {
          const task = await api.post('tasks/tasks', {
            name, content, due_on: days[i],
            assignee_ids: [Number(cfg.assignee_access_id)],
            status: 'todo',
          });
          state.tasks[key] = { taskId: task.id, due_on: days[i] };
          created++;
          console.log(`Created task ${task.id}: ${name} (due ${days[i]})`);
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
