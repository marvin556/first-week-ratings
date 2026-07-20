// Discards existing "Rate day X of Y - ..." tasks (e.g. old ones with localhost links)
// so the poller can recreate them with fresh links.
// Usage: node cleanup-tasks.js --yes
const api = require('./factorial');
const cfg = require('./config.json');

async function main() {
  if (!process.argv.includes('--yes')) {
    console.log('Dry run. Add --yes to actually discard the tasks.');
  }
  const tasks = (await api.getAll('tasks/tasks'))
    .filter(t => (/^(New Hire: )?Rate day \d+ of \d+ - /.test(t.name) || /^First Week: Rate your manager, day \d+ of \d+ - /.test(t.name)) && t.status === 'todo');
  for (const t of tasks) {
    console.log(`${process.argv.includes('--yes') ? 'Discarding' : 'Would discard'}: ${t.id} ${t.name} (due ${t.due_on})`);
    if (process.argv.includes('--yes')) {
      await api.put(`tasks/tasks/${t.id}`, { name: t.name, status: 'discarded', due_on: t.due_on });
    }
  }
  console.log(`${tasks.length} open rating tasks ${process.argv.includes('--yes') ? 'discarded' : 'found'}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
