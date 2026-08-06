import app from "./index.js";

const SITE_ORIGIN = "https://oceanliners.net";
const MAX_INTELLIGENCE_PAGES = 10;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/api/curator-intelligence") {
      return handleCuratorIntelligence(request, env, ctx);
    }

    const response = await app.fetch(request, env, ctx);

    if (url.pathname === "/api/health" && response.ok) {
      const data = await response.json();
      return json({ ...data, version: "1.1.1", calibration: true, dashboardHotfix: true }, response.status, response.headers);
    }

    if (url.pathname === "/api/page" && response.ok) {
      const data = await response.json();
      const finalUrl = logicalUrl(data.finalUrl || data.url || SITE_ORIGIN);
      const requestedUrl = logicalUrl(data.url || finalUrl);
      const canonicals = Array.isArray(data.snapshot?.canonicals) ? data.snapshot.canonicals : [];
      const expected = logicalUrl(finalUrl);
      const canonicalEquivalent = canonicals.length === 1 && logicalUrl(canonicals[0]) === expected;

      const findings = dedupeFindings((data.findings || []).filter(f => {
        if (f.rule !== "link.canonical") return true;
        if (canonicals.length !== 1) return true;
        return !canonicalEquivalent;
      }));

      const links = [...new Set((data.links || []).map(logicalUrl).filter(Boolean))];

      return json({
        ...data,
        url: requestedUrl,
        finalUrl,
        snapshot: {
          ...data.snapshot,
          canonicals: canonicals.map(logicalUrl),
          expectedCanonical: expected
        },
        findings,
        links
      }, response.status, response.headers);
    }

    return response;
  }
};

async function handleCuratorIntelligence(request, env, ctx) {
  if (request.method !== "GET") return json({ ok: false, error: "Method not allowed." }, 405);
  const url = new URL(request.url);
  const pages = [...new Set(url.searchParams.getAll("page").map(logicalUrl).filter(isSitePage))].slice(0, MAX_INTELLIGENCE_PAGES);
  const results = [];

  for (const page of pages) {
    const internal = new URL("/api/page", request.url);
    internal.searchParams.set("url", page);
    try {
      const response = await app.fetch(new Request(internal.href, { method: "GET" }), env, ctx);
      const data = await response.json();
      if (!response.ok || data?.error) {
        results.push({ path: toPath(page), ok: false, findings: [], error: data?.error || `HTTP ${response.status}` });
        continue;
      }
      const finalUrl = logicalUrl(data.finalUrl || data.url || page);
      const rawFindings = dedupeFindings(data.findings || []);
      const activeFindings = rawFindings.filter(f => !f.excepted);
      results.push({
        path: toPath(finalUrl),
        url: finalUrl,
        classification: data.classification || "general",
        ok: activeFindings.length === 0,
        findingCount: activeFindings.length,
        findings: activeFindings.map(f => ({
          rule: f.rule,
          category: f.category,
          severity: f.severity,
          label: f.label,
          detail: f.detail,
        })),
      });
    } catch (error) {
      results.push({ path: toPath(page), ok: false, findings: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  const problemPages = results.filter(row => !row.ok);
  const findingCount = results.reduce((sum, row) => sum + Number(row.findingCount || 0), 0);
  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    system: {
      id: "integrity",
      name: "Curator Integrity",
      status: problemPages.length ? "warning" : "good",
      statusLabel: pages.length ? (problemPages.length ? "Attention" : "Connected") : "Connected",
      value: pages.length ? `${findingCount} finding${findingCount === 1 ? "" : "s"}` : "Live",
      summary: pages.length
        ? `${pages.length} search-signaled page${pages.length === 1 ? "" : "s"} checked against Curator Integrity standards; ${problemPages.length} require attention.`
        : "Curator Integrity is online and available for bounded page-level standards checks.",
      detail: pages.length ? `Bounded intelligence batch · ${pages.length}/${MAX_INTELLIGENCE_PAGES} pages` : "No full-site scan on dashboard read",
      url: "https://integrity.oceanliners.net/",
    },
    metrics: { checkedPageCount: pages.length, problemPageCount: problemPages.length, findingCount },
    pages: results,
    priorities: problemPages.slice(0, 6).map(row => ({
      title: "Integrity standards issue on search-signaled page",
      summary: `${row.path} has ${row.findingCount || 0} active Curator Integrity finding${Number(row.findingCount || 0) === 1 ? "" : "s"}.`,
      entity: row.path,
      severity: highestSeverity(row.findings),
      score: integrityScore(row.findings),
      sources: ["Curator Integrity"],
    })),
    opportunities: [],
    activity: pages.length ? [{
      title: "Integrity checks completed for active search pages",
      summary: `${pages.length} page${pages.length === 1 ? " was" : "s were"} checked without initiating a full-site crawl.`,
      meta: "Curator Integrity · bounded intelligence batch",
    }] : [],
    capabilities: { boundedPageChecks: true, fullSiteScanOnRead: false, maxPagesPerRead: MAX_INTELLIGENCE_PAGES },
  };

  const callback = safeCallback(url.searchParams.get("callback"));
  return callback ? javascript(payload, callback) : json(payload);
}

function highestSeverity(findings = []) {
  const rank = { error: 4, critical: 4, warning: 3, notice: 2, info: 1 };
  return [...findings].sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0))[0]?.severity === "error" ? "high" : ([...findings].some(f => f.severity === "warning") ? "medium" : "low");
}
function integrityScore(findings = []) { return Math.min(100, findings.reduce((sum, f) => sum + (f.severity === "error" ? 28 : f.severity === "warning" ? 18 : 8), 40)); }
function isSitePage(value) { try { return new URL(value).hostname.replace(/^www\./i, "") === "oceanliners.net"; } catch { return false; } }
function toPath(value) { try { return new URL(value).pathname || "/"; } catch { return String(value || ""); } }
function safeCallback(value) { return /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(String(value || "")) ? String(value) : ""; }
function javascript(value, callback) { return new Response(`${callback}(${JSON.stringify(value)});`, { status: 200, headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow, noarchive" } }); }
function corsHeaders() { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type" }; }

function logicalUrl(value) {
  try {
    const u = new URL(value, SITE_ORIGIN);
    u.protocol = "https:";
    u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
    u.hash = "";
    u.search = "";
    let path = u.pathname || "/";
    path = path.replace(/\/index\.html$/i, "/");
    path = path.replace(/\.html$/i, "");
    if (path !== "/") path = path.replace(/\/+$/, "");
    u.pathname = path || "/";
    return u.href;
  } catch {
    return String(value || "");
  }
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter(f => {
    const key = [f.rule, f.severity, f.category, f.detail, f.excepted ? "1" : "0"].join("\n");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function json(data, status = 200, inheritedHeaders) {
  const headers = new Headers(inheritedHeaders || {});
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("cache-control", "no-store");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(JSON.stringify(data), { status, headers });
}
