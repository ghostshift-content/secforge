const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { readFileSync } = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const resolvers = require('./resolvers');
const { buildContext } = require('./auth');

const typeDefs = readFileSync(path.join(__dirname, 'schema.graphql'), 'utf-8');

async function start() {
  const app = express();
  const server = new ApolloServer({ typeDefs, resolvers });

  await server.start();

  app.use(
    '/graphql',
    cors(),
    bodyParser.json({ limit: '2mb' }),
    expressMiddleware(server, {
      context: async ({ req }) => buildContext(req),
    })
  );

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`Meridian gateway ready at http://localhost:${port}/graphql`);
  });
}

start().catch((err) => {
  console.error('Failed to start gateway', err);
  process.exit(1);
});
