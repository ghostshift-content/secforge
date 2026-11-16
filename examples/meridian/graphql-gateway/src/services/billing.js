const PLAN_LIMITS = {
  starter: { maxTeams: 3, maxUsers: 25 },
  growth: { maxTeams: 15, maxUsers: 150 },
  enterprise: { maxTeams: Infinity, maxUsers: Infinity },
};

function limitsForPlan(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.starter;
}

function estimateReimbursementFee(amountCents, method) {
  if (method === 'ach') {
    return Math.min(500, Math.round(amountCents * 0.001));
  }
  if (method === 'instant') {
    return Math.round(amountCents * 0.015);
  }
  return 0;
}

module.exports = { limitsForPlan, estimateReimbursementFee };
