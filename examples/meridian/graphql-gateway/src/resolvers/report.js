const railsClient = require('../services/railsClient');

const Report = {
  team(report, _args, context) {
    return railsClient.getTeam(report.team_id, context.user.id);
  },

  lineItems(report) {
    return report.line_items || [];
  },
};

async function resolveReportQuery(_parent, { id }, context) {
  const report = await railsClient.getReport(id, context.user.id);
  if (!report) return null;

  const allowedRoles = ['admin', 'manager', 'auditor'];
  if (!allowedRoles.includes(context.user.role)) {
    return null;
  }

  return report;
}

module.exports = { Report, resolveReportQuery };
