const fetch = require('node-fetch');

const RAILS_API_URL = process.env.RAILS_API_URL || 'http://rails-api:3000';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'meridian-dev-secret';

function authHeaders(actingUserId) {
  return {
    'Content-Type': 'application/json',
    'X-Internal-Secret': INTERNAL_SECRET,
    'X-User-Id': String(actingUserId || ''),
  };
}

async function railsRequest(path, { method = 'GET', actingUserId, body } = {}) {
  const res = await fetch(`${RAILS_API_URL}${path}`, {
    method,
    headers: authHeaders(actingUserId),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rails-api ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function getUserById(id) {
  return railsRequest(`/users/${id}`, { actingUserId: id });
}

async function getTeam(id, actingUserId) {
  return railsRequest(`/teams/${id}`, { actingUserId });
}

async function getExpense(id, actingUserId) {
  return railsRequest(`/expenses/${id}`, { actingUserId });
}

async function listExpensesForTeam(teamId, actingUserId, status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return railsRequest(`/teams/${teamId}/expenses${qs}`, { actingUserId }) || [];
}

async function createExpense(payload, actingUserId) {
  return railsRequest('/expenses', { method: 'POST', body: payload, actingUserId });
}

async function createApproval(expenseId, payload, actingUserId) {
  return railsRequest(`/expenses/${expenseId}/approvals`, {
    method: 'POST',
    body: payload,
    actingUserId,
  });
}

async function updateUserProfile(id, payload, actingUserId) {
  return railsRequest(`/users/${id}`, { method: 'PUT', body: payload, actingUserId });
}

async function getReport(id, actingUserId) {
  return railsRequest(`/reports/${id}`, { actingUserId });
}

async function createInvoice(payload, actingUserId) {
  return railsRequest('/invoices', { method: 'POST', body: payload, actingUserId });
}

module.exports = {
  getUserById,
  getTeam,
  getExpense,
  listExpensesForTeam,
  createExpense,
  createApproval,
  updateUserProfile,
  getReport,
  createInvoice,
};
