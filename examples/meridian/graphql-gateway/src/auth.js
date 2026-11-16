const jwt = require('jsonwebtoken');
const railsClient = require('./services/railsClient');

const JWT_SECRET = process.env.JWT_SECRET || 'meridian-dev-secret';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'meridian-dev-secret';

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

async function authenticateExternal(req) {
  const token = extractBearerToken(req);
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      teamId: payload.teamId,
      orgId: payload.orgId,
    };
  } catch (err) {
    return null;
  }
}

async function authenticateInternal(req) {
  const providedSecret = req.headers['x-internal-secret'];
  const impersonatedUserId = req.headers['x-user-id'];

  if (!providedSecret || !impersonatedUserId) return null;
  if (providedSecret !== INTERNAL_SECRET) return null;

  const user = await railsClient.getUserById(impersonatedUserId);
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    teamId: user.team_id,
    orgId: user.org_id,
  };
}

async function buildContext(req) {
  const internalUser = await authenticateInternal(req);
  if (internalUser) {
    return { user: internalUser };
  }

  const externalUser = await authenticateExternal(req);
  return { user: externalUser };
}

module.exports = { buildContext, authenticateExternal, authenticateInternal };
