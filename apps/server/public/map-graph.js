// SecForge Map tab — the knowledge-graph views. Vanilla JS + hand-rolled SVG, no library.
// Two layouts, both deterministic (no force simulation, so a re-render never jitters):
//   overview  — a radial "system brain": PROJECT at the centre, DOMAIN ring, FEATURE ring(s)
//               grouped by domain, ARCH_CLUSTER (unconfirmed structure) on an outer dashed ring.
//   feature   — a layered left→right flow for ONE feature: actors/roles → auth checks →
//               endpoints → services/jobs → data stores, edges drawn as routed curves and coloured
//               by edge type, labels truncated to fit with the full text on hover/click.
// Globals this file relies on (defined in index.html): state, get, esc, sfEmpty, assessFeature,
// mapSub, selectFeatureById. Globals this file DEFINES for index.html: renderOverviewSvg,
// renderCoverageStrip, toggleGapList, enterFeatureDossier, exitToOverview, showCitationFor,
// renderDepthFooter, resetGraphView.
(function () {
  'use strict';
  // index.html exposes its closure-local state + helpers as window.SF; bind lazily at each entry point.
  var state, get, esc, sfEmpty, selectFeatureById;
  function bind() { var S = window.SF || {}; state = S.state; get = S.get; esc = S.esc; sfEmpty = S.sfEmpty; selectFeatureById = S.selectFeatureById; return !!state; }

  // ---------- shared helpers ----------
  var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
  var byId = function (g) { var m = {}; (g.nodes || []).forEach(function (n) { m[n.id] = n; }); return m; };
  // Middle-ellipsis so a long route keeps both its prefix and its last segment readable.
  function fit(s, max) {
    s = String(s == null ? '' : s);
    if (s.length <= max) return s;
    var head = Math.ceil((max - 1) * 0.6), tail = (max - 1) - head;
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  }
  var EDGE_COLOR = {
    AUTHENTICATED_BY: '#16A34A', AUTHORIZED_BY: '#2563EB', GUARDED_BY: '#2563EB', REQUIRES_ROLE: '#7C3AED',
    HAS_ROLE: '#7C3AED', GRANTS: '#7C3AED', USES_SERVICE: '#A8A29E', HANDLED_BY: '#A8A29E', EXPOSES: '#D6D3D1',
    RETURNS_DATA: '#0891B2', SHARES_IMPLEMENTATION_WITH: '#D97706', CROSSES_BOUNDARY: '#E7E5E4',
  };

  // ---------- camera: zoom-to-pointer + drag-pan on a <g> transform (one per host, wired once) ----------
  function camera(host) {
    if (host._cam) return host._cam;
    var cam = { x: 0, y: 0, z: 1, apply: function () {
      var g = host.querySelector('svg.gsvg > g.cam'); if (g) g.setAttribute('transform', 'translate(' + cam.x + ' ' + cam.y + ') scale(' + cam.z + ')');
    }, reset: function () { cam.x = 0; cam.y = 0; cam.z = 1; cam.apply(); } };
    var drag = null;
    host.addEventListener('wheel', function (e) {
      var svg = host.querySelector('svg.gsvg'); if (!svg) return;
      e.preventDefault();
      var r = svg.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      var next = clamp(cam.z * Math.exp(-e.deltaY * 0.0012), 0.3, 4);
      cam.x = px - (px - cam.x) * (next / cam.z); cam.y = py - (py - cam.y) * (next / cam.z); cam.z = next;
      cam.apply();
    }, { passive: false });
    host.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('.gnode, .ginsp, button, input, a')) return;
      drag = { x: e.clientX, y: e.clientY, ox: cam.x, oy: cam.y, moved: false }; host.classList.add('dragging');
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) > 2 || Math.abs(e.clientY - drag.y) > 2) drag.moved = true;
      cam.x = drag.ox + e.clientX - drag.x; cam.y = drag.oy + e.clientY - drag.y; cam.apply();
    });
    window.addEventListener('pointerup', function () { if (drag) { host._dragMoved = drag.moved; } drag = null; host.classList.remove('dragging'); });
    host.addEventListener('click', function (e) { if (host._dragMoved) { host._dragMoved = false; e.stopPropagation(); } }, true);
    host.addEventListener('dblclick', function (e) { if (!(e.target.closest && e.target.closest('.gnode'))) cam.reset(); });
    host._cam = cam;
    return cam;
  }
  window.resetGraphView = function () { var h = document.getElementById('kgraph'); if (h && h._cam) h._cam.reset(); };

  // ---------- overview model: one pass over edges, real DOMAIN--CONTAINS-->FEATURE / FEATURE--EXPOSES-->ENDPOINT ----------
  function overviewModel(g) {
    var nodesById = byId(g), outBySrc = {}, touching = {}, domainOfFeature = {};
    (g.edges || []).forEach(function (e) {
      (outBySrc[e.src] = outBySrc[e.src] || []).push(e);
      (touching[e.src] = touching[e.src] || []).push(e); (touching[e.dst] = touching[e.dst] || []).push(e);
      if (e.type === 'CONTAINS') { var s = nodesById[e.src], t = nodesById[e.dst]; if (s && s.type === 'DOMAIN' && t && t.type === 'FEATURE') domainOfFeature[e.dst] = e.src; }
    });
    var outOfType = function (id, types) { return (outBySrc[id] || []).filter(function (e) { return types.indexOf(e.type) >= 0; }); };
    var touchesType = function (id, types) { return (touching[id] || []).filter(function (e) { return types.indexOf(e.type) >= 0; }); };
    var project = (g.nodes || []).find(function (n) { return n.type === 'PROJECT'; }) || null;
    var features = (g.nodes || []).filter(function (n) { return n.type === 'FEATURE'; }).map(function (f) {
      var eps = outOfType(f.id, ['EXPOSES']).map(function (e) { return nodesById[e.dst]; }).filter(function (n) { return n && (n.type === 'ENDPOINT' || n.type === 'ROUTE' || n.type === 'GRAPHQL_OPERATION'); });
      var gapCount = 0, unauthnCount = 0;
      eps.forEach(function (ep) {
        var authz = touchesType(ep.id, ['AUTHORIZED_BY', 'GUARDED_BY']).length > 0, authn = touchesType(ep.id, ['AUTHENTICATED_BY']).length > 0;
        if (authn && !authz) gapCount++; if (!authn) unauthnCount++;
      });
      var svcJobCount = outOfType(f.id, ['USES_SERVICE']).length + outOfType(f.id, ['HANDLED_BY']).filter(function (e) { var n = nodesById[e.dst]; return n && n.type === 'JOB'; }).length;
      var dataCount = outOfType(f.id, ['HANDLED_BY']).filter(function (e) { var n = nodesById[e.dst]; return n && (n.type === 'MODEL' || n.type === 'DATA_STORE'); }).length;
      return { node: f, endpointCount: eps.length, gapCount: gapCount, unauthnCount: unauthnCount, svcJobCount: svcJobCount, dataCount: dataCount, domainId: domainOfFeature[f.id] || null };
    });
    var domains = (g.nodes || []).filter(function (n) { return n.type === 'DOMAIN'; }).map(function (d) { return { node: d, features: features.filter(function (f) { return f.domainId === d.id; }) }; });
    var orphan = features.filter(function (f) { return !f.domainId; });
    if (orphan.length) domains.push({ node: { id: '__ungrouped__', name: 'Ungrouped', type: 'DOMAIN' }, features: orphan });
    domains.forEach(function (d) { d.totalEndpoints = d.features.reduce(function (s, f) { return s + f.endpointCount; }, 0); d.gapCount = d.features.reduce(function (s, f) { return s + f.gapCount; }, 0); });
    domains.sort(function (a, b) { return b.totalEndpoints - a.totalEndpoints; });
    var clusters = (g.nodes || []).filter(function (n) { return n.type === 'ARCH_CLUSTER'; });
    var shares = (g.edges || []).filter(function (e) { return e.type === 'SHARES_IMPLEMENTATION_WITH'; });
    return { project: project, domains: domains, features: features, clusters: clusters, shares: shares };
  }

  // ---------- overview layout: layered tree (Project → Domains → Features · Unconfirmed clusters) ----------
  // Every node is a labelled box in a column, so labels never collide however many features exist;
  // height grows with the row count and the card scrolls. Deterministic: domain order, then endpoint count.
  var OV = { PAD: 18, HEAD: 44, ROW: 40, GAP: 10, GROUP_GAP: 14, COL_GAP: 50, W: { project: 130, domain: 180, feature: 300, cluster: 200 } };
  function treeLayout(model) {
    var pos = {}, x = OV.PAD, cols = [];
    var col = function (key, title, count) { var c = { key: key, x: x, w: OV.W[key], title: title, count: count }; cols.push(c); x += c.w + OV.COL_GAP; return c; };
    var cP = model.project ? col('project', 'Project', null) : null;
    var cD = col('domain', 'Domains', model.domains.length), cF = col('feature', 'Features', model.features.length);
    var cC = model.clusters.length ? col('cluster', 'Unconfirmed clusters', model.clusters.length) : null;
    var y = OV.HEAD, pitch = OV.ROW + OV.GAP;
    model.domains.forEach(function (d, i) {
      if (i) y += OV.GROUP_GAP;
      var fs = d.features.slice().sort(function (a, b) { return b.endpointCount - a.endpointCount; });
      var y0 = y;
      if (!fs.length) y += pitch;
      fs.forEach(function (f) { pos[f.node.id] = { x: cF.x, y: y, w: cF.w, h: OV.ROW }; y += pitch; });
      pos[d.node.id] = { x: cD.x, y: (y0 + y - pitch) / 2, w: cD.w, h: OV.ROW };
    });
    var featH = y - OV.GAP, clusterH = OV.HEAD + model.clusters.length * pitch - OV.GAP, height = Math.max(featH, clusterH, OV.HEAD + OV.ROW) + OV.PAD;
    if (cC) { var cp = model.clusters.length ? (height - OV.PAD - OV.HEAD) / model.clusters.length : pitch; model.clusters.forEach(function (c, i) { pos[c.id] = { x: cC.x, y: OV.HEAD + cp * (i + 0.5) - OV.ROW / 2, w: cC.w, h: OV.ROW }; }); }
    if (cP) pos[model.project.id] = { x: cP.x, y: (OV.HEAD + height - OV.PAD) / 2 - OV.ROW / 2, w: cP.w, h: OV.ROW };
    return { pos: pos, cols: cols, width: x - OV.COL_GAP + OV.PAD, height: height };
  }

  // ---------- inspector (DOM, beside the SVG) ----------
  function inspectorHtml(kind, data) {
    // Every value is escaped unless the pair is explicitly tagged 'html' (only for markup this file
    // builds itself from already-escaped parts). Graph values are repository- and Lead-derived — never trusted.
    var rows = function (pairs) { return pairs.filter(function (p) { return p[1] != null && p[1] !== ''; }).map(function (p) { var v = p[2] === 'html' ? p[1] : esc(p[1]); return '<div style="display:flex;gap:8px;padding:3px 0;font-size:12px;"><span class="muted" style="min-width:92px;">' + esc(p[0]) + '</span><span>' + v + '</span></div>'; }).join(''); };
    if (kind === 'feature') {
      var fm = data, f = fm.node;
      var honesty = [];
      if (fm.gapCount > 0) honesty.push('<span class="chip" style="background:#FEF2F2;border-color:#FCA5A5;color:#B91C1C;">' + fm.gapCount + ' authenticated but not authorized</span>');
      if (fm.unauthnCount > 0) honesty.push('<span class="chip" style="background:#FFFBEB;border-color:#FCD34D;color:#92400E;">' + fm.unauthnCount + ' unauthenticated</span>');
      if (!honesty.length && fm.endpointCount > 0) honesty.push('<span class="chip" style="background:#F0FDF4;border-color:#BBF7D0;color:#166534;">every endpoint has authn + authz edges</span>');
      return '<div class="kicker" style="color:var(--accent);">Feature · ' + esc((f.data && f.data.domain) || 'core') + '</div>'
        + '<h3 style="font-size:18px;margin:4px 0 8px;letter-spacing:-.01em;">' + esc(f.name) + '</h3>'
        + (f.data && f.data.purpose ? '<p class="muted" style="font-size:12px;line-height:1.5;margin:0 0 10px;">' + esc(String(f.data.purpose).slice(0, 280)) + '</p>' : '<p class="muted" style="font-size:12px;margin:0 0 10px;">No purpose derived yet — run the map with an AI engine for a Lead-written purpose.</p>')
        + rows([['Endpoints', fm.endpointCount], ['Services / jobs', fm.svcJobCount], ['Data stores', fm.dataCount], ['Rows', f.data && f.data.row_count], ['Planning', f.data && f.data.planning_method], ['Confidence', f.data && f.data.confidence]])
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0;">' + honesty.join('') + '</div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
        + '<button class="btn-primary" style="font-size:12px;padding:6px 10px;" data-act="open" data-fid="' + esc(f.id) + '">Open feature graph →</button>'
        + '<button class="btn" style="font-size:12px;padding:6px 10px;" data-act="doc" data-fid="' + esc(f.id) + '">Feature map</button>'
        + '<button class="btn" style="font-size:12px;padding:6px 10px;" data-act="assess" data-fid="' + esc(f.id) + '" data-name="' + esc(f.name) + '">Assess →</button>'
        + '</div>';
    }
    if (kind === 'domain') {
      return '<div class="kicker" style="color:var(--accent);">Domain</div><h3 style="font-size:18px;margin:4px 0 8px;">' + esc(data.node.name) + '</h3>'
        + rows([['Features', data.features.length], ['Endpoints', data.totalEndpoints], ['Authz gaps', data.gapCount]]);
    }
    if (kind === 'cluster') {
      return '<div class="kicker" style="color:var(--ink3);">Technical cluster · not a feature</div><h3 style="font-size:18px;margin:4px 0 8px;">' + esc(data.name) + '</h3>'
        + '<p class="muted" style="font-size:12px;line-height:1.5;">' + esc((data.data && data.data.note) || 'Directory-derived structure that no Lead confirmed as a business capability.') + '</p>'
        + rows([['Rows', data.data && data.data.row_count], ['Domain', data.data && data.data.domain]]);
    }
    if (kind === 'project') return '<div class="kicker" style="color:var(--accent);">Project</div><h3 style="font-size:18px;margin:4px 0 8px;">' + esc(data.project ? data.project.name : '') + '</h3>' + rows([['Domains', data.domains.length], ['Features', data.features.length], ['Technical clusters', data.clusters.length]]);
    if (kind === 'node') {
      var n = data.node;
      return '<div class="kicker" style="color:var(--accent);">' + esc(n.type) + '</div><h3 style="font-size:15px;margin:4px 0 8px;word-break:break-all;">' + esc(data.label || n.name) + '</h3>'
        + rows([['File', n.file ? '<span class="mono" style="font-size:11px;word-break:break-all;">' + esc(n.file) + (n.line ? ':' + esc(n.line) : '') + '</span>' : null, 'html'], ['Kind', n.kind], ['Authn', n.type === 'ENDPOINT' ? (n.authn ? '✓' : '<span style="color:var(--crit)">none</span>') : null, 'html'], ['Authz', n.type === 'ENDPOINT' ? (n.authz ? '✓' : '<span style="color:var(--crit)">none</span>') : null, 'html']])
        + '<div id="graphCitationInline" style="margin-top:8px;"></div>';
    }
    return '<p class="muted" style="font-size:12.5px;">Hover a node to highlight its neighbours; click to inspect.</p>';
  }
  function wireInspector(host, model) {
    host.querySelectorAll('.ginsp [data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act'), fid = b.getAttribute('data-fid');
        if (act === 'open') enterFeatureDossier(fid);
        else if (act === 'doc') { if (typeof selectFeatureById === 'function') selectFeatureById(fid); if (typeof mapSub === 'function') mapSub('feature'); }
        else if (act === 'assess') { if (typeof selectFeatureById === 'function') selectFeatureById(fid); if (typeof assessFeature === 'function') assessFeature(b.getAttribute('data-name')); }
      });
    });
  }

  // ---------- overview render ----------
  window.renderOverviewSvg = function () {
    if (!bind()) return;
    var g = state.graph, host = document.getElementById('kgraph'); if (!host) return;
    var titleEl = document.getElementById('graphHeaderTitle');
    var model = (g && g.nodes) ? overviewModel(g) : { project: null, domains: [], features: [], clusters: [], shares: [] };
    if (!model.features.length && !model.clusters.length) {
      host.innerHTML = sfEmpty('No graph yet. Nothing has been mapped for this project.');
      if (titleEl) titleEl.textContent = 'System graph';
      return;
    }
    var lay = treeLayout(model), pos = lay.pos, MAXH = 760;
    var nodesById = byId(g), parts = [], neighbours = {};
    var link = function (a, b) { (neighbours[a] = neighbours[a] || {})[b] = true; (neighbours[b] = neighbours[b] || {})[a] = true; };
    var R = function (p) { return { x: p.x + p.w, y: p.y + p.h / 2 }; }, L = function (p) { return { x: p.x, y: p.y + p.h / 2 }; };
    // Left-to-right S-curve between columns; shares edges arc out of the right side of the feature column.
    var curve = function (a, b, cls, color) { var c = (a.x + b.x) / 2; return '<path class="gedge ' + esc(cls) + '" d="M' + a.x + ' ' + a.y + ' C' + c + ' ' + a.y + ' ' + c + ' ' + b.y + ' ' + b.x + ' ' + b.y + '" fill="none" stroke="' + color + '"/>'; };
    var arc = function (a, b, cls, color) { var bulge = a.x + 28 + Math.min(60, Math.abs(b.y - a.y) * 0.25); return '<path class="gedge ' + esc(cls) + '" d="M' + a.x + ' ' + a.y + ' C' + bulge + ' ' + a.y + ' ' + bulge + ' ' + b.y + ' ' + b.x + ' ' + b.y + '" fill="none" stroke="' + color + '" stroke-dasharray="4 3"><title>shares implementation</title></path>'; };
    lay.cols.forEach(function (c) { parts.push('<text class="gdomain-label" x="' + c.x + '" y="18">' + esc(c.title) + '</text>' + (c.count != null ? '<text class="gsub" x="' + c.x + '" y="31">' + c.count + '</text>' : '')); });
    model.domains.forEach(function (d) {
      var pd = pos[d.node.id]; if (!pd) return;
      if (model.project && pos[model.project.id]) { parts.push(curve(R(pos[model.project.id]), L(pd), 'e-' + d.node.id, '#D6D3D1')); link(model.project.id, d.node.id); }
      d.features.forEach(function (f) { var pf = pos[f.node.id]; if (pf) { parts.push(curve(R(pd), L(pf), 'e-' + d.node.id + ' e-' + f.node.id, '#D6D3D1')); link(d.node.id, f.node.id); } });
    });
    model.shares.forEach(function (e) { var a = pos[e.src], b = pos[e.dst]; if (a && b) { parts.push(arc(R(a), R(b), 'e-' + e.src + ' e-' + e.dst, EDGE_COLOR.SHARES_IMPLEMENTATION_WITH)); link(e.src, e.dst); } });
    var node = function (id, p, cls, fill, stroke, dash, label, sub, extraAttr, inkFill) {
      return '<g class="gnode ' + cls + '" data-nid="' + esc(id) + '" ' + (extraAttr || '') + ' transform="translate(' + p.x + ' ' + p.y + ')"><title>' + esc(label + (sub ? ' · ' + sub : '')) + '</title>'
        + '<rect width="' + p.w + '" height="' + p.h + '" rx="8" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"' + (dash ? ' stroke-dasharray="4 3"' : '') + '/>'
        + '<text class="glabel" x="10" y="17"' + (inkFill ? ' style="fill:' + inkFill + ';stroke:none"' : '') + '>' + esc(fit(label, Math.floor(p.w / 7.2))) + '</text>'
        + (sub ? '<text class="gsub" x="10" y="31"' + (inkFill ? ' style="fill:' + inkFill + ';stroke:none;opacity:.8"' : '') + '>' + esc(fit(sub, Math.floor(p.w / 5.9))) + '</text>' : '') + '</g>';
    };
    if (model.project && pos[model.project.id]) parts.push(node(model.project.id, pos[model.project.id], 'g-project', '#1C1917', '#1C1917', false, model.project.name, model.features.length + ' features', 'data-kind="project"', '#FAFAF9'));
    model.domains.forEach(function (d) { var p = pos[d.node.id]; if (p) parts.push(node(d.node.id, p, 'g-domain', '#57534E', '#57534E', false, d.node.name, d.features.length + ' feature' + (d.features.length === 1 ? '' : 's') + (d.totalEndpoints ? ' · ' + d.totalEndpoints + ' endpoints' : ''), 'data-kind="domain"', '#FAFAF9')); });
    model.features.forEach(function (f) {
      var p = pos[f.node.id]; if (!p) return;
      var stroke = f.gapCount > 0 ? '#DC2626' : (f.unauthnCount > 0 ? '#D97706' : '#4F46E5');
      var bits = [];
      if (f.endpointCount > 0) bits.push(f.endpointCount + ' endpoint' + (f.endpointCount === 1 ? '' : 's')); else if (f.svcJobCount > 0) bits.push(f.svcJobCount + ' svc/job'); else bits.push('no endpoints');
      if (f.gapCount > 0) bits.push(f.gapCount + ' no authz'); if (f.unauthnCount > 0) bits.push(f.unauthnCount + ' unauthenticated');
      parts.push(node(f.node.id, p, 'g-feature' + (f.gapCount > 0 ? ' gbubble-gap' : (f.unauthnCount > 0 ? ' gbubble-warn' : '')), '#EEF2FF', stroke, false, f.node.name, bits.join(' · '), 'data-kind="feature"'));
    });
    model.clusters.forEach(function (c) { var p = pos[c.id]; if (p) parts.push(node(c.id, p, 'garch-chip', '#F5F5F4', '#A8A29E', true, c.name, (c.data && c.data.row_count) ? c.data.row_count + ' rows · not a confirmed feature' : 'not a confirmed feature', 'data-kind="cluster"')); });

    var svg = '<svg class="gsvg" viewBox="0 0 ' + lay.width + ' ' + lay.height + '" width="' + lay.width + '" height="' + lay.height + '" style="display:block;max-width:100%;height:auto;" role="img" aria-label="System graph overview"><g class="cam">' + parts.join('') + '</g></svg>';
    var legend = '<div class="leg" style="padding:9px 12px;border-top:1px solid var(--border);">'
      + '<span><i style="background:#1C1917;border-radius:3px"></i>Project / domain</span><span><i style="background:#EEF2FF;border:2px solid #4F46E5;border-radius:3px"></i>Feature</span>'
      + '<span><i style="background:#EEF2FF;border:2px solid #DC2626;border-radius:3px"></i>authn but no authz</span><span><i style="background:#EEF2FF;border:2px solid #D97706;border-radius:3px"></i>unauthenticated endpoints</span>'
      + '<span><i style="background:#F5F5F4;border:2px dashed #A8A29E;border-radius:3px"></i>Unconfirmed / architecture</span><span><i style="width:14px;height:0;border-top:2px dashed #D97706;border-radius:0"></i>Shares implementation</span>'
      + '<span class="mono muted" style="margin-left:auto;font-size:10.5px;" id="graphHint">hover · click to inspect · double-click a feature to open it · scroll to zoom · drag to pan</span></div>';
    host.innerHTML = '<div style="display:flex;align-items:stretch;"><div style="flex:1 1 auto;min-width:0;max-height:' + MAXH + 'px;overflow:auto;padding:4px 0 4px 4px;">' + svg + '</div>'
      + '<div class="ginsp" style="flex:0 0 280px;border-left:1px solid var(--border);padding:14px;overflow:auto;max-height:' + MAXH + 'px;">' + inspectorHtml('project', model) + '</div></div>' + legend;
    if (titleEl && state.project) titleEl.textContent = 'System graph · ' + state.project.name + ' · ' + g.nodes.length + ' nodes · ' + g.edges.length + ' edges';

    var insp = host.querySelector('.ginsp');
    var featureById = {}; model.features.forEach(function (f) { featureById[f.node.id] = f; });
    var domainById = {}; model.domains.forEach(function (d) { domainById[d.node.id] = d; });
    var highlight = function (id) {
      var keep = id ? Object.assign({}, neighbours[id] || {}) : null; if (keep) keep[id] = true;
      host.querySelectorAll('.gnode').forEach(function (el) { el.classList.toggle('dim', !!keep && !keep[el.getAttribute('data-nid')]); });
      host.querySelectorAll('.gedge').forEach(function (el) { var on = !keep || el.classList.contains('e-' + id); el.classList.toggle('dim', !on); el.classList.toggle('hl', !!keep && on); });
    };
    host.querySelectorAll('.gnode').forEach(function (el) {
      var id = el.getAttribute('data-nid'), kind = el.getAttribute('data-kind');
      el.addEventListener('mouseenter', function () { highlight(id); });
      el.addEventListener('mouseleave', function () { highlight(state._gsel || null); });
      el.addEventListener('click', function () {
        state._gsel = id; highlight(id);
        host.querySelectorAll('.gnode.sel').forEach(function (x) { x.classList.remove('sel'); }); el.classList.add('sel');
        insp.innerHTML = kind === 'feature' ? inspectorHtml('feature', featureById[id]) : kind === 'domain' ? inspectorHtml('domain', domainById[id]) : kind === 'cluster' ? inspectorHtml('cluster', nodesById[id]) : inspectorHtml('project', model);
        wireInspector(host, model);
      });
      el.addEventListener('dblclick', function (e) { e.stopPropagation(); if (kind === 'feature') enterFeatureDossier(id); });
    });
    camera(host).reset();
  };

  // ---------- coverage strip + gap list (reconciliation ledger, honest: no chip at 0 gaps) ----------
  window.renderCoverageStrip = function () {
    if (!bind()) return;
    var host = document.getElementById('graphCovStrip'); if (!host) return;
    var rec = state.reconciliation; if (!rec || !rec.counts) { host.innerHTML = ''; return; }
    var c = rec.counts, chips = [
      '<span class="chip" style="background:#F0FDF4;border-color:#BBF7D0;color:#166534;">' + (c.MAPPED_TO_FEATURE || 0) + ' mapped</span>',
      '<span class="chip" style="background:#ECFEFF;border-color:#A5F3FC;color:#155E75;">' + (c.SHARED_INFRASTRUCTURE || 0) + ' shared infra</span>'];
    var gapN = c.UNCLEAR_COVERAGE_GAP || 0;
    if (gapN > 0) chips.push('<button class="chip" style="background:#FEF2F2;border-color:#FCA5A5;color:#B91C1C;cursor:pointer;font-family:inherit;" onclick="toggleGapList()">' + gapN + ' gap' + (gapN === 1 ? '' : 's') + '</button>');
    host.innerHTML = chips.join('');
  };
  window.toggleGapList = function () {
    if (!bind()) return;
    var el = document.getElementById('graphGapList'); if (!el) return;
    if (!el.hidden) { el.hidden = true; return; }
    var gaps = (state.reconciliation && state.reconciliation.gaps) || [];
    el.innerHTML = gaps.length
      ? '<div class="card" style="padding:10px 14px;max-height:220px;overflow:auto;"><div class="kicker" style="margin-bottom:6px;">Coverage gaps · ' + gaps.length + '</div>'
        + gaps.map(function (g) { return '<div class="mono" style="font-size:11.5px;padding:3px 0;color:var(--ink2);">' + esc(g.file) + ':' + esc(g.line) + ' <span style="color:var(--ink);">' + esc(g.kind) + '</span>' + (g.entry ? ' · ' + esc(g.entry) : '') + '</div>'; }).join('') + '</div>'
      : sfEmpty('No gap rows.');
    el.hidden = false;
  };

  // ---------- feature flow: layered columns, routed edges, truncated labels ----------
  var COLS = [
    { key: 'identity', title: 'Actors & roles', types: { ACTOR: 1, ROLE: 1 } },
    { key: 'auth', title: 'Auth checks', types: { AUTH_CHECK: 1, TOKEN: 1 } },
    { key: 'entry', title: 'Endpoints', types: { ENDPOINT: 1, ROUTE: 1, GRAPHQL_OPERATION: 1 } },
    { key: 'impl', title: 'Services & jobs', types: { SERVICE: 1, JOB: 1 } },
    { key: 'data', title: 'Data stores & models', types: { DATA_STORE: 1, MODEL: 1 } },
  ];
  var COL_W = 236, NODE_W = 206, NODE_H = 40, ROW_GAP = 9, HEAD_H = 46, PAD_X = 18, MAX_ROWS = 48;
  function dossierNodes(d) {
    var out = [];
    var add = function (list, type) { (list || []).forEach(function (n) { out.push({ id: n.id, type: n.type || type, name: n.name, raw: n }); }); };
    add(d.actors, 'ACTOR'); add(d.roles, 'ROLE'); add(d.authChecks, 'AUTH_CHECK'); add(d.endpoints, 'ENDPOINT'); add(d.services, 'SERVICE'); add(d.jobs, 'JOB'); add(d.dataStores, 'DATA_STORE');
    var seen = {}; return out.filter(function (n) { if (seen[n.id]) return false; seen[n.id] = true; return true; });
  }
  function flowLayout(nodes, filter) {
    var cols = COLS.map(function (c) { return { key: c.key, title: c.title, items: [], hidden: 0 }; });
    nodes.forEach(function (n) {
      var ci = COLS.findIndex(function (c) { return c.types[n.type]; }); if (ci < 0) return;
      if (filter && n.type === 'ENDPOINT' && (String((n.raw.method || '') + ' ' + (n.raw.route || n.name)).toLowerCase().indexOf(filter) < 0)) return;
      cols[ci].items.push(n);
    });
    cols.forEach(function (c) {
      c.items.sort(function (a, b) { var ka = a.type === 'ENDPOINT' ? (a.raw.route || a.name) : a.name, kb = b.type === 'ENDPOINT' ? (b.raw.route || b.name) : b.name; return String(ka).localeCompare(String(kb)); });
      if (c.items.length > MAX_ROWS && !state._gshowAll) { c.hidden = c.items.length - MAX_ROWS; c.items = c.items.slice(0, MAX_ROWS); }
    });
    var used = cols.filter(function (c) { return c.items.length || c.hidden; });
    var pos = {}, maxRows = 1;
    used.forEach(function (c, ci) {
      c.x = PAD_X + ci * COL_W;
      c.items.forEach(function (n, ri) { pos[n.id] = { x: c.x, y: HEAD_H + ri * (NODE_H + ROW_GAP), w: NODE_W, h: NODE_H, col: ci }; });
      maxRows = Math.max(maxRows, c.items.length + (c.hidden ? 1 : 0));
    });
    return { cols: used, pos: pos, width: Math.max(640, PAD_X * 2 + used.length * COL_W), height: HEAD_H + maxRows * (NODE_H + ROW_GAP) + 14 };
  }
  function flowEdges(g, pos) {
    var out = [];
    (g && g.edges || []).forEach(function (e) {
      var a = pos[e.src], b = pos[e.dst]; if (!a || !b || a.col === b.col) return;
      var from = a.col < b.col ? a : b, to = a.col < b.col ? b : a;
      out.push({ e: e, from: from, to: to });
    });
    return out;
  }
  function endpointState(n) { return n.raw.authn && n.raw.authz ? 'ok' : (n.raw.authn ? 'gap' : 'warn'); }
  window.renderFeatureDossierSvg = function (d) {
    if (!bind()) return;
    var host = document.getElementById('kgraph'), titleEl = document.getElementById('graphHeaderTitle'); if (!host) return;
    if (!d || d.ok === false) {
      host.innerHTML = sfEmpty('Coverage gap: ' + ((d && d.reason) || 'feature not found'));
      renderDepthFooter(null); var cp0 = document.getElementById('graphCitationPanel'); if (cp0) cp0.innerHTML = '';
      if (titleEl) titleEl.textContent = 'System graph'; return;
    }
    var nodes = dossierNodes(d), filter = (state._gfilter || '').toLowerCase();
    var lay = flowLayout(nodes, filter), pos = lay.pos, edges = flowEdges(state.graph, pos);
    var parts = [], nodeEdges = {};
    lay.cols.forEach(function (c) {
      parts.push('<text class="gdomain-label" x="' + (c.x + 2) + '" y="22">' + esc(c.title) + '</text><text class="gsub" x="' + (c.x + 2) + '" y="36">' + c.items.length + (c.hidden ? ' shown · ' + c.hidden + ' more' : '') + '</text>');
      if (c.hidden) parts.push('<g class="gnode gmore" data-act="showall"><rect x="' + c.x + '" y="' + (HEAD_H + c.items.length * (NODE_H + ROW_GAP)) + '" width="' + NODE_W + '" height="' + NODE_H + '" rx="8" fill="var(--border2)" stroke="var(--border)" stroke-dasharray="4 3"/><text class="glabel" text-anchor="middle" x="' + (c.x + NODE_W / 2) + '" y="' + (HEAD_H + c.items.length * (NODE_H + ROW_GAP) + 24) + '">+ ' + c.hidden + ' more — click to show all</text></g>');
    });
    edges.forEach(function (x, i) {
      var a = x.from, b = x.to, x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, span = b.col - a.col;
      var c1 = x1 + Math.min(80, COL_W * 0.45), c2 = x2 - Math.min(80, COL_W * 0.45);
      var color = EDGE_COLOR[x.e.type] || '#D6D3D1';
      parts.unshift('<path class="gedge e-' + esc(x.e.src) + ' e-' + esc(x.e.dst) + (span > 1 ? ' far' : '') + '" d="M' + x1 + ' ' + y1 + ' C' + c1 + ' ' + y1 + ' ' + c2 + ' ' + y2 + ' ' + x2 + ' ' + y2 + '" fill="none" stroke="' + color + '"><title>' + esc(x.e.type) + '</title></path>');
      (nodeEdges[x.e.src] = nodeEdges[x.e.src] || []).push(i); (nodeEdges[x.e.dst] = nodeEdges[x.e.dst] || []).push(i);
    });
    nodes.forEach(function (n) {
      var p = pos[n.id]; if (!p) return;
      var label, sub = '', stroke = '#E7E5E4', fill = '#fff', tag = n.type;
      if (n.type === 'ENDPOINT') {
        var st = endpointState(n); stroke = st === 'ok' ? '#86EFAC' : st === 'gap' ? '#DC2626' : '#D97706';
        // Route keeps its TAIL (the action is what distinguishes siblings); the method moves to the sub line.
        var route = String(n.raw.route || n.name || ''); label = route.length > 30 ? '…' + route.slice(route.length - 29) : route;
        sub = ((n.raw.method || '') + ' · ' + (n.raw.authn ? 'authn ✓' : 'no authn') + ' · ' + (n.raw.authz ? 'authz ✓' : 'no authz')).replace(/^ · /, '');
      } else { label = n.name; sub = n.raw.kind || (n.raw.file ? fit(n.raw.file, 30) : ''); if (n.type === 'ACTOR' || n.type === 'ROLE') { fill = '#EEF2FF'; stroke = '#C7D2FE'; } if (n.type === 'DATA_STORE' || n.type === 'MODEL') fill = '#F5F5F4'; }
      parts.push('<g class="gnode" data-nid="' + esc(n.id) + '" transform="translate(' + p.x + ' ' + p.y + ')"><title>' + esc(tag + ' · ' + label + (sub ? ' · ' + sub : '')) + '</title>'
        + '<rect width="' + p.w + '" height="' + p.h + '" rx="8" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + (n.type === 'ENDPOINT' && endpointState(n) !== 'ok' ? 2 : 1.2) + '"/>'
        + '<text class="glabel" x="10" y="17">' + esc(n.type === 'ENDPOINT' ? label : fit(label, 30)) + '</text>'
        + '<text class="gsub" x="10" y="31"' + (n.type === 'ENDPOINT' ? ' fill="' + (endpointState(n) === 'ok' ? '#166534' : '#B91C1C') + '"' : '') + '>' + esc(fit(sub, 34)) + '</text></g>');
    });
    var svg = '<svg class="gsvg" viewBox="0 0 ' + lay.width + ' ' + lay.height + '" style="height:' + Math.min(lay.height, 760) + 'px" role="img" aria-label="Feature flow graph"><g class="cam">' + parts.join('') + '</g></svg>';
    var head = '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);flex-wrap:wrap;">'
      + '<input id="graphFilterInp" placeholder="filter endpoints…" value="' + esc(state._gfilter || '') + '" style="font:12px \'IBM Plex Mono\',monospace;padding:5px 8px;border:1px solid var(--border);border-radius:6px;min-width:200px;">'
      + '<span class="mono muted" style="font-size:10.5px;">' + d.endpoints.length + ' endpoints · ' + (d.authChecks || []).length + ' auth checks · ' + (d.services || []).length + ' services · ' + (d.dataStores || []).length + ' data stores</span>'
      + '<span class="leg" style="margin-left:auto;"><span><i style="width:14px;height:0;border-top:2px solid #16A34A;border-radius:0"></i>authn</span><span><i style="width:14px;height:0;border-top:2px solid #2563EB;border-radius:0"></i>authz / guard</span><span><i style="width:14px;height:0;border-top:2px solid #7C3AED;border-radius:0"></i>role</span><span><i style="width:14px;height:0;border-top:2px solid #A8A29E;border-radius:0"></i>uses</span></span>'
      + (state.project && d.feature ? '<a class="btn" style="font-size:11px;padding:4px 8px;" target="_blank" href="/api/projects/' + encodeURIComponent(state.project.id) + '/features/' + encodeURIComponent(d.feature.id) + '/map">Full map ↗</a>' : '') + '</div>';
    host.innerHTML = head + '<div style="display:flex;align-items:stretch;"><div style="flex:1 1 auto;min-width:0;overflow:hidden;">' + svg + '</div>'
      + '<div class="ginsp" style="flex:0 0 280px;border-left:1px solid var(--border);padding:14px;overflow:auto;max-height:' + Math.min(lay.height, 760) + 'px;">' + inspectorHtml('hint') + '</div></div>'
      + '<div class="mono muted" style="font-size:10.5px;padding:8px 12px;border-top:1px solid var(--border);" id="graphHint">hover a node to highlight its edges · click an endpoint for its cited excerpt · scroll to zoom · drag to pan</div>';
    if (titleEl) titleEl.textContent = 'Feature · ' + (d.feature ? d.feature.name : '');
    var insp = host.querySelector('.ginsp');
    var highlight = function (id) {
      host.querySelectorAll('.gedge').forEach(function (el) { var on = !id || el.classList.contains('e-' + id); el.classList.toggle('dim', !!id && !on); el.classList.toggle('hl', !!id && on); });
      if (!id) { host.querySelectorAll('.gnode.dim').forEach(function (el) { el.classList.remove('dim'); }); return; }
      var keep = { }; keep[id] = true; (state.graph && state.graph.edges || []).forEach(function (e) { if (e.src === id) keep[e.dst] = true; if (e.dst === id) keep[e.src] = true; });
      host.querySelectorAll('.gnode[data-nid]').forEach(function (el) { el.classList.toggle('dim', !keep[el.getAttribute('data-nid')]); });
    };
    var nodeById = {}; nodes.forEach(function (n) { nodeById[n.id] = n; });
    host.querySelectorAll('.gnode[data-nid]').forEach(function (el) {
      var id = el.getAttribute('data-nid');
      el.addEventListener('mouseenter', function () { highlight(id); });
      el.addEventListener('mouseleave', function () { highlight(state._gsel || null); });
      el.addEventListener('click', function () {
        state._gsel = id; highlight(id);
        host.querySelectorAll('.gnode.sel').forEach(function (x) { x.classList.remove('sel'); }); el.classList.add('sel');
        var n = nodeById[id];
        insp.innerHTML = inspectorHtml('node', { node: Object.assign({ type: n.type }, n.raw), label: n.type === 'ENDPOINT' ? ((n.raw.method || '') + ' ' + (n.raw.route || n.name)).trim() : n.name });
        showCitationFor(id, document.getElementById('graphCitationInline'));
      });
    });
    var more = host.querySelector('[data-act="showall"]'); if (more) more.addEventListener('click', function () { state._gshowAll = true; renderFeatureDossierSvg(d); });
    var inp = document.getElementById('graphFilterInp'); if (inp) { inp.addEventListener('input', function () { state._gfilter = inp.value; renderFeatureDossierSvg(d); var i2 = document.getElementById('graphFilterInp'); if (i2) { i2.focus(); i2.setSelectionRange(i2.value.length, i2.value.length); } }); }
    renderDepthFooter(d);
    var cp = document.getElementById('graphCitationPanel'); if (cp) cp.innerHTML = '';
    camera(host).reset();
  };

  window.renderDepthFooter = function (d) {
    if (!bind()) return;
    var el = document.getElementById('graphDepthFooter'); if (!el) return;
    if (!d || !d.depth) { el.innerHTML = ''; return; }
    var dep = d.depth, capChip = dep.capped ? ' <span class="guard-warn">depth walk capped at 300 nodes — this feature\'s real reach may be larger</span>' : '';
    el.innerHTML = '<div class="mono muted" style="font-size:11.5px;margin:10px 0 0;">' + dep.endpointCount + ' endpoint' + (dep.endpointCount === 1 ? '' : 's') + ' · reaches ' + dep.memberCount + ' nodes across ' + dep.filesTouched + ' files, ' + dep.maxChainLength + ' hops deep</div>' + capChip;
  };
  // Citations for one node from the cached dossier: file:line chips + the FROZEN excerpt. `target`
  // defaults to the panel below the graph; the feature view passes its inspector instead.
  window.showCitationFor = function (nodeId, target) {
    if (!bind()) return;
    var d = state.dossierCache[state.graphView.featureId]; var el = target || document.getElementById('graphCitationPanel'); if (!d || !el) return;
    var cites = (d.citations || []).filter(function (c) { return c.node === nodeId; });
    var body = cites.length ? cites.map(function (c) {
      var text = c.excerpt ? '<pre class="mono" style="background:var(--border2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:11px;overflow-x:auto;margin:0 0 10px;white-space:pre;">' + esc(c.excerpt) + '</pre>' : '<div class="muted" style="font-size:12px;margin:0 0 10px;">no cited excerpt for this node</div>';
      return '<div class="mono chip" style="display:inline-block;margin:4px 6px 6px 0;">' + esc(c.file) + ':' + esc(c.line) + '</div>' + text;
    }).join('') : '<div class="muted" style="font-size:12px;">no cited excerpt for this node</div>';
    el.innerHTML = '<div class="kicker" style="margin:6px 0;">citations</div>' + body;
  };

  window.enterFeatureDossier = function (id) {
    if (!bind()) return;
    if (!state.project) return;
    state.graphView.mode = 'feature'; state.graphView.featureId = id; state._gsel = null; state._gfilter = ''; state._gshowAll = false;
    var backBtn = document.getElementById('graphBackBtn'); if (backBtn) backBtn.style.display = 'inline-block';
    if (typeof selectFeatureById === 'function') { try { selectFeatureById(id); } catch (e) { /* ledger id mismatch is harmless */ } }
    var cached = state.dossierCache[id];
    if (cached) { renderFeatureDossierSvg(cached); return; }
    var host = document.getElementById('kgraph');
    if (host) host.innerHTML = '<div class="muted" style="padding:24px;text-align:center;font-size:12.5px;">Loading feature…</div>';
    get('/api/projects/' + state.project.id + '/features/' + encodeURIComponent(id) + '/context').then(function (d) {
      state.dossierCache[id] = d;
      if (state.graphView.mode === 'feature' && state.graphView.featureId === id) renderFeatureDossierSvg(d);
    }).catch(function () { if (host) host.innerHTML = sfEmpty('Coverage gap: could not load feature context.'); });
  };
  window.exitToOverview = function () {
    if (!bind()) return;
    state.graphView.mode = 'overview'; state.graphView.featureId = null; state._gsel = null;
    var backBtn = document.getElementById('graphBackBtn'); if (backBtn) backBtn.style.display = 'none';
    var cp = document.getElementById('graphCitationPanel'); if (cp) cp.innerHTML = '';
    renderDepthFooter(null);
    renderOverviewSvg();
  };
})();
