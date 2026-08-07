import previous from './index-v1.1.js';
import coreApp from './index.js';
import { runIntegrityMonitor, readIntegritySnapshot } from './integrity-monitor.js';

const SITE_ORIGIN = 'https://oceanliners.net';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/api/integrity-snapshot') {
      if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
      const snapshot = await readIntegritySnapshot(env);
      return json({ ok: true, snapshot });
    }

    if (url.pathname === '/api/integrity-monitor') {
      if (request.method === 'GET') {
        const snapshot = await readIntegritySnapshot(env);
        return json({ ok: true, snapshot });
      }
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
      try {
        const snapshot = await runIntegrityMonitor(coreApp, env, ctx);
        return json({ ok: true, snapshot });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    if (url.pathname === '/api/curator-intelligence') {
      return handleCuratorIntelligence(request, env, ctx);
    }

    return previous.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runIntegrityMonitor(coreApp, env, ctx)
        .catch(error => console.error('Curator Integrity scheduled monitor failed', error))
    );
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
  try {
    payload = await baseResponse.json();
  } catch {
    return callback ? javascript({ ok: false, error: 'Unable to read Integrity intelligence payload.' }, callback) : baseResponse;
  }

  const snapshot = await readIntegritySnapshot(env);
  if (snapshot) payload = enrichWithSnapshot(payload, snapshot, hasBoundedPages);
  else payload = enrichWithoutSnapshot(payload, hasBoundedPages);

  return callback ? javascript(payload, callback) : json(payload, baseResponse.status);
}

function enrichWithSnapshot(payload, snapshot, hasBoundedPages) {
  const criticalCount = Number(snapshot.severityCounts?.critical || 0) + Number(snapshot.severityCounts?.error || 0);
  const warningCount = Number(snapshot.severityCounts?.warning || 0);
  const problemCount = Number(snapshot.problemPageCount || 0);
  const auditedCount = Number(snapshot.auditedPageCount || 0);
  const inventoryCount = Number(snapshot.inventoryCount || 0);
  const pendingCount = Number(snapshot.pendingInitialAuditCount || 0);

  payload.siteSnapshot = snapshot;
  payload.metrics = {
    ...(payload.metrics || {}),
    siteInventoryCount: inventoryCount,
    siteAuditedPageCount: auditedCount,
    sitePendingInitialAuditCount: pendingCount,
    siteProblemPageCount: problemCount,
    siteFindingCount: Number(snapshot.findingCount || 0),
    siteCriticalFindingCount: criticalCount,
    siteWarningFindingCount: warningCount,
  };

  payload.capabilities = {
    ...(payload.capabilities || {}),
    persistentSiteMonitor: true,
    scheduledIncrementalAudit: true,
    snapshotBackedStatus: true,
  };

  const snapshotActivity = {
    title: 'Integrity site monitor updated',
    summary: `${auditedCount}/${inventoryCount || auditedCount} known pages have retained Integrity state; ${problemCount} currently require attention${pendingCount ? ` and ${pendingCount} await their first scheduled audit` : ''}.`,
    meta: `Curator Integrity · site snapshot · ${snapshot.generatedAt || 'current'}`,
  };
  payload.activity = [snapshotActivity, ...(Array.isArray(payload.activity) ? payload.activity : [])].slice(0, 8);

  if (!hasBoundedPages) {
    const status = criticalCount || problemCount ? 'warning' : 'good';
    const statusLabel = criticalCount ? 'Attention' : problemCount ? 'Attention' : pendingCount ? 'Building baseline' : 'Connected';
    const value = criticalCount
      ? `${criticalCount} critical/error finding${criticalCount === 1 ? '' : 's'}`
      : problemCount
        ? `${problemCount} page${problemCount === 1 ? '' : 's'} with findings`
        : pendingCount
          ? `${auditedCount}/${inventoryCount} pages audited`
          : `${auditedCount} pages clean`;

    payload.generatedAt = snapshot.generatedAt || payload.generatedAt;
    payload.system = {
      ...(payload.system || {}),
      id: 'integrity',
      name: 'Curator Integrity',
      status,
      statusLabel,
      value,
      summary: pendingCount
        ? `Persistent site monitoring is active. ${auditedCount} of ${inventoryCount} pages have retained Integrity state; ${problemCount} audited page${problemCount === 1 ? '' : 's'} currently require attention.`
        : `Persistent site monitoring covers ${auditedCount} pages; ${problemCount} currently require attention with ${Number(snapshot.findingCount || 0)} active finding${Number(snapshot.findingCount || 0) === 1 ? '' : 's'}.`,
      detail: `Hourly incremental monitor · latest batch ${snapshot.batch?.size || 0} pages · snapshot ${formatDate(snapshot.generatedAt)}`,
      url: 'https://integrity.oceanliners.net/',
    };

    const sitePriorities = (snapshot.problemPages || []).slice(0, 6).map(row => ({
      title: row.error ? 'Integrity monitor could not audit page' : 'Site-wide Integrity finding requires review',
      summary: row.error
        ? `${row.path} could not be audited: ${row.error}`
        : `${row.path} has ${row.findingCount || 0} active Curator Integrity finding${Number(row.findingCount || 0) === 1 ? '' : 's'} in the retained site snapshot.`,
      entity: row.path,
      severity: normalizeSeverity(row.highestSeverity),
      score: sitePriorityScore(row),
      sources: ['Curator Integrity'],
      siteWide: true,
    }));
    payload.priorities = sitePriorities;
  }

  return payload;
}

function enrichWithoutSnapshot(payload, hasBoundedPages) {
  payload.capabilities = {
    ...(payload.capabilities || {}),
    persistentSiteMonitor: true,
    scheduledIncrementalAudit: true,
    snapshotBackedStatus: false,
  };
  if (!hasBoundedPages) {
    payload.system = {
      ...(payload.system || {}),
      status: 'good',
      statusLabel: 'Building baseline',
      value: 'Monitor initializing',
      summary: 'Persistent Integrity monitoring is configured and waiting for its first scheduled or manual batch.',
      detail: 'CURATOR_INTEGRITY_RECORDS connected · initial snapshot pending',
    };
    payload.activity = [{
      title: 'Integrity site monitor ready',
      summary: 'Persistent storage and scheduled monitoring are configured; the first site snapshot has not been written yet.',
      meta: 'Curator Integrity · site monitor',
    }, ...(Array.isArray(payload.activity) ? payload.activity : [])].slice(0, 8);
  }
  return payload;
}

function sitePriorityScore(row) {
  const severity = String(row.highestSeverity || '').toLowerCase();
  const base = severity === 'critical' || severity === 'error' ? 88 : severity === 'warning' ? 72 : 55;
  return Math.min(100, base + Math.min(10, Number(row.findingCount || 0) * 2));
}
function normalizeSeverity(value) {
  const severity = String(value || '').toLowerCase();
  if (severity === 'critical' || severity === 'error') return 'high';
  if (severity === 'warning') return 'medium';
  return 'low';
}
function formatDate(value) {
  if (!value) return 'pending';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}
function safeCallback(value) { return /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(String(value || '')) ? String(value) : ''; }
function javascript(value, callback) { return new Response(`${callback}(${JSON.stringify(value)});`, { status: 200, headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow, noarchive' } }); }
function corsHeaders() { return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders() } }); }
