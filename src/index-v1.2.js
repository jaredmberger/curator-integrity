import previous from './index-v1.1.js';
import coreApp from './index.js';
import { runIntegrityMonitor, readIntegritySnapshot } from './integrity-monitor.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) return new Response(null, { status: 204, headers: corsHeaders() });
    if (url.pathname === '/api/integrity-snapshot') {
      if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
      return json({ ok: true, snapshot: await readIntegritySnapshot(env) });
    }
    if (url.pathname === '/api/integrity-monitor') {
      if (request.method === 'GET') return json({ ok: true, snapshot: await readIntegritySnapshot(env) });
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
      try { return json({ ok: true, snapshot: await runIntegrityMonitor(coreApp, env, ctx) }); }
      catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500); }
    }
    if (url.pathname === '/api/curator-intelligence') return handleCuratorIntelligence(request, env, ctx);
    return previous.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runIntegrityMonitor(coreApp, env, ctx).catch(error => console.error('Curator Integrity scheduled monitor failed', error)));
  }
};

async function handleCuratorIntelligence(request, env, ctx) {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
  const incoming = new URL(request.url);
  const callback = safeCallback(incoming.searchParams.get('callback'));
  const hasBoundedPages = incoming.searchParams.getAll('page').length > 0;
  incoming.searchParams.delete('callback');
  const baseResponse = await previous.fetch(new Request(incoming.href, { method: 'GET' }), env, ctx);
  let payload;
  try { payload = await baseResponse.json(); }
  catch { return callback ? javascript({ ok: false, error: 'Unable to read Integrity intelligence payload.' }, callback) : baseResponse; }
  const snapshot = await readIntegritySnapshot(env);
  payload = snapshot ? enrichWithSnapshot(payload, snapshot, hasBoundedPages) : enrichWithoutSnapshot(payload, hasBoundedPages);
  return callback ? javascript(payload, callback) : json(payload, baseResponse.status);
}

