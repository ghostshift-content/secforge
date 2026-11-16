const railsClient = require('../services/railsClient');

const User = {
  team(user, _args, context) {
    if (!user.teamId) return null;
    return railsClient.getTeam(user.teamId, context.user.id);
  },

  ssnLast4(user) {
    return user.ssnLast4 || null;
  },

  payoutAccount(user) {
    return user.payoutAccount || null;
  },
};

async function resolveMeQuery(_parent, _args, context) {
  if (!context.user) return null;
  return railsClient.getUserById(context.user.id);
}

async function resolveTeamQuery(_parent, { id }, context) {
  const team = await railsClient.getTeam(id, context.user.id);
  if (!team) return null;

  const isMember = String(team.org_id) === String(context.user.orgId);
  if (!isMember && context.user.role !== 'admin' && context.user.role !== 'auditor') {
    return null;
  }

  return team;
}

module.exports = { User, resolveMeQuery, resolveTeamQuery };
