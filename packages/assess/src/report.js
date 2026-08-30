// @secforge/assess/report — whole-assessment report builder. Arranges ALREADY-COMPUTED fields
// (store.listFindings + computeCoverage's percent/matrix/byCwe/cweChecklist) into a document.
// No re-derivation of severity/evidence/CVSS, no assessment_mode upgrade — same honesty rule
// as apps/server/public/index.html's window.exportFinding, which this is a whole-project sibling
// of (that one renders 1 selected finding client-side; this renders N findings + coverage
// server-side). See docs/PHASE5-POLISH-DESIGN.md §2.1.

import { computeCoverage } from './coverage.js';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function countBySeverity(findings) {
  const counts = {};
  for (const f of findings) {
    const s = f.severity || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

function severityLine(counts) {
  const keys = [...SEVERITY_ORDER.filter((s) => counts[s] != null), ...Object.keys(counts).filter((s) => !SEVERITY_ORDER.includes(s))];
  return keys.map((s) => `${s} ${counts[s]}`).join(' · ') || 'none';
}

// Coverage-matrix decided/total — plain arithmetic over the already-computed matrix, not a new
// verdict: coverage.percent is exactly decided/total already, this just shows the two numbers.
function matrixDecided(coverage) {
  const matrix = coverage?.matrix || [];
  const families = coverage?.families || [];
  const total = matrix.length * families.length;
  const decided = matrix.reduce((s, row) => s + row.cells.filter((c) => c.verdict !== 'open').length, 0);
  return { decided, total };
}

function cweChecklistTable(cweChecklist) {
  const rows = cweChecklist.map((c) => {
    const verdictOrReason = c.status === 'assessed'
      ? (c.verdict === 'vulnerable' ? `vulnerable (${c.count})` : 'clean')
      : c.status === 'open'
        ? 'open — no surface for this pattern family in this project'
        : (c.reason || 'n/a');
    return `| ${c.cwe} | ${c.name || ''} | ${c.status} | ${verdictOrReason} |`;
  });
  return ['| CWE | Name | Status | Verdict/Reason |', '|---|---|---|---|', ...rows].join('\n');
}

function coverageSection(coverage) {
  const cweChecklist = coverage?.cweChecklist || [];
  const assessed = cweChecklist.filter((c) => c.status === 'assessed').length;
  const open = cweChecklist.filter((c) => c.status === 'open').length;
  const na = cweChecklist.filter((c) => c.status === 'na').length;
  const { decided, total } = matrixDecided(coverage);
  const percent = coverage?.percent ?? 0;
  return [
    '## Coverage summary',
    '',
    `- Feature × pattern-family matrix: ${decided}/${total} cells decided (${percent}%)`,
    `- CWE checklist: ${assessed} assessed, ${open} open, ${na} n/a`,
    '',
    cweChecklistTable(cweChecklist),
    '',
  ].join('\n');
}

// Same per-finding block shape as window.exportFinding() in apps/server/public/index.html —
// a small, separate port (§2.1: not shared code across the Node/browser boundary). Every line
// is conditional on the backing field being present; nothing is invented.
function findingBlock(f, n) {
  const loc = f.evidence?.file ? `${f.evidence.file}${f.evidence.line ? ':' + f.evidence.line : ''}` : '—';
  const cvss = f.cvss || {};
  const lines = [];
  lines.push(`### ${n}. ${f.title || 'Finding'} — ${f.severity || 'unknown'}`);
  lines.push('');
  lines.push(`**Severity:** ${f.severity || ''}${typeof cvss.score === 'number' ? ` (CVSS ${cvss.score})` : ''}  `);
  if (cvss.vector) lines.push(`**CVSS vector:** \`${cvss.vector}\`  `);
  lines.push(`**Weakness:** ${f.cwe || ''}${f.cwe_name ? ' — ' + f.cwe_name : ''}${f.family ? ` (${f.family})` : ''}  `);
  lines.push(`**Asset / route:** ${f.method ? f.method + ' ' : ''}${f.route || '—'}  `);
  lines.push(`**Location:** ${loc}  `);
  lines.push(`**Detected by:** rule \`${f.rule || f.method || '—'}\`  `);
  lines.push(`**ID:** \`${f.id || ''}\`  `);
  // Honesty (§4): print assessment_mode VERBATIM — never assert runtime-confirmed for a
  // statically-confirmed finding. Same rule window.exportFinding already follows.
  lines.push(`**Assessment:** ${f.assessment_mode || 'static_confirmed'} — no runtime validation performed unless stated`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(f.description || f.title || '');
  lines.push('');
  lines.push('## Impact');
  lines.push('');
  lines.push(`${f.cwe_name ? f.cwe_name + '. ' : ''}An attacker exploiting ${f.route || 'this endpoint'} can achieve the outcome described above; see the CVSS vector for the rated impact.`);
  lines.push('');
  lines.push('## Steps to reproduce');
  lines.push('');
  lines.push(`1. Identify the endpoint \`${f.method ? f.method + ' ' : ''}${f.route || ''}\` at \`${loc}\`.`);
  lines.push('2. Send a request that exercises the missing control described in the summary.');
  lines.push(`3. Observe the response confirms the weakness (${f.cwe || ''}).`);
  lines.push('');
  if (f.snippet?.lines?.length) {
    const start = f.snippet.startLine || 1;
    const body = f.snippet.lines.map((ln, i) => {
      const no = start + i;
      const hit = f.evidence && no === f.evidence.line;
      return String(no).padStart(4) + ':  ' + ln + (hit ? '   // <-- finding' : '');
    }).join('\n');
    lines.push('## Vulnerable code');
    lines.push('');
    lines.push(`\`${f.snippet.file || ''}\`${f.snippet.stale ? ' *(source changed since the scan snapshot)*' : ''}`);
    lines.push('');
    lines.push('```');
    lines.push(body);
    lines.push('```');
    lines.push('');
  }
  if (f.remediation) {
    lines.push('## Remediation');
    lines.push('');
    lines.push(f.remediation);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Render the whole-assessment document. `style` only changes the title line — the body is
 * identical either way, because report content must never depend on which platform it's headed
 * to (§2.1). Counts come straight from findings.length/coverage.percent, never recomputed.
 */
export function renderMarkdown(project, findings, coverage, style = 'md') {
  const title = style === 'h1' ? 'HackerOne Report' : 'Security Assessment Report';
  const name = project?.name || 'unknown project';
  const pid = project?.id || 'unknown';
  const percent = coverage?.percent ?? 0;
  const lines = [
    `# ${title} — ${name}`,
    `Generated ${new Date().toISOString()} · ${findings.length} findings · coverage ${percent}%`,
    `Findings by severity: ${severityLine(countBySeverity(findings))}`,
    '',
    coverageSection(coverage),
    `## Findings (${findings.length})`,
    '',
  ];
  findings.forEach((f, i) => lines.push(findingBlock(f, i + 1)));
  lines.push('---');
  lines.push(`_Exported by SecForge from project ${name} · ${pid} · ${findings.length} findings · format: ${style}_`);
  return lines.join('\n');
}

/**
 * Structured whole-assessment report. `findings` is the array VERBATIM — no filtering, no
 * relabeling, no re-derivation (§2.1). `summary.counts.total`/`summary.coverage.percent` are the
 * exact numbers the Findings/Assess tabs already show.
 */
export function reportJson(project, findings, coverage) {
  return {
    project: project ? { id: project.id, name: project.name, sourceRoot: project.sourceRoot || null } : null,
    generatedAt: new Date().toISOString(),
    summary: {
      counts: { total: findings.length, bySeverity: countBySeverity(findings) },
      coverage: coverage || null,
    },
    findings,
    cweChecklist: coverage?.cweChecklist || [],
  };
}

const FORMATS = new Set(['h1', 'md', 'json']);
const EMPTY_COVERAGE = { percent: 0, features: [], families: [], matrix: [], byCwe: [], cweChecklist: [] };

// An unscanned project has no snapshot yet — readGraph() (inside computeCoverage) throws for
// that case. Same "not mapped yet -> empty, not an error" posture as routes.js's inventory route
// and decorate.js's loadManifest/readSourceRoot: degrade to an honestly-empty coverage rather
// than 500ing a report request for a project that just hasn't been scanned yet.
async function safeCoverage(store, projectId) {
  try { return await computeCoverage(store, projectId); }
  catch { return EMPTY_COVERAGE; }
}

/**
 * Build the whole-assessment report for a project. Reads ONLY already-persisted data
 * (store.listFindings + computeCoverage) — no new facts are ever computed here.
 * @returns {Promise<{contentType:string, body:string}>}
 */
export async function buildReport(store, projectId, format) {
  const fmt = FORMATS.has(format) ? format : 'md'; // unknown/absent format -> 'md' (read-only GET, safe default)
  const [findings, coverage, projects] = await Promise.all([
    store.listFindings(projectId),
    safeCoverage(store, projectId),
    store.listProjects(),
  ]);
  const project = projects.find((p) => p.id === projectId) || null;
  if (fmt === 'json') return { contentType: 'application/json', body: JSON.stringify(reportJson(project, findings, coverage), null, 2) };
  return { contentType: 'text/markdown; charset=utf-8', body: renderMarkdown(project, findings, coverage, fmt) };
}