function enrichWithSnapshot(payload, snapshot, hasBoundedPages) {
  const criticalCount = Number(snapshot.severityCounts?.critical || 0) + Number(snapshot.severityCounts?.error || 0);
  const warningCount = Number(snapshot.severityCounts?.warning || 0);
  const problemCount = Number(snapshot.problemPageCount || 0);
  const auditedCount = Number(snapshot.auditedPageCount || 0);
  const inventoryCount = Number(snapshot.inventoryCount || 0);
  const pendingCount = Number(snapshot.pendingInitialAuditCount || 0);
  const changes = snapshot.changes || { total: 0, counts: {}, items: [] };
  const regressions = (changes.items || []).filter(x => ['new','regressed'].includes(x.type));
  const recoveries = (changes.items || []).filter(x => ['resolved','improved'].includes(x.type));

  payload.siteSnapshot = snapshot;
  payload.metrics = {
    ...(payload.metrics || {}), siteInventoryCount: inventoryCount, siteAuditedPageCount: auditedCount,
    sitePendingInitialAuditCount: pendingCount, siteProblemPageCount: problemCount, siteFindingCount: Number(snapshot.findingCount || 0),
    siteCriticalFindingCount: criticalCount, siteWarningFindingCount: warningCount,
    siteChangeCount: Number(changes.total || 0), siteRegressionCount: regressions.length, siteRecoveryCount: recoveries.length,
  };
  payload.capabilities = { ...(payload.capabilities || {}), persistentSiteMonitor: true, scheduledIncrementalAudit: true, snapshotBackedStatus: true, changeDetection: true };

  const activity = [{
    title: changes.total ? 'Integrity change detection completed' : 'Integrity site monitor updated',
    summary: changes.total
      ? `${changes.total} change${changes.total === 1 ? '' : 's'} detected in the latest audited batch: ${regressions.length} new/regressed and ${recoveries.length} resolved/improved.`
      : `${auditedCount}/${inventoryCount || auditedCount} known pages have retained Integrity state; no material changes were detected in the latest batch.`,
    meta: `Curator Integrity · Change Detection v1 · ${snapshot.generatedAt || 'current'}`,
  }];
  activity.push(...recoveries.slice(0, 3).map(item => ({ title: item.title, summary: `${item.path}: ${item.summary}`, meta: 'Curator Integrity · resolved/improved' })));
  payload.activity = [...activity, ...(Array.isArray(payload.activity) ? payload.activity : [])].slice(0, 8);

  if (!hasBoundedPages) {
    payload.generatedAt = snapshot.generatedAt || payload.generatedAt;
    payload.system = {
      ...(payload.system || {}), id: 'integrity', name: 'Curator Integrity',
      status: criticalCount || problemCount || regressions.length ? 'warning' : 'good',
      statusLabel: criticalCount || problemCount || regressions.length ? 'Attention' : pendingCount ? 'Building baseline' : 'Connected',
      value: regressions.length ? `${regressions.length} new/regressed` : criticalCount ? `${criticalCount} critical/error finding${criticalCount === 1 ? '' : 's'}` : problemCount ? `${problemCount} page${problemCount === 1 ? '' : 's'} with findings` : pendingCount ? `${auditedCount}/${inventoryCount} pages audited` : `${auditedCount} pages clean`,
      summary: pendingCount
        ? `Persistent site monitoring is active. ${auditedCount} of ${inventoryCount} pages have retained Integrity state; ${problemCount} audited page${problemCount === 1 ? '' : 's'} currently require attention.`
        : `Persistent monitoring covers ${auditedCount} pages; ${problemCount} currently require attention. Latest batch: ${regressions.length} new/regressed and ${recoveries.length} resolved/improved change${regressions.length + recoveries.length === 1 ? '' : 's'}.`,
      detail: `Hourly incremental monitor · latest batch ${snapshot.batch?.size || 0} pages · Change Detection v1`,
      url: 'https://integrity.oceanliners.net/'
    };

    const changePriorities = regressions.slice(0, 6).map((item, index) => ({
      title: item.title,
      summary: `${item.path}: ${item.summary}`,
      entity: item.path,
      severity: normalizeSeverity(item.severity || (item.type === 'regressed' ? 'warning' : 'notice')),
      score: Math.max(65, 94 - index * 3),
      sources: ['Curator Integrity'], changeDetected: true,
    }));
    const sitePriorities = (snapshot.problemPages || []).slice(0, 6).map(row => ({
      title: row.error ? 'Integrity monitor could not audit page' : 'Site-wide Integrity finding requires review',
      summary: row.error ? `${row.path} could not be audited: ${row.error}` : `${row.path} has ${row.findingCount || 0} active Curator Integrity finding${Number(row.findingCount || 0) === 1 ? '' : 's'} in the retained site snapshot.`,
      entity: row.path, severity: normalizeSeverity(row.highestSeverity), score: sitePriorityScore(row), sources: ['Curator Integrity'], siteWide: true,
    }));
    payload.priorities = uniquePriorities([...changePriorities, ...sitePriorities]).slice(0, 8);
  }
  return payload;
}

function enrichWithoutSnapshot(payload, hasBoundedPages) {
  payload.capabilities = { ...(payload.capabilities || {}), persistentSiteMonitor: true, scheduledIncrementalAudit: true, snapshotBackedStatus: false, changeDetection: true };
  if (!hasBoundedPages) {
    payload.system = { ...(payload.system || {}), status: 'good', statusLabel: 'Building baseline', value: 'Monitor initializing', summary: 'Persistent Integrity monitoring is configured and waiting for its first scheduled or manual batch.', detail: 'CURATOR_INTEGRITY_RECORDS connected · initial snapshot pending' };
  }
  return payload;
}
function uniquePriorities(items) { const seen = new Set(); return items.filter(item => { const key = `${item.title}|${item.entity}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function sitePriorityScore(row) { const severity = String(row.highestSeverity || '').toLowerCase(); const base = severity === 'critical' || severity === 'error' ? 88 : severity === 'warning' ? 72 : 55; return Math.min(100, base + Math.min(10, Number(row.findingCount || 0) * 2)); }
function normalizeSeverity(value) { const severity = String(value || '').toLowerCase(); if (severity === 'critical' || severity === 'error') return 'high'; if (severity === 'warning') return 'medium'; return 'low'; }
function safeCallback(value) { return /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(String(value || '')) ? String(value) : ''; }
function javascript(value, callback) { return new Response(`${callback}(${JSON.stringify(value)});`, { status: 200, headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow, noarchive' } }); }
function corsHeaders() { return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders() } }); }
