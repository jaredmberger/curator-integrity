import globalStandards from "../standards/global.json";
import exceptionsConfig from "../standards/exceptions.json";

const SITE_ORIGIN = "https://oceanliners.net";
const USER_AGENT = "OceanLiners-Curator-Integrity/1.0 (+https://oceanliners.net/)";
const MAX_PAGE_BYTES = 2_000_000;
const DEFAULT_LIMIT = 500;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
      if (url.pathname === "/api/config") return json({ origin: SITE_ORIGIN, rules: globalStandards.rules, exceptions: exceptionsConfig.exceptions });
      if (url.pathname === "/api/page") return await inspectPage(url);
      if (url.pathname === "/api/health") return json({ ok: true, service: "curator-integrity", version: "1.0.0" });
      if (url.pathname !== "/") return new Response("Not found", { status: 404 });
      return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=UTF-8", ...securityHeaders() } });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
};

async function inspectPage(requestUrl) {
  const target = requestUrl.searchParams.get("url") || "";
  let page;
  try { page = new URL(target); } catch { return json({ error: "Invalid page URL." }, 400); }
  if (page.origin !== SITE_ORIGIN) return json({ error: `Pages must be under ${SITE_ORIGIN}.` }, 400);

  const response = await fetch(page.href, {
    redirect: "follow",
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" }
  });
  if (!response.ok) return json({ error: `Page returned HTTP ${response.status}.`, status: response.status }, 502);
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return json({ error: `Expected HTML but received ${type || "unknown content type"}.` }, 415);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_PAGE_BYTES) return json({ error: "Page exceeds integrity scan size limit." }, 413);
  const html = await response.text();
  if (html.length > MAX_PAGE_BYTES) return json({ error: "Page exceeds integrity scan size limit." }, 413);

  const finalUrl = response.url || page.href;
  const classification = classifyPage(finalUrl, html);
  const snapshot = analyzeHtml(html, finalUrl, classification);
  const findings = evaluateRules(snapshot);
  const exceptions = exceptionsFor(finalUrl, findings);
  const exceptionKeys = new Set(exceptions.map(x => x.rule));

  return json({
    url: page.href,
    finalUrl,
    classification,
    snapshot,
    findings: findings.map(f => exceptionKeys.has(f.rule) ? { ...f, excepted: true, exception: exceptions.find(x => x.rule === f.rule)?.reason || "Accepted exception" } : f),
    links: extractInternalLinks(html, finalUrl)
  });
}

function analyzeHtml(html, finalUrl, classification) {
  const titleMatches = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)];
  const titles = titleMatches.map(m => textOnly(m[1]).trim()).filter(Boolean);
  const description = metaContent(html, "description");
  const viewport = metaContent(html, "viewport");
  const htmlLang = (html.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i)?.[1] || "").trim();
  const canonicals = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*>/gi)].map(m => attr(m[0], "href")).filter(Boolean);
  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => textOnly(m[1]).trim());
  const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const idCounts = ids.reduce((a, id) => (a[id] = (a[id] || 0) + 1, a), {});
  const duplicateIds = Object.entries(idCounts).filter(([, n]) => n > 1).map(([id, count]) => ({ id, count }));
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => ({ src: attr(m[0], "src"), hasAlt: /\balt\s*=/i.test(m[0]), alt: attr(m[0], "alt") }));
  const jsonLdBlocks = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].trim());
  const jsonLdErrors = [];
  jsonLdBlocks.forEach((block, index) => { try { JSON.parse(block); } catch (e) { jsonLdErrors.push({ index: index + 1, error: e.message }); } });
  return {
    classification,
    title: titles[0] || "",
    titleCount: titleMatches.length,
    description,
    viewport,
    htmlLang,
    canonicals,
    h1s,
    duplicateIds,
    images: { count: images.length, missingSrc: images.filter(x => !x.src).length, missingAlt: images.filter(x => !x.hasAlt).length },
    jsonLd: { count: jsonLdBlocks.length, errors: jsonLdErrors },
    expectedCanonical: normalizeCanonical(finalUrl)
  };
}

