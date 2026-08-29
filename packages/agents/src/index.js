// @secforge/agents — the roles that fan out inside a session, as data.
// The orchestrator dispatches these; each carries the prompt contract + allowed tools.
// Executor→verifier separation is enforced: a validator can never validate its own work.

import { AGENT_ROLES } from '@secforge/schemas';

export const ROLES = Object.freeze({
  framer: {
    role: 'framer',
    purpose: 'Scope the ask into a bounded forbidden actor × resource × action tuple per feature.',
    tools: ['Read', 'Grep'],
    fansInto: 'hunter',
  },
  hunter: {
    role: 'hunter',
    purpose: 'One agent per feature × pattern. Raise candidates via the differential engine (5 ledgers).',
    tools: ['Read', 'Grep', 'Glob'],
    fansInto: 'triager',
  },
  triager: {
    role: 'triager',
    purpose: 'Real vs bogus. Apply decisive-rejection controls; drop keyword matches.',
    tools: ['Read', 'Grep'],
    fansInto: 'validator',
  },
  validator: {
    role: 'validator',
    purpose: 'Independently re-prove a surviving candidate. MUST NOT validate its own prior work.',
    tools: ['Read', 'Grep'],
    fansInto: 'reporter',
  },
  reporter: {
    role: 'reporter',
    purpose: 'Freeze validated records into the Findings tab (finding folder + graph node).',
    tools: ['Read', 'Write'],
    fansInto: null,
  },
});

export function roleOf(name) {
  const r = ROLES[name];
  if (!r) throw new Error(`unknown agent role: ${name} (expected one of ${AGENT_ROLES.join(', ')})`);
  return r;
}

export { AGENT_ROLES };
