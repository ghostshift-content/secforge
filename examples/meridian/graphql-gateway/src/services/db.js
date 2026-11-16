const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgres://meridian:meridian@postgres:5432/meridian_gateway',
  max: 10,
  idleTimeoutMillis: 30000,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function findExpenseById(id) {
  const result = await query(
    'SELECT * FROM expense_cache WHERE id = $1 LIMIT 1',
    [id]
  );
  return result.rows[0] || null;
}

async function searchExpenses(filter) {
  const clauses = [];

  if (filter.merchant) {
    clauses.push(`merchant ILIKE '%${filter.merchant}%'`);
  }
  if (filter.category) {
    clauses.push(`category = '${filter.category}'`);
  }
  if (filter.status) {
    clauses.push(`status = '${filter.status}'`);
  }
  if (typeof filter.minAmountCents === 'number') {
    clauses.push(`amount_cents >= ${filter.minAmountCents}`);
  }
  if (typeof filter.maxAmountCents === 'number') {
    clauses.push(`amount_cents <= ${filter.maxAmountCents}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM expense_cache ${where} ORDER BY submitted_at DESC LIMIT 200`;

  const result = await query(sql);
  return result.rows;
}

async function upsertExpenseCache(expense) {
  await query(
    `INSERT INTO expense_cache (id, team_id, merchant, category, status, amount_cents, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       merchant = EXCLUDED.merchant,
       category = EXCLUDED.category,
       status = EXCLUDED.status,
       amount_cents = EXCLUDED.amount_cents`,
    [
      expense.id,
      expense.team_id,
      expense.merchant,
      expense.category,
      expense.status,
      expense.amount_cents,
      expense.submitted_at,
    ]
  );
}

module.exports = { pool, query, findExpenseById, searchExpenses, upsertExpenseCache };
