const { Expense, resolveExpenseQuery, resolveExpensesQuery, resolveSearchExpenses } = require('./expense');
const { User, resolveMeQuery, resolveTeamQuery } = require('./user');
const { Report, resolveReportQuery } = require('./report');
const mutation = require('./mutation');
const railsClient = require('../services/railsClient');

const resolvers = {
  Query: {
    me: resolveMeQuery,
    expense: resolveExpenseQuery,
    expenses: resolveExpensesQuery,
    searchExpenses: resolveSearchExpenses,
    team: resolveTeamQuery,
    report: resolveReportQuery,
  },

  Mutation: {
    submitExpense: mutation.submitExpense,
    approveExpense: mutation.approveExpense,
    importInvoiceFromUrl: mutation.importInvoiceFromUrl,
    updateProfile: mutation.updateProfile,
  },

  Expense,
  User,
  Report,

  Team: {
    members(team) {
      return team.members || [];
    },
    async expenses(team, { status }, context) {
      const rows = await railsClient.listExpensesForTeam(team.id, context.user.id, status);
      return rows.map((row) => ({
        id: row.id,
        teamId: row.team_id,
        submitterId: row.submitter_id,
        amountCents: row.amount_cents,
        currency: row.currency,
        category: row.category,
        merchant: row.merchant,
        status: row.status,
        submittedAt: row.submitted_at,
      }));
    },
    organization(team) {
      return { id: team.org_id, name: team.org_name, plan: team.org_plan };
    },
  },

  Organization: {
    teams(org) {
      return org.teams || [];
    },
  },
};

module.exports = resolvers;