function evaluateRules(s) {
  const f = [];
  add(!s.htmlLang, "html.lang", "HTML element does not declare a language.");
  add(s.titleCount !== 1 || !s.title, "head.title", s.titleCount === 0 ? "Document has no title element." : `Expected one non-empty title; found ${s.titleCount}.`);
  add(!s.description, "meta.description", "Meta description is missing or empty.");
  add(!s.viewport, "meta.viewport", "Viewport metadata is missing.");
  add(s.canonicals.length !== 1, "link.canonical", `Expected exactly one canonical; found ${s.canonicals.length}.`);
  if (s.canonicals.length === 1 && normalizeCanonical(s.canonicals[0]) !== s.expectedCanonical) add(true, "link.canonical", `Canonical points to ${s.canonicals[0]} instead of ${s.expectedCanonical}.`);
  add(s.h1s.length !== 1, "heading.h1", `Expected exactly one H1; found ${s.h1s.length}.`);
  add(s.duplicateIds.length > 0, "ids.duplicate", `${s.duplicateIds.length} duplicate ID value${s.duplicateIds.length === 1 ? "" : "s"} found: ${s.duplicateIds.slice(0, 6).map(x => `${x.id} (${x.count})`).join(", ")}.`);
  add(s.jsonLd.errors.length > 0, "schema.jsonld", `${s.jsonLd.errors.length} JSON-LD block${s.jsonLd.errors.length === 1 ? "" : "s"} could not be parsed.`);
  add(s.images.missingAlt > 0, "image.alt", `${s.images.missingAlt} image${s.images.missingAlt === 1 ? "" : "s"} lack an alt attribute.`);
  add(s.images.missingSrc > 0, "image.src", `${s.images.missingSrc} image${s.images.missingSrc === 1 ? "" : "s"} lack a source path.`);
  return f;

  function add(condition, ruleId, detail) {
    if (!condition) return;
    const rule = globalStandards.rules.find(r => r.id === ruleId);
    if (rule) f.push({ rule: rule.id, category: rule.category, severity: rule.severity, label: rule.label, detail });
  }
}

function exceptionsFor(url, findings) {
  const normalized = normalizeCanonical(url);
  const present = new Set(findings.map(f => f.rule));
  return exceptionsConfig.exceptions.filter(x => normalizeCanonical(x.page) === normalized && present.has(x.rule));
}

function classifyPage(url, html) {
  const path = new URL(url).pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "homepage";
  if (/^\/ships\/[^/]+$/i.test(path) && path !== "/ships/ships") return "ship-guide";
  if (path === "/ships/ships") return "ship-archive";
  if (/\/reference-objects\//i.test(path)) return "reference-object";
  if (/\bquick answer\b|\bwhy .* matters\b/i.test(textOnly(html.slice(0, 12000)))) return "quick-answer";
  if (/\bhub\b/i.test((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""))) return "hub";
  if (/<article\b/i.test(html)) return "article";
  return "general";
}

function extractInternalLinks(html, baseUrl) {
  const searchable = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");
  const links = new Set();
  for (const m of searchable.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(raw)) continue;
    try {
      const u = new URL(raw, baseUrl);
      if (u.origin !== SITE_ORIGIN) continue;
      u.hash = "";
      if (/\.(?:jpg|jpeg|png|webp|gif|svg|pdf|xml|json|js|css|zip)$/i.test(u.pathname)) continue;
      links.add(u.href);
    } catch {}
  }
  return [...links];
}

