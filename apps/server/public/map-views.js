// SecForge Map tab — the table views over the knowledge graph: Features, Interfaces, Identity,
// Coverage, Export. Pure projections of state.graph / state.reconciliation / state.maps — every
// cell is a real node, edge or ledger row; an empty section says so instead of inventing content.
// Globals used (via window.SF, see index.html): state, get, esc, sfEmpty, selectFeatureById.
(function () {
  'use strict';
  var state, get, esc, sfEmpty, selectFeatureById;
  function bind() { var S = window.SF || {}; state = S.state; get = S.get; esc = S.esc; sfEmpty = S.sfEmpty; selectFeatureById = S.selectFeatureById; return !!state; }

  // ---------- shared graph index ----------
  function index(g) {
    var byId = {}, out = {}, inn = {};
    (g.nodes || []).forEach(function (n) { byId[n.id] = n; });
    (g.edges || []).forEach(function (e) { (out[e.src] = out[e.src] || []).push(e); (inn[e.dst] = inn[e.dst] || []).push(e); });
    var touching = function (id) { return (out[id] || []).concat(inn[id] || []); };
    return {
      byId: byId, out: out, inn: inn,
      ofType: function (t) { return (g.nodes || []).filter(function (n) { return n.type === t; }); },
      targets: function (id, type, types) { return (out[id] || []).filter(function (e) { return e.type === type; }).map(function (e) { return byId[e.dst]; }).filter(function (n) { return n && (!types || types.indexOf(n.type) >= 0); }); },
      sources: function (id, type, types) { return (inn[id] || []).filter(function (e) { return e.type === type; }).map(function (e) { return byId[e.src]; }).filter(function (n) { return n && (!types || types.indexOf(n.type) >= 0); }); },
      hasAuthn: function (id) { return touching(id).some(function (e) { return e.type === 'AUTHENTICATED_BY'; }); },
      hasAuthz: function (id) { return touching(id).some(function (e) { return e.type === 'AUTHORIZED_BY' || e.type === 'GUARDED_BY'; }); },
      featureOf: function (id) { var e = (inn[id] || []).find(function (x) { return (x.type === 'EXPOSES' || x.type === 'HANDLED_BY' || x.type === 'USES_SERVICE' || x.type === 'DEFINES') && byId[x.src] && byId[x.src].type === 'FEATURE'; }); return e ? byId[e.src] : null; },
      cite: function (n) { var c = n && n.claims && n.claims[0]; if (c && c.file) return c.file + (c.line ? ':' + c.line : ''); if (n && n.data && n.data.file) return n.data.file + (n.data.line ? ':' + n.data.line : ''); return ''; },
    };
  }
  var tile = function (n, label) { return '<div class="card" style="padding:12px 16px;min-width:110px;box-shadow:none;"><div style="font-size:22px;font-weight:700;letter-spacing:-.02em;">' + n + '</div><div class="kicker" style="margin-top:2px;">' + esc(label) + '</div></div>'; };
  var tiles = function (list) { return '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 14px;">' + list.map(function (t) { return tile(t[0], t[1]); }).join('') + '</div>'; };
  var chips = function (items, cur, attr) { return '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">' + items.map(function (it) { return '<button class="chip" ' + attr + '="' + esc(it.v) + '" style="cursor:pointer;font-family:inherit;' + (it.v === cur ? 'background:var(--tint);border-color:var(--accent-brd);color:var(--accent-ink);' : '') + '">' + esc(it.label) + '</button>'; }).join('') + '</div>'; };
  var mono = function (s) { return s ? '<span class="mono muted" style="font-size:11px;">' + esc(s) + '</span>' : '<span class="muted">—</span>'; };
  var yn = function (b) { return b ? '<span style="color:var(--ok);font-weight:600;">✓</span>' : '<span style="color:var(--crit);font-weight:600;">✗</span>'; };
  var dash = function (s) { return s ? esc(s) : '<span class="muted">—</span>'; };
  var conf = function (c) { c = c || 'medium'; var col = c === 'high' ? 'var(--ok)' : c === 'low' ? 'var(--med)' : 'var(--info)'; return '<span class="chip" style="color:' + col + ';border-color:' + col + ';background:transparent;text-transform:uppercase;font-size:9.5px;">' + esc(c) + '</span>'; };

  // ---------- Features ----------
  window.renderFeaturesView = function () {
    if (!bind()) return;
    var host = document.getElementById('featuresBody'), g = state.graph; if (!host) return;
    if (!g || !g.nodes || !g.nodes.length) { host.innerHTML = sfEmpty('No features yet — map a project first.'); return; }
    var ix = index(g), features = ix.ofType('FEATURE'), domains = ix.ofType('DOMAIN');
    if (!features.length) { host.innerHTML = sfEmpty('The map produced no FEATURE nodes for this tree.'); return; }
    var rec = state.reconciliation || {}, gaps = (rec.counts && rec.counts.UNCLEAR_COVERAGE_GAP) || 0;
    var cur = state._fdomain || 'all', q = (state._fq || '').toLowerCase();
    var rows = features.map(function (f) {
      var eps = ix.targets(f.id, 'EXPOSES', ['ENDPOINT', 'ROUTE', 'GRAPHQL_OPERATION']);
      var gapN = eps.filter(function (e) { return ix.hasAuthn(e.id) && !ix.hasAuthz(e.id); }).length;
      var unauth = eps.filter(function (e) { return !ix.hasAuthn(e.id); }).length;
      var roles = {}; eps.forEach(function (e) { ix.targets(e.id, 'REQUIRES_ROLE', ['ROLE']).forEach(function (r) { roles[r.name] = 1; }); });
      ix.targets(f.id, 'AUTHENTICATED_BY', ['ACTOR']).forEach(function (a) { roles[a.name] = 1; });
      var first = eps[0] || ix.targets(f.id, 'USES_SERVICE')[0] || ix.targets(f.id, 'HANDLED_BY')[0];
      return { f: f, eps: eps.length, jobs: ix.targets(f.id, 'HANDLED_BY', ['JOB']).length, gap: gapN, unauth: unauth, roles: Object.keys(roles), src: first ? ix.cite(first) : '', domain: (f.data && f.data.domain) || 'core' };
    }).filter(function (r) { return (cur === 'all' || r.domain === cur) && (!q || r.f.name.toLowerCase().indexOf(q) >= 0 || r.domain.indexOf(q) >= 0); })
      .sort(function (a, b) { return b.eps - a.eps || a.f.name.localeCompare(b.f.name); });
    var domainChips = [{ v: 'all', label: 'All' }].concat(domains.map(function (d) { return { v: (d.name || '').toLowerCase(), label: d.name }; }));
    var sem = state.mapCoverage ? Math.round((state.mapCoverage.semantic || 0) * 100) : null;
    host.innerHTML = tiles([[features.length, 'features'], [domains.length, 'domains'], [gaps, 'coverage gaps'], [sem == null ? '—' : sem + '%', 'semantic (AI-named)']])
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' + chips(domainChips, cur, 'data-fdomain') + '<input id="featQ" placeholder="filter features…" value="' + esc(state._fq || '') + '" style="margin-left:auto;margin-bottom:10px;font:12px \'IBM Plex Mono\',monospace;padding:5px 8px;border:1px solid var(--border);border-radius:6px;min-width:200px;"></div>'
      + '<div class="card" style="overflow-x:auto;box-shadow:none;"><table class="grid"><thead><tr><th>Feature</th><th>Domain</th><th>Entry points</th><th>Roles / actors</th><th>Authz gaps</th><th>Confidence</th><th>Primary source</th></tr></thead><tbody>'
      + rows.map(function (r) {
        var gapCell = r.gap ? '<span class="chip" style="white-space:nowrap;display:inline-block;margin:1px 0;background:#FEF2F2;border-color:#FCA5A5;color:#B91C1C;">' + r.gap + ' authn·no authz</span>' : '';
        var unCell = r.unauth ? ' <span class="chip" style="white-space:nowrap;display:inline-block;margin:1px 0;background:#FFFBEB;border-color:#FCD34D;color:#92400E;">' + r.unauth + ' unauthenticated</span>' : '';
        return '<tr data-fid="' + esc(r.f.id) + '" style="cursor:pointer;"><td style="font-weight:600;">' + esc(r.f.name) + (r.f.data && r.f.data.purpose ? '<div class="muted" style="font-weight:400;font-size:11.5px;max-width:360px;">' + esc(String(r.f.data.purpose).slice(0, 140)) + '</div>' : '') + '</td>'
          + '<td><span class="chip">' + esc(r.domain) + '</span></td><td>' + r.eps + (r.jobs ? ' <span class="muted">+ ' + r.jobs + ' job' + (r.jobs === 1 ? '' : 's') + '</span>' : '') + '</td>'
          + '<td>' + (r.roles.length ? esc(r.roles.slice(0, 5).join(', ')) : '<span class="muted">—</span>') + '</td><td>' + (gapCell + unCell || '<span class="muted">none</span>') + '</td>'
          + '<td>' + conf(r.f.data && r.f.data.confidence) + ' <span class="mono muted" style="font-size:10px;">' + esc((r.f.data && r.f.data.planning_method) || '') + '</span></td><td>' + mono(r.src) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      + '<div class="muted" style="font-size:11.5px;margin-top:10px;">Click a feature to open its map. Confidence comes from the planner: <span class="mono">agent-lead</span> features were named by the Lead after reading the snapshot; <span class="mono">module-</span>/<span class="mono">local-cohesion</span> ones are deterministic structure.</div>';
    host.querySelectorAll('[data-fdomain]').forEach(function (b) { b.addEventListener('click', function () { state._fdomain = b.getAttribute('data-fdomain'); renderFeaturesView(); }); });
    var inp = document.getElementById('featQ'); if (inp) inp.addEventListener('input', function () { state._fq = inp.value; renderFeaturesView(); var i2 = document.getElementById('featQ'); if (i2) { i2.focus(); i2.setSelectionRange(i2.value.length, i2.value.length); } });
    host.querySelectorAll('tr[data-fid]').forEach(function (tr) { tr.addEventListener('click', function () { selectFeatureById(tr.getAttribute('data-fid')); if (typeof mapSub === 'function') mapSub('feature'); }); });
  };

  // ---------- Interfaces ----------
  window.renderInterfacesView = function () {
    if (!bind()) return;
    var host = document.getElementById('invBody'), g = state.graph; if (!host) return;
    if (!g || !g.nodes || !g.nodes.length) { host.innerHTML = sfEmpty('No interfaces yet — map a project first.'); return; }
    var ix = index(g);
    var kindOf = function (n) { if (n.type === 'JOB') return 'Job'; if (n.type === 'GRAPHQL_OPERATION' || (n.data && n.data.interface_kind === 'graphql')) return 'GraphQL'; if (n.data && n.data.interface_kind === 'rest') return 'REST'; return 'Route'; };
    var all = ix.ofType('ENDPOINT').concat(ix.ofType('ROUTE'), ix.ofType('GRAPHQL_OPERATION'), ix.ofType('JOB')).map(function (n) {
      var f = ix.featureOf(n.id);
      return { n: n, kind: kindOf(n), method: (n.data && n.data.method) || (n.type === 'JOB' ? 'JOB' : '—'), path: (n.data && (n.data.route || n.data.path)) || n.name, src: ix.cite(n), feature: f ? f.name : null, fid: f ? f.id : null, authn: ix.hasAuthn(n.id), authz: ix.hasAuthz(n.id), guards: ix.targets(n.id, 'AUTHENTICATED_BY').concat(ix.targets(n.id, 'AUTHORIZED_BY'), ix.targets(n.id, 'GUARDED_BY')).map(function (x) { return x.name; }) };
    });
    var counts = {}; all.forEach(function (r) { counts[r.kind] = (counts[r.kind] || 0) + 1; });
    var cur = state._ikind || 'all', q = (state._iq || '').toLowerCase();
    var rows = all.filter(function (r) { return (cur === 'all' || r.kind === cur) && (!q || (r.method + ' ' + r.path + ' ' + (r.feature || '') + ' ' + r.src).toLowerCase().indexOf(q) >= 0); })
      .sort(function (a, b) { return String(a.path).localeCompare(String(b.path)) || a.method.localeCompare(b.method); });
    host.innerHTML = tiles([[all.length, 'entry points'], [counts.Route || 0, 'web routes'], [counts.REST || 0, 'REST'], [counts.GraphQL || 0, 'GraphQL'], [counts.Job || 0, 'jobs'], [all.filter(function (r) { return !r.authn; }).length, 'unauthenticated']])
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' + chips([{ v: 'all', label: 'All' }, { v: 'Route', label: 'Route' }, { v: 'REST', label: 'REST' }, { v: 'GraphQL', label: 'GraphQL' }, { v: 'Job', label: 'Job' }], cur, 'data-ikind') + '<input id="ifQ" placeholder="filter by path, handler or feature…" value="' + esc(state._iq || '') + '" style="margin-left:auto;margin-bottom:10px;font:12px \'IBM Plex Mono\',monospace;padding:5px 8px;border:1px solid var(--border);border-radius:6px;min-width:240px;"></div>'
      + '<div class="card" style="overflow-x:auto;box-shadow:none;"><table class="grid"><thead><tr><th>Kind</th><th>Method</th><th>Path / operation</th><th>Handler</th><th>Authn</th><th>Authz</th><th>Guards</th><th>Feature</th></tr></thead><tbody>'
      + rows.map(function (r) {
        return '<tr><td><span class="chip">' + esc(r.kind) + '</span></td><td class="mono" style="font-size:11px;">' + esc(r.method) + '</td><td class="mono" style="font-size:11.5px;word-break:break-all;">' + esc(r.path) + '</td><td style="max-width:260px;word-break:break-all;">' + mono(r.src) + '</td><td>' + yn(r.authn) + '</td><td>' + yn(r.authz) + '</td><td class="muted" style="font-size:11px;">' + (r.guards.length ? esc(r.guards.slice(0, 3).join(' · ')) : '—') + '</td><td style="min-width:150px;">' + (r.feature ? '<a href="#" data-fid="' + esc(r.fid) + '" style="color:var(--accent);">' + esc(r.feature) + '</a>' : '<span class="muted">—</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      + '<div class="muted" style="font-size:11.5px;margin-top:10px;">' + rows.length + ' of ' + all.length + ' shown. Authn = an AUTHENTICATED_BY edge touches the entry; Authz = AUTHORIZED_BY or GUARDED_BY. Absence is an honest "not detected", not proof of a gap — the Assess tab decides.</div>';
    host.querySelectorAll('[data-ikind]').forEach(function (b) { b.addEventListener('click', function () { state._ikind = b.getAttribute('data-ikind'); renderInterfacesView(); }); });
    var inp = document.getElementById('ifQ'); if (inp) inp.addEventListener('input', function () { state._iq = inp.value; renderInterfacesView(); var i2 = document.getElementById('ifQ'); if (i2) { i2.focus(); i2.setSelectionRange(i2.value.length, i2.value.length); } });
    host.querySelectorAll('a[data-fid]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); selectFeatureById(a.getAttribute('data-fid')); if (typeof mapSub === 'function') mapSub('feature'); }); });
  };

  // ---------- Identity ----------
  window.renderIdentityView = function () {
    if (!bind()) return;
    var host = document.getElementById('rolesBody'), g = state.graph; if (!host) return;
    if (!g || !g.nodes) { host.innerHTML = sfEmpty('No identity model yet — map a project first.'); return; }
    var ix = index(g), actors = ix.ofType('ACTOR'), roles = ix.ofType('ROLE'), perms = ix.ofType('PERMISSION');
    if (!actors.length && !roles.length && !perms.length) { host.innerHTML = sfEmpty('No ACTOR, ROLE or PERMISSION was established for this codebase. Rules-only mapping finds declared role vocabularies (enums, constants, ability declarations) in a few stacks; the Lead (AI engine) derives the identity model from any stack by reading the source. Absence is a coverage gap, never "no roles exist".'); return; }
    var enables = {}; roles.forEach(function (r) { enables[r.id] = {}; });
    (g.edges || []).forEach(function (e) { if ((e.type === 'GRANTS' || e.type === 'AUTHORIZED_BY') && enables[e.src] && ix.byId[e.dst] && ix.byId[e.dst].type === 'PERMISSION') enables[e.src][e.dst] = 1; });
    var actorRows = actors.map(function (a) { return '<tr><td style="font-weight:600;">' + esc(a.name) + '</td><td>' + dash(a.data && a.data.kind) + '</td><td>' + dash(a.data && a.data.obtained_via) + '</td><td>' + (ix.targets(a.id, 'HAS_ROLE', ['ROLE']).map(function (r) { return esc(r.name); }).join(', ') || '<span class="muted">—</span>') + '</td><td>' + mono(ix.cite(a)) + '</td></tr>'; }).join('');
    var roleRows = roles.map(function (r) { return '<tr><td style="font-weight:600;">' + esc(r.name) + '</td><td>' + dash(r.data && r.data.scope) + '</td><td>' + dash(r.data && r.data.obtained_via) + '</td><td>' + (r.data && r.data.hierarchical ? 'yes' : 'no') + '</td><td>' + ix.sources(r.id, 'HAS_ROLE', ['ACTOR']).length + '</td><td>' + ix.sources(r.id, 'REQUIRES_ROLE').length + '</td><td>' + Object.keys(enables[r.id] || {}).length + '</td><td>' + mono(ix.cite(r)) + '</td></tr>'; }).join('');
    var cols = roles.slice(0, 16);
    var matrix = perms.length && cols.length
      ? '<div class="card" style="overflow-x:auto;box-shadow:none;margin-top:8px;"><table class="grid"><thead><tr><th>Ability</th>' + cols.map(function (r) { return '<th style="text-align:center;">' + esc(r.name) + '</th>'; }).join('') + '<th>Wiring</th></tr></thead><tbody>'
        + perms.slice(0, 300).map(function (p) { return '<tr><td class="mono" style="font-size:11.5px;">' + esc(p.name) + '</td>' + cols.map(function (r) { return '<td style="text-align:center;">' + (enables[r.id][p.id] ? '<span style="color:var(--ok);font-weight:700;">✓</span>' : '<span class="muted">○</span>') + '</td>'; }).join('') + '<td>' + mono(ix.cite(p)) + '</td></tr>'; }).join('') + '</tbody></table></div>'
      : sfEmpty('No role → ability wiring established (no GRANTS / role-AUTHORIZED_BY-permission edges).');
    host.innerHTML = tiles([[actors.length, 'actors'], [roles.length, 'roles'], [perms.length, 'permissions'], [actors.filter(function (a) { return a.data && a.data.kind && a.data.kind !== 'human'; }).length, 'token / non-human']])
      + '<div class="kicker">Actors</div>' + (actors.length ? '<div class="card" style="overflow-x:auto;box-shadow:none;margin-top:6px;"><table class="grid"><thead><tr><th>Actor</th><th>Kind</th><th>Obtained via</th><th>Holds roles</th><th>Source</th></tr></thead><tbody>' + actorRows + '</tbody></table></div>' : sfEmpty('No actor established.'))
      + '<div class="kicker" style="margin-top:16px;">Role ladder</div>' + (roles.length ? '<div class="card" style="overflow-x:auto;box-shadow:none;margin-top:6px;"><table class="grid"><thead><tr><th>Role</th><th>Scope</th><th>Obtained via</th><th>Hierarchical</th><th>Held by</th><th>Required by entries</th><th>Abilities</th><th>Source</th></tr></thead><tbody>' + roleRows + '</tbody></table></div>' : sfEmpty('No authoritative role definition established.'))
      + '<div class="kicker" style="margin-top:16px;">Role → ability matrix</div>' + matrix
      + '<div class="muted" style="font-size:11.5px;margin-top:10px;">Actor = who acts · role = privilege level · permission = resource + operation. Every row cites the production or config source that establishes it; specs, fixtures and docs never do.</div>';
  };

  // ---------- Coverage (reconciliation ledger + completion gate) ----------
  window.renderCoverageView = function () {
    if (!bind()) return;
    var host = document.getElementById('covBody'), rec = state.reconciliation, g = state.graph; if (!host) return;
    if (!rec || !rec.counts) { host.innerHTML = sfEmpty('No reconciliation ledger yet — map a project first.'); return; }
    var c = rec.counts, rows = rec.rows || [], total = Object.keys(c).reduce(function (s, k) { return s + c[k]; }, 0), gaps = c.UNCLEAR_COVERAGE_GAP || 0;
    var pct = total ? Math.round(((c.MAPPED_TO_FEATURE || 0) + (c.SHARED_INFRASTRUCTURE || 0)) / total * 100) : 0;
    var kinds = {}, feats = {}, names = {};
    (g && g.nodes || []).forEach(function (n) { if (n.type === 'FEATURE') names[n.id] = n.name; });
    rows.forEach(function (r) { (kinds[r.kind] = kinds[r.kind] || {})[r.status] = (kinds[r.kind][r.status] || 0) + 1; if (r.feature_id) { (feats[r.feature_id] = feats[r.feature_id] || {})[r.kind] = (feats[r.feature_id][r.kind] || 0) + 1; } });
    var kindList = Object.keys(kinds).sort(), featList = Object.keys(feats).sort(function (a, b) { return (names[a] || a).localeCompare(names[b] || b); });
    var byKind = '<div class="card" style="overflow-x:auto;box-shadow:none;margin-top:6px;"><table class="grid"><thead><tr><th>Inventory kind</th><th>Rows</th><th>Mapped to feature</th><th>Shared infra</th><th>Gap</th></tr></thead><tbody>'
      + kindList.map(function (k) { var s = kinds[k], n = (s.MAPPED_TO_FEATURE || 0) + (s.SHARED_INFRASTRUCTURE || 0) + (s.UNCLEAR_COVERAGE_GAP || 0); return '<tr><td class="mono" style="font-size:11.5px;">' + esc(k) + '</td><td>' + n + '</td><td>' + (s.MAPPED_TO_FEATURE || 0) + '</td><td>' + (s.SHARED_INFRASTRUCTURE || 0) + '</td><td>' + (s.UNCLEAR_COVERAGE_GAP ? '<span style="color:var(--crit);font-weight:600;">' + s.UNCLEAR_COVERAGE_GAP + '</span>' : '<span class="muted">0</span>') + '</td></tr>'; }).join('') + '</tbody></table></div>';
    var featKinds = kindList.filter(function (k) { return featList.some(function (f) { return feats[f][k]; }); });
    var matrix = featList.length ? '<div class="card" style="overflow-x:auto;box-shadow:none;margin-top:6px;"><table class="grid"><thead><tr><th>Feature</th>' + featKinds.map(function (k) { return '<th style="text-align:center;font-size:9px;">' + esc(k.replace(/_/g, ' ')) + '</th>'; }).join('') + '<th>Rows</th></tr></thead><tbody>'
      + featList.map(function (f) { var t = 0; var cells = featKinds.map(function (k) { var n = feats[f][k] || 0; t += n; return '<td style="text-align:center;' + (n ? 'background:#F0FDF4;color:#166534;font-weight:600;' : 'color:var(--ink3);') + '">' + (n || '·') + '</td>'; }).join(''); return '<tr><td style="font-weight:600;">' + esc(names[f] || f) + '</td>' + cells + '<td>' + t + '</td></tr>'; }).join('') + '</tbody></table></div>'
      : sfEmpty('The ledger has no per-feature rows (full rows are only returned once the map has been re-run on this build).');
    var gate = gaps === 0 ? '<span style="color:var(--ok);font-weight:700;">COMPLETE</span>' : '<span style="color:var(--med);font-weight:700;">COMPLETE_WITH_GAPS</span>';
    var lead = state.lastLead;
    host.innerHTML = tiles([[pct + '%', 'rows reconciled'], [total, 'inventory rows'], [kindList.length, 'inventory kinds'], [gaps, 'coverage gaps']])
      + '<div class="card" style="padding:12px 16px;box-shadow:none;display:flex;gap:14px;align-items:center;flex-wrap:wrap;"><div><div class="kicker">Completion gate</div><div style="font-size:15px;margin-top:3px;">' + gate + '</div></div><div class="mono muted" style="font-size:11.5px;line-height:1.6;">' + (c.MAPPED_TO_FEATURE || 0) + ' mapped · ' + (c.SHARED_INFRASTRUCTURE || 0) + ' shared infrastructure · ' + gaps + ' unreconciled' + (lead ? '<br>Lead' + (lead.reused ? ' (reused from this snapshot\'s stored run)' : '') + ': ' + esc(lead.engine || '') + (lead.model ? ' / ' + esc(lead.model) : '') + (lead.turns != null ? ' · ' + lead.turns + ' turns' : '') + (lead.accepted ? ' · accepted ' + lead.accepted.features + ' features, ' + lead.accepted.roles + ' roles, ' + lead.accepted.permissions + ' permissions · ' + lead.rejected + ' rejected' : lead.ok === false ? ' · Lead produced no usable plan (deterministic features kept)' : '') : '<br>No Lead ran on this snapshot (rules-only, or one-shot engine).') + '</div></div>'
      + '<div class="kicker" style="margin-top:16px;">Reconciliation by inventory kind</div>' + byKind
      + '<div class="kicker" style="margin-top:16px;">Feature × inventory kind</div>' + matrix
      + '<div class="muted" style="font-size:11.5px;margin-top:10px;">Every extracted inventory row terminates as mapped-to-feature, shared-infrastructure, or an explicit gap. 100% means the map accounted for every row — not that every vulnerability was found.</div>';
  };


  // ---------- Feature map: the 13-section document, rendered from markdown the server produced ----------
  // Tiny markdown subset (headings, tables, lists, fenced code, bold/inline code) — enough for the
  // bundle's own documents, which are generated, never free-form. Everything is escaped first.
  function mdInline(t) { return esc(t).replace(/`([^`]+)`/g, '<code class="mono" style="font-size:11px;background:var(--border2);padding:1px 4px;border-radius:4px;">$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(>])_([^_]+)_(?=$|[\s.,;:)<])/g, '$1<em class="muted">$2</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span style="color:var(--accent);">$1</span>'); }
  function mdToHtml(md) {
    var lines = String(md || '').split(/\r?\n/), out = [], i = 0;
    while (i < lines.length) {
      var l = lines[i];
      if (/^```/.test(l)) { var buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push('<pre class="mono" style="font-size:11px;background:var(--border2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;overflow-x:auto;">' + esc(buf.join('\n')) + '</pre>'); continue; }
      if (/^#{1,3}\s/.test(l)) { var lvl = l.match(/^(#+)/)[1].length; out.push(lvl === 1 ? '' : (lvl === 2 ? '<div class="sechd" style="margin-top:18px;">' + mdInline(l.replace(/^#+\s*/, '')) + '</div>' : '<div class="kicker" style="margin:10px 0 4px;">' + mdInline(l.replace(/^#+\s*/, '')) + '</div>')); i++; continue; }
      if (/^\|/.test(l)) { var rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]); var cells = rows.filter(function (r) { return !/^\|\s*-{3,}/.test(r) && !/^\|(\s*:?-+:?\s*\|)+\s*$/.test(r); }).map(function (r) { return r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(function (c) { return c.replace(/\\\|/g, '|').trim(); }); }); if (cells.length) { out.push('<div class="card" style="overflow-x:auto;box-shadow:none;margin:6px 0;"><table class="grid"><thead><tr>' + cells[0].map(function (c) { return '<th>' + mdInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + cells.slice(1).map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>'); } continue; }
      if (/^\s*[-*]\s/.test(l) || /^\s*\d+\.\s/.test(l)) { var items = []; while (i < lines.length && (/^\s*[-*]\s/.test(lines[i]) || /^\s*\d+\.\s/.test(lines[i]))) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s/, '')); out.push('<ul style="margin:4px 0 4px 18px;padding:0;font-size:12.5px;line-height:1.6;">' + items.map(function (x) { return '<li>' + mdInline(x) + '</li>'; }).join('') + '</ul>'); continue; }
      if (l.trim()) out.push('<p style="font-size:12.5px;line-height:1.6;margin:4px 0;">' + mdInline(l) + '</p>');
      i++;
    }
    return out.join('\n');
  }
  // ---------- Feature map: one feature at a time — picker, then the tester's access breakdown ----------
  // Everything below is computed from state.graph for the chosen FEATURE node only; the 13-section
  // document (server-rendered) follows underneath. A ROUTE that shares an ENDPOINT's handler file:line
  // is the same handler seen twice and collapses into that endpoint (same rule as phase1-maps.js).
  var handlerKey = function (n) { var d = n.data || {}, c = (n.claims || [])[0] || {}; var f = d.file || c.file; return f ? f + ':' + (d.line || c.line || 0) : null; };
  var kindOf = function (n) { if (n.type === 'JOB') return 'Job'; if (n.type === 'GRAPHQL_OPERATION' || (n.data && n.data.interface_kind === 'graphql')) return 'GraphQL'; if (n.data && n.data.interface_kind === 'rest') return 'REST'; return 'Web route'; };
  function featureEntries(ix, fid) {
    var raw = ix.targets(fid, 'EXPOSES', ['ENDPOINT', 'ROUTE', 'GRAPHQL_OPERATION']), keys = {};
    raw.forEach(function (n) { if (n.type === 'ENDPOINT') { var k = handlerKey(n); if (k) keys[k] = true; } });
    return raw.filter(function (n) { return !(n.type === 'ROUTE' && keys[handlerKey(n)]); }).concat(ix.targets(fid, 'HANDLED_BY', ['JOB']));
  }
  function featurePicker(ix, fid) {
    var feats = ix.ofType('FEATURE'), byDom = {};
    feats.forEach(function (f) { var d = (f.data && f.data.domain) || 'core'; (byDom[d] = byDom[d] || []).push(f); });
    return '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:4px 0 12px;"><label class="kicker" for="fmPick">Feature</label>'
      + '<select id="fmPick" style="font:13px \'IBM Plex Sans\',sans-serif;padding:6px 10px;border:1px solid var(--border);border-radius:6px;max-width:480px;background:var(--panel);color:var(--ink);">'
      + (fid ? '' : '<option value="">Choose a feature…</option>')
      + Object.keys(byDom).sort().map(function (d) { return '<optgroup label="' + esc(d) + '">' + byDom[d].sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (f) { return '<option value="' + esc(f.id) + '"' + (f.id === fid ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('') + '</optgroup>'; }).join('')
      + '</select><span class="muted" style="font-size:11.5px;">' + feats.length + ' feature' + (feats.length === 1 ? '' : 's') + ' · one at a time, nothing from the others</span></div>';
  }
  var MARK = { Y: '<span style="color:#15803D;font-weight:700;">✓</span>', N: '<span style="color:#B91C1C;font-weight:700;">✗</span>', P: '<span title="an object-level policy decides at runtime — see Authorization map below" style="color:#6B7280;font-weight:700;">◐</span>' };
  function accessBreakdown(ix, f) {
    var roles = ix.ofType('ROLE').sort(function (a, b) { return a.name.localeCompare(b.name); });
    var permissions = ix.targets(f.id, 'AUTHORIZED_BY', ['PERMISSION']), permRoles = {};
    permissions.forEach(function (p) { ix.targets(p.id, 'REQUIRES_ROLE', ['ROLE']).forEach(function (r) { permRoles[r.id] = true; }); });
    var hasPermRoles = Object.keys(permRoles).length > 0;
    var rows = featureEntries(ix, f.id).map(function (n) {
      var authn = ix.hasAuthn(n.id), authz = ix.hasAuthz(n.id), req = ix.targets(n.id, 'REQUIRES_ROLE', ['ROLE']).map(function (r) { return r.id; });
      var cell = function (rid) { if (!authn) return 'Y'; if (req.length) return req.indexOf(rid) >= 0 ? 'Y' : 'N'; if (authz) return permRoles[rid] ? 'Y' : (hasPermRoles ? 'N' : 'P'); return 'Y'; };
      var st = !authn ? ['no login needed', '#FFFBEB', '#FCD34D', '#92400E'] : !authz ? ['any signed-in user · no authz', '#FEF2F2', '#FCA5A5', '#B91C1C'] : req.length ? ['role-gated', '#EEF2FF', '#C7D2FE', '#3730A3'] : ['policy-gated', '#F0FDF4', '#BBF7D0', '#166534'];
      return { n: n, kind: kindOf(n), method: (n.data && n.data.method) || (n.type === 'JOB' ? 'JOB' : '—'), path: (n.data && (n.data.route || n.data.path)) || n.name, src: ix.cite(n), authn: authn, authz: authz,
        guards: ix.targets(n.id, 'AUTHENTICATED_BY').concat(ix.targets(n.id, 'AUTHORIZED_BY'), ix.targets(n.id, 'GUARDED_BY')).map(function (x) { return x.name; }), cells: roles.map(function (r) { return cell(r.id); }), st: st };
    }).sort(function (a, b) { return a.kind.localeCompare(b.kind) || String(a.path).localeCompare(String(b.path)) || a.method.localeCompare(b.method); });
    var counts = {}; rows.forEach(function (r) { counts[r.kind] = (counts[r.kind] || 0) + 1; });
    var anon = rows.filter(function (r) { return !r.authn; }).length, gap = rows.filter(function (r) { return r.authn && !r.authz; }).length;
    var chip = function (st) { return '<span class="chip" style="white-space:nowrap;background:' + st[1] + ';border-color:' + st[2] + ';color:' + st[3] + ';">' + st[0] + '</span>'; };
    var actors = ix.targets(f.id, 'AUTHENTICATED_BY', ['ACTOR']).map(function (a) {
      var rs = ix.targets(a.id, 'HAS_ROLE', ['ROLE']).map(function (r) { return r.name; });
      return '<span class="chip" title="' + esc((a.data && a.data.obtained_via) || '') + '">' + esc(a.name) + (a.data && a.data.kind ? ' <span class="muted">· ' + esc(a.data.kind) + '</span>' : '') + (rs.length ? ' <span class="muted">· ' + esc(rs.join(', ')) + '</span>' : '') + '</span>';
    });
    var html = '<div class="card" style="padding:14px 16px;box-shadow:none;margin-bottom:12px;"><div style="font-size:16px;font-weight:600;">' + esc(f.name) + '</div>'
      + (f.data && f.data.purpose ? '<p class="muted" style="font-size:12.5px;line-height:1.55;margin:4px 0 8px;max-width:900px;">' + esc(f.data.purpose) + '</p>' : '')
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;"><span class="kicker" style="margin-right:4px;">Who reaches it</span>' + (actors.length ? actors.join('') : '<span class="muted" style="font-size:12px;">no actor edge on this feature</span>') + '</div></div>'
      + tiles([[rows.length, 'entry points'], [counts['Web route'] || 0, 'web routes'], [counts.REST || 0, 'REST'], [counts.GraphQL || 0, 'GraphQL'], [counts.Job || 0, 'jobs'], [anon, 'no login needed'], [gap, 'signed-in · no authz']])
      + '<div class="kicker" style="margin-bottom:6px;">Access matrix · who can call each entry point</div>'
      + '<div class="muted" style="font-size:11.5px;margin-bottom:8px;">' + MARK.Y + ' allowed · ' + MARK.N + ' denied · ' + MARK.P + ' object-level policy decides at runtime · Anonymous = reachable with no login. Computed from this entry point\'s own AUTHENTICATED_BY / AUTHORIZED_BY / REQUIRES_ROLE edges' + (hasPermRoles ? ', falling back to the roles this feature\'s permissions require when only a policy guards the entry' : '') + '.</div>'
      + (rows.length ? '<div class="card" style="overflow-x:auto;box-shadow:none;"><table class="grid"><thead><tr><th>Kind</th><th>Method</th><th>Path / operation</th><th>Handler</th><th>Guards</th><th style="text-align:center;">Anonymous</th>' + roles.map(function (r) { return '<th style="text-align:center;">' + esc(r.name) + '</th>'; }).join('') + '<th>Status</th></tr></thead><tbody>'
        + rows.map(function (r) { return '<tr><td><span class="chip" style="white-space:nowrap;">' + esc(r.kind) + '</span></td><td class="mono" style="font-size:11px;">' + esc(r.method) + '</td><td class="mono" style="font-size:11.5px;word-break:break-all;">' + esc(r.path) + '</td><td style="max-width:240px;word-break:break-all;">' + mono(r.src) + '</td><td class="muted" style="font-size:11px;">' + (r.guards.length ? esc(r.guards.slice(0, 3).join(' · ')) : '—') + '</td>'
          + '<td style="text-align:center;' + (r.authn ? '' : 'background:#FFFBEB;') + '">' + (r.authn ? MARK.N : MARK.Y) + '</td>' + r.cells.map(function (c) { return '<td style="text-align:center;">' + MARK[c] + '</td>'; }).join('') + '<td>' + chip(r.st) + '</td></tr>'; }).join('')
        + '</tbody></table></div>' : sfEmpty('No entry point is wired to this feature — see the Coverage tab for the rows it still owns.'))
      + (permissions.length ? '<div class="kicker" style="margin:16px 0 6px;">What each role may do here · ' + permissions.length + ' permission' + (permissions.length === 1 ? '' : 's') + '</div><div class="card" style="overflow-x:auto;box-shadow:none;"><table class="grid"><thead><tr><th>Permission</th><th>Allowed roles</th><th>Description</th><th>Source</th></tr></thead><tbody>'
        + permissions.sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (p) { var rs = ix.targets(p.id, 'REQUIRES_ROLE', ['ROLE']).map(function (r) { return r.name; }); return '<tr><td class="mono" style="font-size:11.5px;">' + esc(p.name) + '</td><td>' + (rs.length ? esc(rs.join(', ')) : '<span class="muted">not resolved</span>') + '</td><td class="muted" style="font-size:12px;">' + esc((p.data && p.data.description) || '') + '</td><td>' + mono(ix.cite(p)) + '</td></tr>'; }).join('')
        + '</tbody></table></div>' : '');
    return html;
  }
  window.renderFeatureDocView = function (fid) {
    if (!bind()) return;
    var host = document.getElementById('featureDocHost'); if (!host || !state.project) return;
    state._docFid = fid || null; // remembered even before the graph arrives — refreshGraph re-renders with it
    var g = state.graph; if (!g || !g.nodes || !g.nodes.length) { host.innerHTML = sfEmpty('Loading the graph…'); return; }
    var ix = index(g), f = fid ? ix.byId[fid] : null;
    if (fid && !f) { host.innerHTML = featurePicker(ix, null) + sfEmpty('That feature is not in the current graph.'); wirePicker(host); return; }
    if (!f) { host.innerHTML = featurePicker(ix, null) + sfEmpty('Pick a feature to see only its entry points, who can reach each one, and its full 13-section map.'); wirePicker(host); return; }
    var url = '/api/projects/' + encodeURIComponent(state.project.id) + '/features/' + encodeURIComponent(fid) + '/map';
    host.innerHTML = featurePicker(ix, fid) + accessBreakdown(ix, f)
      + '<div style="display:flex;align-items:center;gap:10px;margin:22px 0 4px;"><div class="kicker">Full feature document · 13 sections · every table grounded to the graph and its file:line claims</div><a class="btn" style="margin-left:auto;font-size:11px;padding:4px 8px;" target="_blank" href="' + url + '">Open as markdown ↗</a></div>'
      + '<div id="fmDoc" class="muted" style="font-size:12px;padding:8px 0;">Loading feature document…</div>';
    wirePicker(host);
    fetch(url).then(function (r) { return r.text(); }).then(function (md) {
      if (state._docFid !== fid) return; // a newer selection superseded this response
      var d = document.getElementById('fmDoc'); if (d) { d.className = ''; d.style = ''; d.innerHTML = mdToHtml(md); }
    }).catch(function () { var d = document.getElementById('fmDoc'); if (d) d.innerHTML = sfEmpty('Could not load this feature\'s document.'); });
  };
  function wirePicker(host) {
    var sel = host.querySelector('#fmPick'); if (!sel) return;
    sel.addEventListener('change', function () { var v = sel.value; if (!v) return; selectFeatureById(v); if (state._docFid !== v) renderFeatureDocView(v); });
  }

  // ---------- Export (the phase1-maps bundle) ----------
  window.renderExportView = function () {
    if (!bind()) return;
    var host = document.getElementById('exportBody'); if (!host) return;
    if (!state.project) { host.innerHTML = sfEmpty('Open a project first.'); return; }
    host.innerHTML = '<div class="muted" style="font-size:12.5px;">Loading bundle index…</div>';
    get('/api/projects/' + state.project.id + '/maps').then(function (m) {
      if (!m || !m.files || !m.files.length) { host.innerHTML = sfEmpty('No phase1-maps bundle for the current snapshot yet — run Map on this build to generate it.'); return; }
      var base = '/api/projects/' + encodeURIComponent(state.project.id) + '/maps/';
      var groups = {}; m.files.forEach(function (f) { var dir = f.indexOf('/') > 0 ? f.split('/')[0] : '.'; (groups[dir] = groups[dir] || []).push(f); });
      var order = ['.', 'consolidated', 'features', 'roles', 'inventories', 'ledgers', 'graph'];
      host.innerHTML = '<div class="card" style="padding:12px 16px;box-shadow:none;"><div class="kicker">Bundle on disk</div><div class="mono" style="font-size:11.5px;margin-top:4px;word-break:break-all;">' + esc(m.root) + '</div><div class="muted" style="font-size:11.5px;margin-top:6px;">' + m.files.length + ' files · snapshot ' + esc(String(m.snapshotId || '').slice(0, 12)) + ' · every document is a projection of the sealed graph, cited to file:line. Start with <a href="' + base + 'AI_CONTEXT.md" target="_blank" style="color:var(--accent);">AI_CONTEXT.md</a> and <a href="' + base + 'consolidated/00_INDEX.md" target="_blank" style="color:var(--accent);">consolidated/00_INDEX.md</a>.</div></div>'
        + order.filter(function (d) { return groups[d]; }).concat(Object.keys(groups).filter(function (d) { return order.indexOf(d) < 0; })).map(function (d) {
          return '<div class="kicker" style="margin-top:14px;">' + esc(d === '.' ? 'top level' : d + '/') + ' <span class="muted">· ' + groups[d].length + '</span></div><div class="card" style="box-shadow:none;padding:6px 10px;display:flex;flex-wrap:wrap;gap:4px 14px;">'
            + groups[d].sort().map(function (f) { return '<a class="mono" href="' + base + f.split('/').map(encodeURIComponent).join('/') + '" target="_blank" style="font-size:11.5px;color:var(--accent);text-decoration:none;">' + esc(f.split('/').pop()) + '</a>'; }).join('') + '</div>';
        }).join('');
    }).catch(function () { host.innerHTML = sfEmpty('Could not load the bundle index for this project.'); });
  };
})();
