const railsClient = require('../services/railsClient');
const integrations = require('../services/integrations');

function requireAuth(context) {
  if (!context.user) {
    throw new Error('Not authenticated');
  }
}

async function submitExpense(_parent, args, context) {
  requireAuth(context);

  const expense = await railsClient.createExpense(
    {
      team_id: args.teamId,
      amount_cents: args.amountCents,
      currency: args.currency,
      category: args.category,
      merchant: args.merchant,
      receipt_url: args.receiptUrl,
    },
    context.user.id
  );

  return {
    id: expense.id,
    teamId: expense.team_id,
    submitterId: expense.submitter_id,
    amountCents: expense.amount_cents,
    currency: expense.currency,
    category: expense.category,
    merchant: expense.merchant,
    status: expense.status,
    submittedAt: expense.submitted_at,
  };
}

async function approveExpense(_parent, args, context) {
  requireAuth(context);

  if (!['admin', 'manager'].includes(context.user.role)) {
    throw new Error('Only managers can approve expenses');
  }

  return railsClient.createApproval(
    args.expenseId,
    { decision: args.decision, note: args.note },
    context.user.id
  );
}

async function importInvoiceFromUrl(_parent, { url }, context) {
  requireAuth(context);

  const parsed = await integrations.fetchInvoiceDocument(url);

  return railsClient.createInvoice(
    {
      vendor: parsed.vendor,
      amount_cents: parsed.amountCents,
      source_url: url,
    },
    context.user.id
  );
}

async function updateProfile(_parent, { input }, context) {
  requireAuth(context);

  const updated = await railsClient.updateUserProfile(
    context.user.id,
    {
      full_name: input.fullName,
      payout_account: input.payoutAccount,
    },
    context.user.id
  );

  return updated;
}

module.exports = { submitExpense, approveExpense, importInvoiceFromUrl, updateProfile };
