const SITE_ORIGIN = 'https://oceanliners.net';
const SITEMAP_URL = `${SITE_ORIGIN}/sitemap.xml`;
const STATE_KEY = 'integrity:state:v1';
const LATEST_KEY = 'integrity:latest:v1';
const HISTORY_PREFIX = 'integrity:snapshot:';
const BATCH_SIZE = 30;
const CONCURRENCY = 5;
const HISTORY_LIMIT = 45;

export async function runIntegrityMonitor(app, env, ctx) {
  if (!env.CURATOR_INTEGRITY_RECORDS) throw new Error('CURATOR_INTEGRITY_RECORDS KV binding is not configured.');

  const inventory = await discoverSitePages();
  if (!inventory.length) throw new Error('No site pages were discovered from the sitemap.');

  const previousState = await env.CURATOR_INTEGRITY_RECORDS.get(STATE_KEY, 'json') || {};
  const previousPages = previousState.pages && typeof previousState.pages === 'object' ? previousState.pages : {};
  const cursor = Math.max(0, Number(previousState.cursor || 0)) % inventory.length;
  const batch = rotatingBatch(inventory, cursor, Math.min(BATCH_SIZE, inventory.length));
  const audited = await auditPages(app, env, ctx, batch);

  const pages = { ...previousPages };
  const now = new Date().toISOString();
  for (const row of audited) pages[row.path] = row;

  const inventorySet = new Set(inventory.map(toPath));
  for (const path of Object.keys(pages)) if (!inventorySet.has(path)) delete pages[path];

  const nextCursor = (cursor + batch.length) % inventory.length;
  const cycleCompleted = nextCursor <= cursor || inventory.length <= batch.length;
  const snapshot = summarizeSnapshot({ inventory, pages, audited, now, cursor: nextCursor, cycleCompleted });
  const nextState = { version: 1, inventoryCount: inventory.length, cursor: nextCursor, updatedAt: now, pages };

  await env.CURATOR_INTEGRITY_RECORDS.put(STATE_KEY, JSON.stringify(nextState));
  await env.CURATOR_INTEGRITY_RECORDS.put(LATEST_KEY, JSON.stringify(snapshot));
  await env.CURATOR_INTEGRITY_RECORDS.put(`${HISTORY_PREFIX}${now}`, JSON.stringify(snapshot), { expirationTtl: 60 * 60 * 24 * 60 });
  await pruneHistory(env);

  return snapshot;
}

export async function readIntegritySnapshot(env) {
  if (!env.CURATOR_INTEGRITY_RECORDS) return null;
  return env.CURATOR_INTEGRITY_RECORDS.get(LATEST_KEY, 'json');
}

