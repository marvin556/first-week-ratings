// Shared flow definitions: task names, page texts, schema mapping.
const cfg = require('./config.json');

const FLOWS = {
  m: {
    cfgKey: 'manager_rates_hire',
    taskName: (d, emp) => `New Hire: Rate day ${d} of ${cfg.days_to_rate} - ${emp.full_name}`,
    taskContent: (emp, link) => `How did ${emp.first_name}'s days go? <a href="${link}">Fill in the ratings here</a> - you can complete several days at once.`,
    texts: (emp) => ({
      heading: `How did ${emp.full_name}'s days go?`,
      sub: `Rate ${emp.first_name}'s first week on behalf of the manager. You can fill in several days in one go.`,
      privacy: `Ratings are stored securely and visible to HR only. They are not visible to ${emp.first_name}.`,
    }),
  },
  h: {
    cfgKey: 'hire_rates_manager',
    taskName: (d, emp) => `First Week: Rate your manager, day ${d} of ${cfg.days_to_rate} - ${emp.full_name}`,
    taskContent: (emp, link) => `How did the manager support ${emp.first_name} during the first week? <a href="${link}">Fill in the ratings here</a> - you can complete several days at once.`,
    texts: (emp) => ({
      heading: 'How did the manager support the new hire?',
      sub: `Record ${emp.first_name}'s feedback about their manager, day by day. You can fill in several days in one go.`,
      privacy: 'Ratings are stored securely and visible to HR only. They are not visible to the manager.',
    }),
  },
};

module.exports = { FLOWS };
