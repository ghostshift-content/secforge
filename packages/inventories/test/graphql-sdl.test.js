import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext } from '../src/universal.js';
import { graphqlSdlInventory } from '../src/graphql-sdl.js';

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-gql-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

describe('SDL file — Query/Mutation field extraction', () => {
  test('emits one row per field with structured args, ID args flagged', () => {
    const root = tmpTree({
      'schema.graphql': [
        'type Query {',
        '  expense(id: ID!): Expense',
        '  expenses: [Expense]',
        '}',
        '',
        'type Mutation {',
        '  createExpense(input: ExpenseInput!): Expense',
        '}',
        '',
      ].join('\n'),
    });
    const rows = graphqlSdlInventory(buildContext(root));

    const expense = rows.find((r) => r.field_name === 'expense');
    assert.equal(expense.operation_type, 'Query');
    assert.deepEqual(expense.args, [{ name: 'id', type: 'ID!', isID: true }]);
    assert.equal(expense.file, 'schema.graphql');
    assert.equal(expense.line, 2);

    const expenses = rows.find((r) => r.field_name === 'expenses');
    assert.equal(expenses.args.length, 0);

    const mutation = rows.find((r) => r.field_name === 'createExpense');
    assert.equal(mutation.operation_type, 'Mutation');
    assert.equal(mutation.args[0].isID, false);
  });
});

describe('SDL file — multi-line argument lists', () => {
  test('a field whose args span multiple lines parses as ONE field, not one per arg line', () => {
    const root = tmpTree({
      'schema.graphql': [
        'type Mutation {',
        '  submitExpense(',
        '    teamId: ID!',
        '    amountCents: Int!',
        '  ): Expense',
        '}',
        '',
      ].join('\n'),
    });
    const rows = graphqlSdlInventory(buildContext(root));
    assert.equal(rows.length, 1, 'expected exactly one field row, not one per arg line');
    const row = rows[0];
    assert.equal(row.field_name, 'submitExpense');
    assert.equal(row.operation_type, 'Mutation');
    assert.equal(row.args.length, 2);
    assert.ok(row.args.some((a) => a.name === 'teamId' && a.isID));
    assert.ok(row.args.some((a) => a.name === 'amountCents' && !a.isID));
  });
});

describe('inline gql`...` template literal', () => {
  test('resolves the field to its real line inside the JS file', () => {
    const root = tmpTree({
      'src/schema.js': [
        "import { gql } from 'apollo-server';",
        '',
        'const typeDefs = gql`',
        '  type Query {',
        '    user(id: ID!): User',
        '  }',
        '`;',
        '',
      ].join('\n'),
    });
    const rows = graphqlSdlInventory(buildContext(root));
    const row = rows.find((r) => r.field_name === 'user');
    assert.ok(row, 'expected a user(id) field row from the inline gql template');
    assert.equal(row.args[0].isID, true);
    assert.equal(row.line, 5); // the literal "user(id: ID!): User" line inside src/schema.js
  });
});

describe('code-first resolver map (secondary path) + body span', () => {
  test('bounds each resolver body independently by brace depth', () => {
    const root = tmpTree({
      'src/resolvers.js': [
        'const resolvers = {',
        '  Query: {',
        '    expense(parent, args, context) {',
        '      return db.find(args.id);',
        '    },',
        '    expenses(parent, args, context) {',
        '      return db.all();',
        '    },',
        '  },',
        '};',
        '',
      ].join('\n'),
    });
    const rows = graphqlSdlInventory(buildContext(root));
    const expense = rows.find((r) => r.field_name === 'expense');
    const expenses = rows.find((r) => r.field_name === 'expenses');
    assert.ok(expense.body, 'expected a bounded body span on the expense resolver');
    assert.ok(expense.args.some((a) => a.name === 'id' && a.isID));

    const lines = fs.readFileSync(path.join(root, 'src/resolvers.js'), 'utf8').split(/\r?\n/);
    const body = lines.slice(expense.body.startLine, expense.body.endLine - 1).join('\n');
    assert.ok(body.includes('db.find'));
    assert.ok(!body.includes('db.all'), "expense's body span must not leak the sibling expenses resolver");
    assert.ok(expenses, 'expenses resolver should also be extracted');
  });
});