async function discoverSitePages() {
  const seenSitemaps = new Set();
  const pages = new Set();
  const queue = [SITEMAP_URL];

  while (queue.length && seenSitemaps.size < 20) {
    const sitemap = queue.shift();
    if (!sitemap || seenSitemaps.has(sitemap)) continue;
    seenSitemaps.add(sitemap);
    let response;
    try {
      response = await fetch(sitemap, { headers: { accept: 'application/xml,text/xml,*/*', 'user-agent': 'Curator-Integrity-Monitor/1.0' } });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    const xml = await response.text();
    for (const loc of [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(match => decodeXml(match[1]))) {
      try {
        const url = new URL(loc, SITE_ORIGIN);
        if (url.hostname.replace(/^www\./i, '') !== 'oceanliners.net') continue;
        url.hash = '';
        url.search = '';
        if (/\.xml$/i.test(url.pathname)) {
          if (!seenSitemaps.has(url.href)) queue.push(url.href);
          continue;
        }
        if (/\.(?:jpg|jpeg|png|webp|gif|svg|pdf|json|js|css|zip)$/i.test(url.pathname)) continue;
        pages.add(logicalUrl(url.href));
      } catch {}
    }
  }
  return [...pages].sort();
}

function rotatingBatch(items, start, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(items[(start + i) % items.length]);
  return out;
}

async function auditPages(app, env, ctx, pages) {
  const results = new Array(pages.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index++;
      if (current >= pages.length) return;
      const page = pages[current];
      results[current] = await auditPage(app, env, ctx, page);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker));
  return results.filter(Boolean);
}

async function auditPage(app, env, ctx, page) {
  const internal = new URL('/api/page', 'https://integrity.oceanliners.net');
  internal.searchParams.set('url', page);
  const checkedAt = new Date().toISOString();
  try {
    const response = await app.fetch(new Request(internal.href, { method: 'GET' }), env, ctx);
    const data = await response.json();
    if (!response.ok || data?.error) {
      return { path: toPath(page), url: page, ok: false, checkedAt, findingCount: 0, findings: [], error: data?.error || `HTTP ${response.status}` };
    }
    const findings = Array.isArray(data.findings) ? data.findings.filter(f => !f.excepted) : [];
    return {
      path: toPath(data.finalUrl || data.url || page),
      url: logicalUrl(data.finalUrl || data.url || page),
      classification: data.classification || 'general',
      ok: findings.length === 0,
      checkedAt,
      findingCount: findings.length,
      findings: findings.map(f => ({ rule: f.rule, category: f.category, severity: f.severity, label: f.label, detail: f.detail })),
      error: null,
    };
  } catch (error) {
    return { path: toPath(page), url: page, ok: false, checkedAt, findingCount: 0, findings: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeSnapshot({ inventory, pages, audited, now, cursor, cycleCompleted }) {
  const rows = inventory.map(url => pages[toPath(url)]).filter(Boolean);
  const stale = inventory.length - rows.length;
  const problemPages = rows.filter(row => !row.ok);
  const findingCount = rows.reduce((sum, row) => sum + Number(row.findingCount || 0), 0);
  const severityCounts = { critical: 0, error: 0, warning: 0, notice: 0, info: 0 };
  const ruleCounts = {};
  for (const row of rows) for (const finding of row.findings || []) {
    const severity = String(finding.severity || 'info').toLowerCase();
    severityCounts[severity] = (severityCounts[severity] || 0) + 1;
    ruleCounts[finding.rule || 'unknown'] = (ruleCounts[finding.rule || 'unknown'] || 0) + 1;
  }
  const freshness = rows.map(row => Date.parse(row.checkedAt)).filter(Number.isFinite);
  const oldestCheckedAt = freshness.length ? new Date(Math.min(...freshness)).toISOString() : null;
  const newestCheckedAt = freshness.length ? new Date(Math.max(...freshness)).toISOString() : null;

  return {
    ok: true,
    generatedAt: now,
    mode: 'incremental-site-monitor',
    inventoryCount: inventory.length,
    auditedPageCount: rows.length,
    pendingInitialAuditCount: stale,
    problemPageCount: problemPages.length,
    cleanPageCount: Math.max(0, rows.length - problemPages.length),
    findingCount,
    severityCounts,
    ruleCounts,
    batch: { size: audited.length, nextCursor: cursor, cycleCompleted },
    freshness: { oldestCheckedAt, newestCheckedAt },
    problemPages: problemPages
      .map(row => ({ path: row.path, findingCount: row.findingCount || 0, highestSeverity: highestSeverity(row.findings), checkedAt: row.checkedAt, error: row.error || null }))
      .sort((a, b) => severityRank(b.highestSeverity) - severityRank(a.highestSeverity) || Number(b.findingCount || 0) - Number(a.findingCount || 0))
      .slice(0, 25),
  };
}

async function pruneHistory(env) {
  const listed = await env.CURATOR_INTEGRITY_RECORDS.list({ prefix: HISTORY_PREFIX, limit: 1000 });
  const keys = listed.keys.map(key => key.name).sort().reverse();
  await Promise.all(keys.slice(HISTORY_LIMIT).map(key => env.CURATOR_INTEGRITY_RECORDS.delete(key)));
}

function highestSeverity(findings = []) {
  return [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0]?.severity || 'info';
}
function severityRank(value) { return ({ critical: 5, error: 5, warning: 4, notice: 3, info: 2 })[String(value || '').toLowerCase()] || 1; }
function decodeXml(value) { return String(value || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function logicalUrl(value) {
  try {
    const url = new URL(value, SITE_ORIGIN);
    url.protocol = 'https:';
    url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    url.hash = '';
    url.search = '';
    let path = url.pathname || '/';
    path = path.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '');
    if (path.length > 1) path = path.replace(/\/+$/, '');
    url.pathname = path || '/';
    return url.href;
  } catch { return String(value || ''); }
}
function toPath(value) { try { return new URL(logicalUrl(value)).pathname || '/'; } catch { return String(value || ''); } }
