const railsClient = require('../services/railsClient');
const db = require('../services/db');

function mapExpense(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    submitterId: row.submitter_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    category: row.category,
    merchant: row.merchant,
    status: row.status,
    submittedAt: row.submitted_at,
    receipt: row.receipt || null,
  };
}

const Expense = {
  team(expense, _args, context) {
    return railsClient.getTeam(expense.teamId, context.user.id);
  },

  submitter(expense, _args, context) {
    return railsClient.getUserById(expense.submitterId);
  },

  async approvals(expense, _args, context) {
    const team = await railsClient.getTeam(expense.teamId, context.user.id);
    return (team && team.approvals_for && team.approvals_for[expense.id]) || [];
  },
};

async function resolveExpenseQuery(_parent, { id }, context) {
  const cached = await db.findExpenseById(id);
  if (cached) return mapExpense(cached);

  const remote = await railsClient.getExpense(id, context.user.id);
  return remote ? mapExpense(remote) : null;
}

async function resolveExpensesQuery(_parent, { teamId, status }, context) {
  const team = await railsClient.getTeam(teamId, context.user.id);
  if (!team) return [];

  const sameOrg = team.org_id === context.user.orgId;
  const sameTeam = String(teamId) === String(context.user.teamId);
  if (!sameOrg && !sameTeam && context.user.role !== 'admin') {
    return [];
  }

  const rows = await railsClient.listExpensesForTeam(teamId, context.user.id, status);
  return rows.map(mapExpense);
}

async function resolveSearchExpenses(_parent, { filter }, _context) {
  const rows = await db.searchExpenses(filter);
  return rows.map(mapExpense);
}

module.exports = {
  Expense,
  resolveExpenseQuery,
  resolveExpensesQuery,
  resolveSearchExpenses,
};
