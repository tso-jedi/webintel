// =============================================================================
// Merchant Intel backend  (v2 — adds free domain/DNS/infra intel + adverse media)
// -----------------------------------------------------------------------------
// POST /api/enrich  { query, region }  -> unified intel report
//
// Data sources:
//   - Clearbit Autocomplete (free)        -> name -> domain
//   - RDAP / WHOIS (free)                 -> domain age, registrar
//   - DNS + TLS + HTTP headers (free)     -> DNS host, email provider, CDN, SSL issuer, SPF
//   - SimilarWeb (paid key, optional)     -> traffic, geo, channels, rank
//   - BuiltWith (paid key, optional)      -> tech stack
//   - Hunter.io (free tier)               -> contacts + company enrichment
//   - Anthropic + web_search              -> researched company facts, risk, fit,
//                                            outreach, AND adverse-media / regulatory scan
//
// Every source is wrapped so one failure never kills the response.
// Requires Node >= 18.
// =============================================================================

import express from "express";
import cors from "cors";
import dns from "node:dns/promises";
import tls from "node:tls";
import net from "node:net";
import "dotenv/config";

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-4-6",
  SIMILARWEB_API_KEY,
  BUILTWITH_API_KEY,
  HUNTER_API_KEY,
  PORT = 3001,
  ALLOWED_ORIGINS = "*",
} = process.env;

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGINS === "*" ? true : ALLOWED_ORIGINS.split(",").map((s) => s.trim()) }));

const ok = (r) => r && r.ok;
const num = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : null);

function trafficTier(v) {
  if (v == null) return "unknown";
  if (v >= 50e6) return "Very high (50M+/mo)";
  if (v >= 10e6) return "High (10-50M/mo)";
  if (v >= 1e6) return "Mid (1-10M/mo)";
  if (v >= 1e5) return "Low-mid (100K-1M/mo)";
  if (v >= 1e4) return "Low (10-100K/mo)";
  return "Minimal (<10K/mo)";
}

const ISO = {4:"Afghanistan",32:"Argentina",36:"Australia",40:"Austria",56:"Belgium",76:"Brazil",100:"Bulgaria",124:"Canada",152:"Chile",156:"China",170:"Colombia",191:"Croatia",196:"Cyprus",203:"Czechia",208:"Denmark",233:"Estonia",246:"Finland",250:"France",276:"Germany",300:"Greece",344:"Hong Kong",348:"Hungary",356:"India",360:"Indonesia",372:"Ireland",376:"Israel",380:"Italy",392:"Japan",410:"South Korea",428:"Latvia",440:"Lithuania",442:"Luxembourg",458:"Malaysia",484:"Mexico",528:"Netherlands",554:"New Zealand",578:"Norway",586:"Pakistan",604:"Peru",608:"Philippines",616:"Poland",620:"Portugal",642:"Romania",643:"Russia",682:"Saudi Arabia",688:"Serbia",702:"Singapore",703:"Slovakia",705:"Slovenia",710:"South Africa",724:"Spain",752:"Sweden",756:"Switzerland",764:"Thailand",792:"Turkey",804:"Ukraine",784:"UAE",826:"United Kingdom",840:"United States",704:"Vietnam"};
const countryName = (c) => ISO[c] || `Country ${c}`;

