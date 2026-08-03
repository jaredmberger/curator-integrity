import app from "./index.js";

const SITE_ORIGIN = "https://oceanliners.net";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await app.fetch(request, env, ctx);

    if (url.pathname === "/api/health" && response.ok) {
      const data = await response.json();
      return json({ ...data, version: "1.1.0", calibration: true }, response.status, response.headers);
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

    if (url.pathname === "/" && response.ok && (response.headers.get("content-type") || "").includes("text/html")) {
      let html = await response.text();
      html = html
        .replace("Curator Integrity v1 · Read-only standards audit", "Curator Integrity v1.1 · Calibrated read-only standards audit")
        .replace("state.queue.push(start);", "state.queue.push(norm(start));")
        .replace("p.findings.forEach(f=>state.findings.push({...f,page_url:p.finalUrl,family:p.classification}));", "p.findings.forEach(f=>pushFinding({...f,page_url:norm(p.finalUrl),family:p.classification}));")
        .replace("state.findings.push({page_url:url,family:'unknown',rule:'page.fetch'", "pushFinding({page_url:norm(url),family:'unknown',rule:'page.fetch'")
        .replace("excepted:false})}update();await tick()", "excepted:false})}update();await tick()")
        .replace("function crossPageChecks(){", "function pushFinding(f){const k=[norm(f.page_url||''),f.rule||'',f.severity||'',f.detail||'',f.excepted?'1':'0'].join('\\n');if(!state._findingKeys)state._findingKeys=new Set();if(state._findingKeys.has(k))return;state._findingKeys.add(k);state.findings.push(f)}\nfunction crossPageChecks(){")
        .replace("state.findings=[];$('run').disabled", "state.findings=[];state._findingKeys=new Set();$('run').disabled")
        .replaceAll("state.findings.push({page_url:p.finalUrl", "pushFinding({page_url:norm(p.finalUrl)")
        .replaceAll("excepted:false}))}", "excepted:false})}")
        .replace(/function norm\(u\)\{[^}]+\}/, `function norm(u){try{return logical(u)}catch{return String(u||'')}}\nfunction logical(value){const u=new URL(value,'${SITE_ORIGIN}');u.protocol='https:';u.hostname=u.hostname.replace(/^www\\./i,'').toLowerCase();u.hash='';u.search='';let p=u.pathname||'/';p=p.replace(/\\/index\\.html$/i,'/');p=p.replace(/\\.html$/i,'');if(p!=='/')p=p.replace(/\\/+$/,'');u.pathname=p||'/';return u.href}`);

      return new Response(html, { status: response.status, headers: response.headers });
    }

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