function metaContent(html, name) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if ((attr(m[0], "name") || "").toLowerCase() === name.toLowerCase()) return attr(m[0], "content").trim();
  }
  return "";
}
function attr(tag, name) { return (tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] || "").trim(); }
function textOnly(value) { return String(value).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " "); }
function normalizeCanonical(value) { try { const u = new URL(value, SITE_ORIGIN); u.hash = ""; u.search = ""; u.pathname = u.pathname === "/" ? "/" : u.pathname.replace(/\/+$/, ""); return u.href; } catch { return String(value); } }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store", ...corsHeaders(), ...securityHeaders() } }); }
function corsHeaders() { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type" }; }
function securityHeaders() { return { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'" }; }

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Curator Integrity</title>
<style>
:root{color-scheme:dark;--bg:#07100e;--panel:#101a17;--line:#34433d;--text:#f3efe6;--muted:#b7beb8;--brass:#bfa46a;--error:#ef9c96;--warning:#e5c675;--notice:#9fc4dd;--info:#a9b9ae;--good:#9ad0a6}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#172721 0,#07100e 48%);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1500px;margin:auto;padding:26px}.suitebar{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:#0c1613}.suitebrand{font-family:Georgia,serif;color:var(--brass);font-size:1.1rem}.suitenav{display:flex;gap:8px;flex-wrap:wrap}.suitenav a{color:var(--text);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:7px 11px}.mast,.card,.tablewrap{border:1px solid var(--line);background:rgba(12,22,19,.94);border-radius:16px}.mast{padding:24px}.eyebrow{text-transform:uppercase;letter-spacing:.14em;color:var(--brass);font-size:.78rem}h1{font:500 clamp(2rem,5vw,3.8rem)/1.05 Georgia,serif;margin:.3rem 0}.muted,.small{color:var(--muted)}.small{font-size:.84rem}.controls{display:grid;grid-template-columns:2fr 1fr auto;gap:10px;margin-top:18px}input,select,button{width:100%;padding:11px;border-radius:9px;border:1px solid var(--line);background:#08110f;color:var(--text)}button{cursor:pointer;background:linear-gradient(#c7ad73,#a98e56);color:#10110f;font-weight:800;border-color:#dbc38e}button.secondary{background:#17231f;color:var(--text)}button:disabled{opacity:.5}.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:16px 0}.card{padding:14px}.stat strong{display:block;font-size:1.7rem;color:var(--brass)}.bar{height:10px;border:1px solid var(--line);border-radius:999px;overflow:hidden;background:#07100e}.bar span{display:block;height:100%;background:var(--brass);width:0}.filters{display:grid;grid-template-columns:2fr repeat(3,1fr) auto;gap:10px;margin:14px 0}.tablewrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:1250px}th,td{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid #293630}th{position:sticky;top:0;background:#17231f;color:var(--brass);text-transform:uppercase;font-size:.76rem;letter-spacing:.05em}.pill{display:inline-block;border:1px solid;border-radius:999px;padding:2px 8px;white-space:nowrap}.error{color:var(--error)}.warning{color:var(--warning)}.notice{color:var(--notice)}.info{color:var(--info)}.excepted{opacity:.62;text-decoration:line-through}.score{font-size:2rem;color:var(--good);font-family:Georgia,serif}.status{min-height:24px;margin:10px 0}.footer{text-align:center;color:var(--muted);padding:18px}@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}.controls,.filters{grid-template-columns:1fr 1fr}}@media(max-width:560px){.wrap{padding:12px}.suitebar{align-items:flex-start;flex-direction:column}.stats,.controls,.filters{grid-template-columns:1fr 1fr}}
</style></head><body><main class="wrap">
<div class="suitebar"><div class="suitebrand">CuratorOS · Integrity</div><nav class="suitenav"><a href="https://curator.oceanliners.net/">CuratorOS</a><a href="https://site-health.oceanliners.net/">Site Health</a><a href="https://oceanliners.net/">OceanLiners.net</a></nav></div>
<section class="mast"><div class="eyebrow">Standards & consistency auditor</div><h1>Curator Integrity</h1><p>Audit OceanLiners.net against configurable structural, metadata, accessibility, asset, and structured-data standards. Intentional exceptions remain visible but do not count against the integrity score.</p><div class="controls"><input id="start" value="https://oceanliners.net/" aria-label="Starting URL"><select id="limit"><option value="100">100 pages</option><option value="250">250 pages</option><option value="500" selected>500 pages</option></select><button id="run">Run integrity audit</button></div><div class="status" id="status"></div><div class="bar"><span id="progress"></span></div></section>
<section class="stats"><div class="card stat"><span>Integrity</span><strong id="score">—</strong></div><div class="card stat"><span>Pages</span><strong id="pages">0</strong></div><div class="card stat"><span>Errors</span><strong id="errors">0</strong></div><div class="card stat"><span>Warnings</span><strong id="warnings">0</strong></div><div class="card stat"><span>Notices</span><strong id="notices">0</strong></div><div class="card stat"><span>Exceptions</span><strong id="exceptions">0</strong></div></section>
<section class="filters"><input id="search" placeholder="Search page, rule, detail…"><select id="severity"><option value="">All severities</option><option>error</option><option>warning</option><option>notice</option><option>info</option></select><select id="category"><option value="">All categories</option></select><select id="family"><option value="">All page families</option></select><button class="secondary" id="export" disabled>Export CSV</button></section>
<div class="tablewrap"><table><thead><tr><th>Page</th><th>Family</th><th>Severity</th><th>Category</th><th>Rule</th><th>Finding</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></div><div class="footer">Curator Integrity v1 · Read-only standards audit</div>
<script>
const state={queue:[],seen:new Set(),pages:[],findings:[],running:false};const $=id=>document.getElementById(id);$('run').onclick=run;$('search').oninput=render;$('severity').onchange=render;$('category').onchange=render;$('family').onchange=render;$('export').onclick=exportCsv;
async function api(url){const u=new URL('/api/page',location.origin);u.searchParams.set('url',url);const r=await fetch(u);const j=await r.json();if(!r.ok)throw new Error(j.error||'Request failed');return j}
async function run(){if(state.running)return;state.running=true;state.queue=[];state.seen=new Set();state.pages=[];state.findings=[];$('run').disabled=true;$('export').disabled=true;const start=$('start').value.trim();const limit=Number($('limit').value)||500;state.queue.push(start);setStatus('Starting integrity crawl…');while(state.queue.length&&state.pages.length<limit){const url=state.queue.shift();if(state.seen.has(url))continue;state.seen.add(url);setStatus('Auditing '+url);try{const p=await api(url);state.pages.push(p);p.findings.forEach(f=>state.findings.push({...f,page_url:p.finalUrl,family:p.classification}));for(const link of p.links){if(!state.seen.has(link)&&!state.queue.includes(link)&&state.pages.length+state.queue.length<limit*2)state.queue.push(link)}}catch(e){state.findings.push({page_url:url,family:'unknown',rule:'page.fetch',category:'document',severity:'error',label:'Page could not be audited',detail:e.message,excepted:false})}update();await tick()}crossPageChecks();state.running=false;$('run').disabled=false;$('export').disabled=false;setStatus('Audit complete: '+state.pages.length+' pages, '+state.findings.length+' findings.');update()}
function crossPageChecks(){const titles=new Map(),canon=new Map();for(const p of state.pages){const t=p.snapshot.title;if(t){if(!titles.has(t))titles.set(t,[]);titles.get(t).push(p)}for(const c of p.snapshot.canonicals||[]){const k=norm(c);if(!canon.has(k))canon.set(k,[]);canon.get(k).push(p)}}for(const [title,ps] of titles){if(ps.length>1)ps.forEach(p=>state.findings.push({page_url:p.finalUrl,family:p.classification,rule:'page.title-unique',category:'metadata',severity:'notice',label:'Page title is unique in scan',detail:'Title is shared by '+ps.length+' pages: '+title,excepted:false}))}for(const [c,ps] of canon){if(ps.length>1)ps.forEach(p=>state.findings.push({page_url:p.finalUrl,family:p.classification,rule:'canonical.unique',category:'metadata',severity:'error',label:'Canonical is unique in scan',detail:'Canonical is claimed by '+ps.length+' pages: '+c,excepted:false}))}}
function update(){const active=state.findings.filter(f=>!f.excepted);const weight={error:5,warning:2,notice:.5,info:.1};const penalty=active.reduce((n,f)=>n+(weight[f.severity]||0),0);const denom=Math.max(1,state.pages.length*10);const score=Math.max(0,100-penalty/denom*100);$('score').textContent=state.pages.length?score.toFixed(1)+'%':'—';$('pages').textContent=state.pages.length;$('errors').textContent=active.filter(f=>f.severity==='error').length;$('warnings').textContent=active.filter(f=>f.severity==='warning').length;$('notices').textContent=active.filter(f=>f.severity==='notice').length;$('exceptions').textContent=state.findings.filter(f=>f.excepted).length;const total=Math.max(1,state.seen.size+state.queue.length);$('progress').style.width=Math.min(100,state.seen.size/total*100)+'%';populateFilters();render()}
function populateFilters(){const cats=[...new Set(state.findings.map(f=>f.category))].sort(),fams=[...new Set(state.findings.map(f=>f.family))].sort();fill('category',cats,'All categories');fill('family',fams,'All page families')}
function fill(id,vals,label){const s=$(id),v=s.value;s.innerHTML='<option value="">'+label+'</option>'+vals.map(x=>'<option>'+esc(x)+'</option>').join('');s.value=v}
function render(){const q=$('search').value.toLowerCase(),sev=$('severity').value,cat=$('category').value,fam=$('family').value;const rows=state.findings.filter(f=>(!q||[f.page_url,f.rule,f.label,f.detail].join(' ').toLowerCase().includes(q))&&(!sev||f.severity===sev)&&(!cat||f.category===cat)&&(!fam||f.family===fam));$('rows').innerHTML=rows.map(f=>'<tr class="'+(f.excepted?'excepted':'')+'"><td><a href="'+esc(f.page_url)+'" target="_blank" rel="noopener">'+esc(shortUrl(f.page_url))+'</a></td><td>'+esc(f.family)+'</td><td><span class="pill '+esc(f.severity)+'">'+esc(f.severity)+'</span></td><td>'+esc(f.category)+'</td><td>'+esc(f.rule)+'</td><td><strong>'+esc(f.label)+'</strong><div class="small">'+esc(f.detail)+'</div></td><td>'+(f.excepted?'Accepted exception<div class="small">'+esc(f.exception||'')+'</div>':'Finding')+'</td></tr>').join('')}
function exportCsv(){const h=['page_url','family','severity','category','rule','label','detail','excepted','exception'];const c=[h.join(','),...state.findings.map(f=>h.map(k=>'"'+String(f[k]??'').replaceAll('"','""')+'"').join(','))].join('\r\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\uFEFF'+c],{type:'text/csv;charset=utf-8'}));a.download='curator-integrity-'+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function setStatus(v){$('status').textContent=v}function tick(){return new Promise(r=>setTimeout(r,0))}function shortUrl(v){try{return new URL(v).pathname||'/'}catch{return v}}function norm(v){try{const u=new URL(v);u.hash='';u.search='';u.pathname=u.pathname==='/'?'/':u.pathname.replace(/\/+$/,'');return u.href}catch{return v}}function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
</script></main></body></html>`;