function dateWindow() {
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  const end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  d.setMonth(d.getMonth() - 2);
  const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return { start, end };
}
async function jsonFetch(url, opts) {
  const r = await fetch(url, opts);
  if (!ok(r)) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// ---- resolve name -> domain ------------------------------------------------
async function resolveDomain(query) {
  const q = query.trim();
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(q) && !q.includes(" "))
    return q.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  try {
    const arr = await jsonFetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`);
    if (Array.isArray(arr) && arr[0]?.domain) return arr[0].domain.toLowerCase();
  } catch {}
  return q;
}

// ---- FREE: domain age (RDAP first, WHOIS fallback) -------------------------
async function rdap(domain) {
  try {
    const r = await fetch(`https://rdap.org/domain/${domain}`, { signal: AbortSignal.timeout(8000) });
    if (!ok(r)) return null;
    const j = await r.json();
    const ev = j.events || [];
    const created = ev.find((e) => e.eventAction === "registration")?.eventDate || null;
    const changed = ev.find((e) => e.eventAction === "last changed")?.eventDate || null;
    let registrar = null;
    for (const e of j.entities || []) {
      if ((e.roles || []).includes("registrar")) {
        const vc = e.vcardArray?.[1] || [];
        const fn = vc.find((x) => x[0] === "fn");
        registrar = fn ? fn[3] : null;
      }
    }
    return { created, changed, registrar };
  } catch { return null; }
}
function whoisQuery(server, query) {
  return new Promise((resolve) => {
    let data = "";
    const sock = net.connect(43, server, () => sock.write(query + "\r\n"));
    sock.setTimeout(6000);
    sock.on("data", (d) => (data += d.toString()));
    sock.on("close", () => resolve(data));
    sock.on("timeout", () => { sock.destroy(); resolve(data); });
    sock.on("error", () => resolve(data));
  });
}
async function whoisLookup(domain) {
  try {
    const tld = domain.split(".").pop();
    const iana = await whoisQuery("whois.iana.org", tld);
    const m = iana.match(/whois:\s*(\S+)/i);
    if (!m) return null;
    return await whoisQuery(m[1].trim(), domain);
  } catch { return null; }
}
function parseField(text, labels) {
  if (!text) return null;
  for (const l of labels) {
    const m = text.match(new RegExp(l + "\\s*:?\\s*([^\\r\\n]+)", "i"));
    if (m) return m[1].trim();
  }
  return null;
}
async function domainAge(domain) {
  let created = null, registrar = null, changed = null, source = null;
  const rd = await rdap(domain);
  if (rd && rd.created) { created = rd.created; registrar = rd.registrar; changed = rd.changed; source = "RDAP"; }
  else {
    const w = await whoisLookup(domain);
    created = parseField(w, ["Creation Date", "Created On", "created", "Registered On", "Registration Date", "Registered"]);
    registrar = parseField(w, ["Registrar"]);
    source = created ? "WHOIS" : null;
  }
  let age = null;
  if (created) { const d = new Date(created); if (!isNaN(d)) { const y = (Date.now() - d) / (365.25 * 864e5); age = y >= 1 ? y.toFixed(1) + "y" : Math.round(y * 12) + "mo"; } }
  return { created, changed, registrar, age, source };
}

// ---- FREE: DNS fingerprint -------------------------------------------------
function nsProvider(ns) {
  if (!ns || !ns.length) return null;
  const s = ns.join(" ").toLowerCase();
  if (s.includes("cloudflare")) return "Cloudflare";
  if (s.includes("awsdns")) return "AWS Route 53";
  if (s.includes("domaincontrol")) return "GoDaddy";
  if (s.includes("googledomains") || s.includes("google.com")) return "Google";
  if (s.includes("nsone") || s.includes("ns1.")) return "NS1";
  if (s.includes("akam")) return "Akamai";
  if (s.includes("azure-dns")) return "Azure DNS";
  if (s.includes("dnsimple")) return "DNSimple";
  if (s.includes("digitalocean")) return "DigitalOcean";
  return ns[0];
}
function mxProvider(mx) {
  if (!mx || !mx.length) return null;
  const s = mx.join(" ").toLowerCase();
  if (s.includes("google")) return "Google Workspace";
  if (s.includes("outlook") || s.includes("protection.outlook")) return "Microsoft 365";
  if (s.includes("pphosted") || s.includes("proofpoint")) return "Proofpoint";
  if (s.includes("mimecast")) return "Mimecast";
  if (s.includes("zoho")) return "Zoho";
  if (s.includes("proton")) return "Proton";
  if (s.includes("sendgrid")) return "SendGrid";
  if (s.includes("mailgun")) return "Mailgun";
  if (s.includes("amazonses") || s.includes("amazonaws")) return "Amazon SES";
  return mx[0];
}
async function dnsIntel(domain) {
  const out = {};
  await Promise.all([
    dns.resolveNs(domain).then((x) => (out.ns = x)).catch(() => {}),
    dns.resolveMx(domain).then((x) => (out.mx = x.sort((a, b) => a.priority - b.priority).map((m) => m.exchange))).catch(() => {}),
    dns.resolve4(domain).then((x) => (out.a = x)).catch(() => {}),
    dns.resolveTxt(domain).then((x) => (out.txt = x.map((t) => t.join("")))).catch(() => {}),
  ]);
  out.spf = (out.txt || []).find((t) => /^v=spf1/i.test(t)) || null;
  if (out.a && out.a[0]) { try { const p = await dns.reverse(out.a[0]); out.ptr = p && p[0]; } catch {} }
  return out;
}

