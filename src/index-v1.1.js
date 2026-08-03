import app from "./index.js";

const SITE_ORIGIN = "https://oceanliners.net";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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

    // Do not mutate dashboard HTML/JavaScript at runtime. The v1 dashboard is
    // known-good in browsers; calibration is applied server-side through
    // normalized /api/page responses and normalized crawl links.
    return response;
  }
};

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

function json(data, status, inheritedHeaders) {
  const headers = new Headers(inheritedHeaders || {});
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}
