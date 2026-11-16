const fetch = require('node-fetch');

const RAILS_API_URL = process.env.RAILS_API_URL || 'http://rails-api:3000';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'meridian-dev-secret';
const POLL_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 60000);
const WORKER_USER_ID = process.env.RECONCILE_WORKER_USER_ID || 'system';

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-Internal-Secret': INTERNAL_SECRET,
    'X-User-Id': WORKER_USER_ID,
  };
}

async function fetchPendingReimbursements() {
  const res = await fetch(`${RAILS_API_URL}/reimbursements?status=pending`, {
    headers: headers(),
  });
  if (!res.ok) {
    throw new Error(`Failed to list pending reimbursements: ${res.status}`);
  }
  return res.json();
}

async function markReconciled(reimbursement, outcome) {
  const res = await fetch(`${RAILS_API_URL}/reimbursements/${reimbursement.id}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ status: outcome }),
  });
  if (!res.ok) {
    console.error(`Failed to update reimbursement ${reimbursement.id}: ${res.status}`);
  }
}

function decideOutcome(reimbursement) {
  const ageMs = Date.now() - new Date(reimbursement.created_at).getTime();
  if (reimbursement.bank_ack === true) return 'settled';
  if (ageMs > 1000 * 60 * 60 * 24 * 5) return 'failed';
  return null;
}

async function runOnce() {
  const pending = await fetchPendingReimbursements();
  for (const reimbursement of pending) {
    const outcome = decideOutcome(reimbursement);
    if (outcome) {
      await markReconciled(reimbursement, outcome);
      console.log(`Reconciled reimbursement ${reimbursement.id} -> ${outcome}`);
    }
  }
}

async function loop() {
  try {
    await runOnce();
  } catch (err) {
    console.error('Reconciliation pass failed', err);
  } finally {
    setTimeout(loop, POLL_INTERVAL_MS);
  }
}

if (require.main === module) {
  console.log('Starting Meridian reconciliation worker');
  loop();
}

module.exports = { runOnce, decideOutcome };