// ---- FREE: HTTP headers (server / CDN) -------------------------------------
async function httpIntel(domain) {
  try {
    const r = await fetch("https://" + domain, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    const h = r.headers;
    let cdn = null;
    if (h.get("cf-ray")) cdn = "Cloudflare";
    else if (h.get("x-amz-cf-id")) cdn = "Amazon CloudFront";
    else if ((h.get("x-served-by") || "").includes("cache") || (h.get("via") || "").includes("varnish")) cdn = "Fastly/Varnish";
    else if (h.get("x-akamai-transformed")) cdn = "Akamai";
    return { final_url: r.url, server: h.get("server"), cdn, powered: h.get("x-powered-by") };
  } catch { return null; }
}

// ---- FREE: TLS cert issuer -------------------------------------------------
function sslIntel(domain) {
  return new Promise((resolve) => {
    try {
      const s = tls.connect({ host: domain, port: 443, servername: domain, timeout: 6000, rejectUnauthorized: false }, () => {
        const c = s.getPeerCertificate();
        resolve({ issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || null, valid_from: c.valid_from || null, valid_to: c.valid_to || null });
        s.end();
      });
      s.on("error", () => resolve(null));
      s.on("timeout", () => { s.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

async function domainIntel(domain) {
  const [age, dnsd, http, ssl] = await Promise.all([
    domainAge(domain).catch(() => null),
    dnsIntel(domain).catch(() => null),
    httpIntel(domain).catch(() => null),
    sslIntel(domain).catch(() => null),
  ]);
  return { age, dns: dnsd, http, ssl };
}

// ---- SimilarWeb ------------------------------------------------------------
async function similarweb(domain) {
  if (!SIMILARWEB_API_KEY) return null;
  const { start, end } = dateWindow();
  const SW = "https://api.similarweb.com/v1/website";
  const base = `api_key=${SIMILARWEB_API_KEY}&format=json&main_domain_only=false`;
  const out = {};
  try { const j = await jsonFetch(`${SW}/${domain}/total-traffic-and-engagement/visits?${base}&start_date=${start}&end_date=${end}&country=world&granularity=monthly`); const s = j.visits || []; out.visits = s.length ? s[s.length - 1].visits : null; } catch {}
  try { const j = await jsonFetch(`${SW}/${domain}/geo/traffic-by-country?${base}&start_date=${start}&end_date=${end}`); out.geo = (j.records || []).sort((a, b) => b.share - a.share).slice(0, 4).map((r) => `${countryName(r.country)} (${Math.round(r.share * 100)}%)`); } catch {}
  try { const j = await jsonFetch(`${SW}/${domain}/traffic-sources/overview-share?${base}&start_date=${start}&end_date=${end}&country=world&granularity=monthly`); const arr = j.visits || j.overview || j.records || (Array.isArray(j) ? j : []); out.channels = (arr || []).map((x) => { const l = x.source_type || x.source || x.channel || x.name; const sh = x.share ?? x.value; return l && sh != null ? `${l} (${Math.round(sh * 100)}%)` : null; }).filter(Boolean).slice(0, 5); } catch {}
  try { const j = await jsonFetch(`${SW}/${domain}/global-rank/global-rank?${base}`); out.rank = j.global_rank?.rank ?? j.rank ?? null; } catch {}
  return out;
}

// ---- BuiltWith -------------------------------------------------------------
async function builtwith(domain) {
  if (!BUILTWITH_API_KEY) return null;
  try {
    const j = await jsonFetch(`https://api.builtwith.com/v21/api.json?KEY=${BUILTWITH_API_KEY}&LOOKUP=${domain}`);
    const paths = j.Results?.[0]?.Result?.Paths || [];
    const names = new Set(); const pri = []; const rest = [];
    const P = new Set(["payment", "analytics", "ecommerce", "framework", "cms", "javascript", "cdn", "hosting", "ssl", "tag-management", "advertising", "widgets"]);
    for (const p of paths) for (const t of p.Technologies || []) { if (!t.Name || names.has(t.Name)) continue; names.add(t.Name); (P.has((t.Tag || "").toLowerCase()) ? pri : rest).push(t.Name); }
    return { tech: [...pri, ...rest].slice(0, 10) };
  } catch { return null; }
}

// ---- Hunter ----------------------------------------------------------------
async function hunter(domain) {
  if (!HUNTER_API_KEY) return null;
  const out = {};
  try {
    const j = await jsonFetch(`https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${HUNTER_API_KEY}&limit=10`);
    out.contacts = (j.data?.emails || []).filter((e) => e.first_name || e.position).slice(0, 5).map((e) => [[e.first_name, e.last_name].filter(Boolean).join(" "), e.position, e.value].filter(Boolean).join(" - "));
    out.org = j.data?.organization || null;
  } catch {}
  try {
    const j = await jsonFetch(`https://api.hunter.io/v2/companies/find?domain=${domain}&api_key=${HUNTER_API_KEY}`);
    const d = j.data || {};
    out.company = { name: d.name || out.org || null, industry: d.category?.industry || null, employees: d.metrics?.employees || d.metrics?.employeesRange || null, founded: d.foundedYear ? String(d.foundedYear) : null, hq: [d.geo?.city, d.geo?.state, d.geo?.country].filter(Boolean).join(", ") || null, description: d.description || null };
    out.social = [d.twitter && `Twitter/X @${d.twitter}`, d.linkedin && `LinkedIn: ${d.linkedin}`, d.facebook && `Facebook: ${d.facebook}`, d.instagram && `Instagram @${d.instagram}`, d.youtube && `YouTube: ${d.youtube}`].filter(Boolean);
  } catch {}
  return out;
}

// ---- Claude judgment layer (now web-search powered + adverse media) --------
async function synthesize({ query, region, domain, vendor, di }) {
  if (!ANTHROPIC_API_KEY) return null;
  const sys =
    "You are a merchant-intelligence analyst for Corepay (a global high-risk PSP) and Dispu (its chargeback/dispute platform). " +
    "Use web_search to research the company at the given domain, then return enrichment. Be concrete and current; prefer facts you can verify over guesses. " +
    "You are also given REAL data already pulled (SimilarWeb / BuiltWith / Hunter / DNS / domain age) - do not restate those numbers, but use them as context. " +
    "payment_risk is from a card-acquiring view: classify card-acceptance risk (Low/Medium/High/Prohibited) and flag verticals (adult, dating, iGaming/gambling, CBD, nutra, telehealth/pharma, FX/trading, crypto, AI companion). " +
    "adverse_media: actively search for negative signals - sanctions/PEP mentions, prior card-scheme problems (MATCH/TMF listing, excessive-chargeback or fraud-monitoring programs), regulatory or licensing status, lawsuits, scam/complaint patterns, data breaches. If you find nothing, say so plainly; never fabricate findings. For EACH flag, include the exact source URL from your web_search results where you found it; if you are not confident of the exact URL, set url to an empty string rather than guessing - never invent a URL. " +
    "boardability is a card-acquiring underwriting PRE-CHECK decision for Corepay. verdict must be one of: 'PRE-CHECK PASS' (clean, route to underwriting), 'CONDITIONAL' (board only with the listed conditions), 'DECLINE' (do not board), 'ESCALATE' (needs senior judgment from Head of Underwriting). conditions are concrete and specific (e.g. rolling reserve %, age-verification/2257 proof, billing-descriptor strategy, MID/segmentation structure, prohibited sub-segments, required licences). routing_note is a short FACTUAL, STRUCTURED internal note to the underwriting lead with NO marketing tone - state merchant, domain, vertical, MCC, risk class, top adverse flags, recommended conditions, and recommended next step. " +
    "Respond with ONLY valid JSON, no markdown, no fences. Keep arrays to 3-5 short items. Schema: {" +
    '"business_model":{"type":string,"monetization":string,"products":string[]},' +
    '"payment_risk":{"classification":"Low"|"Medium"|"High"|"Prohibited","mcc_guess":string,"vertical_flags":string[],"chargeback_risk":string,"rationale":string},' +
    '"corepay_fit":{"score":number,"verdict":string,"reasons":string[],"watchouts":string[]},' +
    '"boardability":{"verdict":"PRE-CHECK PASS"|"CONDITIONAL"|"DECLINE"|"ESCALATE","rationale":string,"conditions":string[],"routing_note":string},' +
    '"outreach":{"angle":string,"possible_contacts":string[]},' +
    '"adverse_media":{"flags":[{"claim":string,"url":string}],"summary":string,"regulatory":string},' +
    '"company_fill":{"summary":string,"industry":string,"founded":string,"app_presence":string,"hq":string}}';
  const ctx = { vendor, domain_registered: di?.age?.created || null, dns: di?.dns ? { provider: nsProvider(di.dns.ns), email: mxProvider(di.dns.mx) } : null };
  const user = `Target: ${query} (domain: ${domain})` + (region ? `, focus region ${region}` : "") + `.\nContext data:\n${JSON.stringify(ctx, null, 2)}\nResearch with web_search, then return the JSON object only.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2800, system: sys, messages: [{ role: "user", content: user }], tools: [{ type: "web_search_20250305", name: "web_search" }] }),
  });
  if (!ok(r)) throw new Error(`Anthropic ${r.status}`);
  const data = await r.json();
  // collect the REAL urls the web search actually returned (ground truth, not model-claimed)
  const cites = [];
  for (const b of data.content || []) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const x of b.content) if (x && x.url) cites.push({ title: x.title || x.url, url: x.url });
    }
  }
  const seen = new Set();
  const citations = cites.filter((c) => !seen.has(c.url) && seen.add(c.url)).slice(0, 12);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const raw = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return { data: parsed, citations };
}

// ---- assemble --------------------------------------------------------------
app.post("/api/enrich", async (req, res) => {
  try {
    const { query, region } = req.body || {};
    if (!query || !query.trim()) return res.status(400).json({ error: "query is required" });
    const domain = await resolveDomain(query);

    const [sw, bw, hu, di] = await Promise.all([similarweb(domain), builtwith(domain), hunter(domain), domainIntel(domain)]);
    const vendor = { similarweb: sw, builtwith: bw, hunter: hu ? { company: hu.company, social: hu.social, contacts: hu.contacts } : null };

    let synth = null, citations = [];
    try { const s = await synthesize({ query, region, domain, vendor, di }); if (s) { synth = s.data; citations = s.citations || []; } } catch {}
    const fill = synth?.company_fill || {};

    const regDate = di?.age?.created ? String(di.age.created).slice(0, 10) : null;

    const report = {
      company: {
        name: hu?.company?.name || hu?.org || query,
        domain,
        hq: hu?.company?.hq || fill.hq || "",
        founded: fill.founded || hu?.company?.founded || (regDate ? `Domain reg. ${regDate}` : ""),
        summary: fill.summary || hu?.company?.description || "",
        industry: hu?.company?.industry || fill.industry || "",
        employees_estimate: hu?.company?.employees ? String(hu.company.employees) : "",
      },
      business_model: synth?.business_model || { type: "", monetization: "", products: [] },
      web_intel: {
        traffic_tier: trafficTier(sw?.visits),
        monthly_visits_estimate: sw?.visits != null ? `${num(sw.visits)} (SimilarWeb, latest mo.)` : "n/a",
        top_geographies: sw?.geo || [],
        primary_channels: sw?.channels || [],
        tech_signals: bw?.tech || [],
        notable: sw?.rank ? `SimilarWeb global rank #${num(sw.rank)}` : "",
      },
      infrastructure: {
        domain_age: di?.age?.age ? `${di.age.age}${regDate ? ` (registered ${regDate})` : ""}` : (regDate || ""),
        registrar: di?.age?.registrar || "",
        dns_provider: nsProvider(di?.dns?.ns) || "",
        email_provider: mxProvider(di?.dns?.mx) || "",
        hosting: di?.http?.server || di?.dns?.ptr || "",
        cdn: di?.http?.cdn || "",
        ssl_issuer: di?.ssl?.issuer || "",
        ssl_expiry: di?.ssl?.valid_to || "",
        spf: di?.dns?.spf ? "present" : (di?.dns?.txt ? "none" : ""),
      },
      digital_presence: { social: hu?.social || [], app_presence: fill.app_presence || "" },
      payment_risk: synth?.payment_risk || { classification: "Medium", mcc_guess: "", vertical_flags: [], chargeback_risk: "", rationale: "" },
      boardability: synth?.boardability || { verdict: "", rationale: "", conditions: [], routing_note: "" },
      corepay_fit: synth?.corepay_fit || { score: 0, verdict: "Not scored", reasons: [], watchouts: [] },
      adverse_media: {
        flags: Array.isArray(synth?.adverse_media?.flags) ? synth.adverse_media.flags : [],
        summary: synth?.adverse_media?.summary || "",
        regulatory: synth?.adverse_media?.regulatory || "",
        sources: citations,
      },
      outreach: {
        angle: synth?.outreach?.angle || "",
        possible_contacts: hu?.contacts && hu.contacts.length ? hu.contacts : synth?.outreach?.possible_contacts || [],
      },
      sources: [sw && "SimilarWeb", bw && "BuiltWith", hu && "Hunter", di && "Domain/DNS", synth && "Claude+web"].filter(Boolean),
      confidence: (sw && hu) || (synth && di) ? "high" : sw || hu || bw || synth || di ? "medium" : "low",
      _meta: { resolved_domain: domain, sources_used: { similarweb: !!sw, builtwith: !!bw, hunter: !!hu, domain: !!di, claude: !!synth } },
    };
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message || "enrichment failed" }); }
});

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, keys: { anthropic: !!ANTHROPIC_API_KEY, similarweb: !!SIMILARWEB_API_KEY, builtwith: !!BUILTWITH_API_KEY, hunter: !!HUNTER_API_KEY } })
);

app.listen(PORT, () => console.log(`Merchant Intel backend on :${PORT}`));
