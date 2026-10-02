// =============================================================================
// Merchant Intel backend  (v3 — application context, hard gates, principal
// screening, name-collision filtering, calibrated confidence)
// -----------------------------------------------------------------------------
// POST /api/enrich  { query, region, application?, refresh? }  -> unified intel report
//
// v3 changes (see README "What changed in v3"):
//   - Optional APPLICATION CONTEXT (declared vertical, volume, entity, principals,
//     linked companies, referral partner) via JSON body or top-bar "|" syntax.
//   - Direct website check: live / maintenance / password / coming soon / parked /
//     suspended / blocked. Not-live is a hard gate (verdict HOLD).
//   - Declared-vs-observed mismatch checks, entity verification (OpenCorporates
//     optional + grounded Claude registry lookup), principal + linked-company screening.
//   - Name-collision filter on sources and adverse flags; flag URLs must come from
//     real web_search results.
//   - Affiliate/MLM and recurring-billing signal detection from site content;
//     Visa high-brand-risk MCC floors.
//   - Outreach suppressed for partner-referred files.
//   - Confidence computed from what was actually verified, with reasons.
//   - Fixes: "https://domain/" input no longer breaks DNS/RDAP/Hunter; vendor
//     "sources_used" only true when data came back. 24h cache. Optional access token.
//
// Deterministic rules live in checks.js so the model can never override a gate.
// Requires Node >= 18.
// =============================================================================

import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import tls from "node:tls";
import net from "node:net";
import "dotenv/config";
import {
  VERSION, cleanDomain, parseQuery, normalizeApplication, coreName, stateToJurisdiction,
  htmlToText, htmlTitle, extractLinks, detectPlatform, policyLinks, pickFollowLinks,
  classifySite, scanSignals, buildNeedles, splitCitations, filterFlags, cleanScreening,
  foldScreeningIntoFlags, mergeEntity, entityMismatches, deterministicMismatches,
  mergeMismatches, evaluateGates, applyGuards, computeConfidence,
} from "./checks.js";

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-4-6",
  SIMILARWEB_API_KEY,
  BUILTWITH_API_KEY,
  HUNTER_API_KEY,
  OPENCORPORATES_API_TOKEN,
  DEAL_DESK_TOKEN,
  CACHE_TTL_HOURS = "24",
  WEB_SEARCH_MAX_USES = "10",
  SITE_CHECK_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  PORT = 3001,
  ALLOWED_ORIGINS = "*",
} = process.env;

const app = express();
app.use(express.json({ limit: "256kb" }));
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
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), ...opts });
  if (!ok(r)) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// ---- optional access token ----------------------------------------------------
// The repo is public and the Render URL is guessable. If DEAL_DESK_TOKEN is set,
// /api/enrich requires header  x-deal-desk-token: <token>  (or Authorization: Bearer).
function requireToken(req, res, next) {
  if (!DEAL_DESK_TOKEN) return next();
  const got = req.get("x-deal-desk-token") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(DEAL_DESK_TOKEN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ error: "unauthorized — set the Deal Desk token" });
}

// ---- 24h report cache (report JSON only, no raw contact dumps) -------------------
const cache = new Map();
const TTL = Number(CACHE_TTL_HOURS) * 3600e3;
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > TTL) { cache.delete(key); return null; }
  return hit.v;
}
function cacheSet(key, v) {
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}

// ---- resolve name -> domain ------------------------------------------------
async function resolveDomain(query) {
  const cleaned = cleanDomain(query);
  if (cleaned) return cleaned;
  try {
    const arr = await jsonFetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(query.trim())}`);
    if (Array.isArray(arr) && arr[0]?.domain) return arr[0].domain.toLowerCase();
  } catch {}
  return null;
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
  const [age, dnsd, ssl] = await Promise.all([
    domainAge(domain).catch(() => null),
    dnsIntel(domain).catch(() => null),
    sslIntel(domain).catch(() => null),
  ]);
  return { age, dns: dnsd, http: null, ssl };
}

// ---- Website check: status, content signals, policies, platform ---------------
async function fetchPage(url, timeoutMs = 9000) {
  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": SITE_CHECK_USER_AGENT, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const type = r.headers.get("content-type") || "";
    const html = !type || /html|text/i.test(type) ? (await r.text()).slice(0, 1_500_000) : "";
    return { httpStatus: r.status, finalUrl: r.url, html, headers: r.headers };
  } catch (e) {
    return { error: e?.name === "TimeoutError" ? "timeout" : e?.cause?.code || e?.message || "fetch failed" };
  }
}

function headerIntel(page) {
  const h = page?.headers;
  if (!h) return null;
  let cdn = null;
  if (h.get("cf-ray")) cdn = "Cloudflare";
  else if (h.get("x-amz-cf-id")) cdn = "Amazon CloudFront";
  else if ((h.get("x-served-by") || "").includes("cache") || (h.get("via") || "").includes("varnish")) cdn = "Fastly/Varnish";
  else if (h.get("x-akamai-transformed")) cdn = "Akamai";
  return { final_url: page.finalUrl, server: h.get("server"), cdn, powered: h.get("x-powered-by") };
}

async function siteCheck(domain) {
  let page = await fetchPage(`https://${domain}`);
  if (page.error) {
    const alt = await fetchPage(`http://${domain}`);
    if (!alt.error) page = alt;
  }
  const site = classifySite({ inputDomain: domain, ...page });
  const texts = [];
  const excerpts = [];
  const followed = [];
  let policies = {};
  let platform = null;
  if (page.html) {
    const base = page.finalUrl || `https://${domain}`;
    const links = extractLinks(page.html, base);
    const homeText = `${htmlTitle(page.html)} ${htmlToText(page.html)}`;
    texts.push(homeText);
    excerpts.push(homeText.slice(0, 2500));
    policies = policyLinks(links);
    platform = detectPlatform(page.html);
    if (site.status === "live") {
      const targets = pickFollowLinks(links, domain, 4);
      const pages = await Promise.all(targets.map((u) => fetchPage(u, 6000)));
      pages.forEach((p, i) => {
        if (p.html && p.httpStatus < 400) {
          const t = htmlToText(p.html);
          texts.push(t);
          excerpts.push(`[${targets[i]}] ${t.slice(0, 600)}`);
          followed.push(targets[i]);
        }
      });
    }
  }
  const signals = scanSignals(texts);
  return {
    site: { ...site, platform, policies, pages_scanned: texts.length, followed },
    signals,
    excerpt: excerpts.join("\n").slice(0, 4000),
    http: headerIntel(page),
  };
}

// ---- Registry: OpenCorporates (optional key) -------------------------------------
async function registryLookup(application) {
  if (!OPENCORPORATES_API_TOKEN || !application?.legal_name) return null;
  const params = new URLSearchParams({ q: application.legal_name, api_token: OPENCORPORATES_API_TOKEN, per_page: "5" });
  const jur = stateToJurisdiction(application.entity_state);
  if (jur) params.set("jurisdiction_code", jur);
  try {
    const j = await jsonFetch(`https://api.opencorporates.com/v0.4/companies/search?${params}`);
    const list = (j.results?.companies || []).map((x) => x.company).filter(Boolean);
    const want = coreName(application.legal_name);
    const hit = list.find((c) => coreName(c.name) === want);
    if (!hit) return { verified: false, source: "OpenCorporates", candidates: list.slice(0, 3).map((c) => c.name) };
    let officers = [];
    try {
      const d = await jsonFetch(`https://api.opencorporates.com/v0.4/companies/${hit.jurisdiction_code}/${encodeURIComponent(hit.company_number)}?api_token=${OPENCORPORATES_API_TOKEN}`);
      officers = (d.results?.company?.officers || []).map((o) => o.officer).filter(Boolean)
        .map((o) => ({ name: o.name, position: o.position, inactive: !!o.inactive }));
    } catch {}
    return {
      verified: true, source: "OpenCorporates", legal_name: hit.name, registry_id: hit.company_number,
      jurisdiction: hit.jurisdiction_code, status: hit.current_status, formation_date: hit.incorporation_date,
      company_type: hit.company_type, registered_address: hit.registered_address_in_full || null,
      officers, source_url: hit.opencorporates_url, registered_address_type: "unknown",
    };
  } catch (e) {
    return { verified: false, source: "OpenCorporates", error: e.message };
  }
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
  const has = out.contacts?.length || out.org || out.company?.name || out.company?.description || out.social?.length;
  return has ? out : null;
}

// ---- Claude judgment layer ----------------------------------------------------------
const SCHEMA =
  "{" +
  '"business_model":{"type":string,"monetization":string,"products":string[]},' +
  '"payment_risk":{"classification":"Low"|"Medium"|"High"|"Prohibited","mcc_guess":string,"mcc_candidates":[{"mcc":string,"description":string,"when":string}],"vertical_flags":string[],"chargeback_risk":string,"rationale":string},' +
  '"corepay_fit":{"score":number,"verdict":string,"reasons":string[],"watchouts":string[]},' +
  '"boardability":{"verdict":"PRE-CHECK PASS"|"CONDITIONAL"|"DECLINE"|"ESCALATE","rationale":string,"conditions":string[],"routing_note":string},' +
  '"outreach":{"angle":string,"possible_contacts":string[]},' +
  '"adverse_media":{"flags":[{"subject":string,"match_basis":"domain"|"legal_name"|"dba"|"principal"|"linked_company"|"registry"|"similar_name_only","claim":string,"severity":"high"|"medium"|"low","url":string}],"summary":string,"regulatory":string},' +
  '"entity_verification":{"found":boolean,"legal_name":string,"registry_id":string,"jurisdiction":string,"status":string,"formation_date":string,"officers":string[],"registered_address_type":"residential"|"commercial"|"virtual_office"|"registered_agent"|"unknown","source_url":string},' +
  '"principal_screening":[{"subject":string,"type":"principal"|"linked_company","summary":string,"findings":[{"claim":string,"severity":"high"|"medium"|"low","url":string}]}],' +
  '"consistency_check":{"summary":string,"mismatches":[{"field":string,"declared":string,"observed":string,"severity":"high"|"medium"|"low","note":string}]},' +
  '"company_fill":{"summary":string,"industry":string,"founded":string,"app_presence":string,"hq":string}}';

const SYSTEM = [
  "You are a merchant-intelligence analyst for Corepay (a global high-risk PSP and US acquirer) and Dispu (its chargeback/dispute platform). Research with web_search and return an underwriting PRE-CHECK as JSON.",
  "RULES:",
  "1. There are two businesses to consider: the OBSERVED business (domain, the deterministic site_check you are given, your web research) and, when application context is provided, the DECLARED business from the precheck form. When application context exists, classify payment_risk and MCC on the DECLARED business, because that is what will be processed. Never lower risk because the current website looks benign. Record every inconsistency between declared and observed in consistency_check.mismatches (e.g. vertical, volume vs footprint, entity, principals, processing history, website status).",
  "2. site_check was run directly against the website. If its status is not 'live', do not describe the storefront as trading and do not claim it is live.",
  "3. Screening scope: (a) the domain/brand; (b) the legal entity in its state or national business registry - search the official registry or reliable registry mirrors for status, formation date, officers/managers and registered address, and report it in entity_verification with the exact source URL; (c) each named principal by full name plus location; (d) each linked company named in the application or notes (prior employers, affiliated businesses) for regulatory actions, lawsuits, pyramid-scheme or earnings-claim enforcement, card-scheme problems. Put person and linked-company results in principal_screening, and repeat material ones in adverse_media.flags.",
  "4. Name collisions: only report a finding when it is tied to the subject by the exact domain, the exact legal or DBA name, a named principal with matching context (location, company), or a named linked company. Unrelated companies with similar names must be excluded; if all you have is a similar name, set match_basis to 'similar_name_only'. Never fabricate. If nothing is found, say so plainly.",
  "5. Every url must be copied exactly from your web_search results. If unsure, use an empty string. Never invent a URL.",
  "6. Affiliate/MLM: if the site, test logins or notes indicate affiliates, a back office, a compensation plan, recruitment or income claims, treat it as a business-opportunity/MLM model (FTC earnings-claims exposure, affiliate-fee chargebacks) and require the comp plan and income disclosure in conditions.",
  "7. MCC: give mcc_guess and mcc_candidates with when each applies (e.g. 4722 travel agency vs 5962 travel sold via direct marketing or clubs). Visa high-brand-risk MCCs (5122, 5912, 5962, 5966, 5967, 5993, 7273, 7995, and 4816/5816 in certain cases) require scheme registration.",
  "8. boardability.verdict is one of 'PRE-CHECK PASS', 'CONDITIONAL', 'DECLINE', 'ESCALATE'. Conditions must be concrete (reserve %, caps, documents, licences such as Seller of Travel, age verification, descriptor). routing_note is factual and structured with no marketing tone: merchant, domain, declared vs observed business, MCC, risk class, top flags with subject, conditions, next step.",
  "9. If referral_partner is provided, outreach.angle must state that communication goes through the partner and possible_contacts must be empty.",
  "10. corepay_fit.score (0-100) reflects fit AND evidence quality; do not exceed 60 when the site is not live or the declared business cannot be observed.",
  "Respond with ONLY valid JSON, no markdown, no fences. Keep arrays to 3-6 short items. Schema: " + SCHEMA,
].join("\n");

async function synthesize({ query, region, domain, vendor, di, application, sc, registry, detMismatches }) {
  if (!ANTHROPIC_API_KEY) return null;
  const ctx = {
    vendor,
    domain_registered: di?.age?.created || null,
    dns: di?.dns ? { provider: nsProvider(di.dns.ns), email: mxProvider(di.dns.mx) } : null,
    site_check: {
      status: sc.site.status, http_status: sc.site.http_status, final_url: sc.site.final_url, title: sc.site.title,
      evidence: sc.site.evidence, platform: sc.site.platform, policies: sc.site.policies, signals: sc.signals,
      text_excerpt: sc.excerpt,
    },
    application: application || null,
    registry_lookup: registry || null,
    deterministic_mismatches: detMismatches,
  };
  const user =
    `Target: ${query} (domain: ${domain})` + (region ? `, focus region ${region}` : "") +
    `.\nContext data:\n${JSON.stringify(ctx, null, 2)}\n` +
    (application ? "Application context IS provided: assess the declared business, verify the entity and screen the principals and linked companies.\n" : "No application context: domain-only scan.\n") +
    "Research with web_search, then return the JSON object only.";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: Number(WEB_SEARCH_MAX_USES) || 10 }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!ok(r)) throw new Error(`Anthropic ${r.status}`);
  const data = await r.json();
  // REAL urls the web search returned (ground truth, not model-claimed)
  const cites = [];
  for (const b of data.content || []) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const x of b.content) if (x && x.url) cites.push({ title: x.title || x.url, url: x.url });
    }
  }
  const seen = new Set();
  const citations = cites.filter((c) => !seen.has(c.url) && seen.add(c.url));
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const raw = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return { data: parsed, citations };
}

// ---- assemble --------------------------------------------------------------
app.post("/api/enrich", requireToken, async (req, res) => {
  try {
    const body = req.body || {};
    const { head, application: inline } = parseQuery(body.query);
    if (!head) return res.status(400).json({ error: "query is required" });
    const application = normalizeApplication({ ...(inline || {}), ...(body.application || {}) });
    const domain = await resolveDomain(head);
    if (!domain) return res.status(400).json({ error: `could not resolve a domain from "${head}"` });

    const cacheKey = crypto.createHash("sha256").update(JSON.stringify([domain, body.region || "", application])).digest("hex");
    if (!body.refresh) {
      const hit = cacheGet(cacheKey);
      if (hit) return res.json({ ...hit, _meta: { ...hit._meta, cache: "hit" } });
    }

    const [sw, bw, hu, di, sc, registry] = await Promise.all([
      similarweb(domain).catch(() => null),
      builtwith(domain).catch(() => null),
      hunter(domain).catch(() => null),
      domainIntel(domain).catch(() => null),
      siteCheck(domain),
      registryLookup(application).catch(() => null),
    ]);
    if (di) di.http = sc.http;
    const swHas = !!(sw && (sw.visits != null || sw.geo?.length || sw.channels?.length || sw.rank));
    const bwHas = !!(bw && bw.tech?.length);
    const vendor = { similarweb: swHas ? sw : null, builtwith: bwHas ? bw : null, hunter: hu ? { company: hu.company, social: hu.social, contacts: hu.contacts } : null };

    const detMismatches = deterministicMismatches({
      application, site: sc.site, signals: sc.signals, trafficVisits: sw?.visits ?? null, domainCreated: di?.age?.created || null,
    });

    let synth = null;
    let citations = [];
    try {
      const s = await synthesize({ query: head, region: body.region, domain, vendor, di, application, sc, registry, detMismatches });
      if (s) { synth = s.data; citations = s.citations || []; }
    } catch (e) { console.error("synthesize failed:", e.message); }
    const fill = synth?.company_fill || {};

    // name-collision filter + grounding
    const needles = buildNeedles({ domain, application });
    const { relevant, discarded } = splitCitations(citations, needles);
    const { flags, dropped } = filterFlags(synth?.adverse_media?.flags, citations);
    const principal_screening = cleanScreening(synth?.principal_screening, citations);
    const allFlags = foldScreeningIntoFlags(flags, principal_screening);

    // entity + consistency + gates + guards
    const entity = mergeEntity({ registry, claude: synth?.entity_verification, citations, application });
    const mismatches = mergeMismatches([...detMismatches, ...entityMismatches({ entity, application })], synth?.consistency_check?.mismatches);
    const gates = evaluateGates({ application, site: sc.site, mismatches, entity, synthOk: !!synth });
    const guarded = applyGuards({ synth, gates, mismatches, signals: sc.signals, application });
    const confidence = computeConfidence({
      synthOk: !!synth, site: sc.site, trafficVisits: sw?.visits ?? null, entity, application,
      relevantSources: relevant.length, principalsScreened: principal_screening.some((p) => p.type === "principal"), mismatches,
    });

    const regDate = di?.age?.created ? String(di.age.created).slice(0, 10) : null;
    const entityLine = entity?.verified
      ? [entity.jurisdiction, entity.registry_id, entity.formation_date && `formed ${String(entity.formation_date).slice(0, 10)}`, entity.status].filter(Boolean).join(" · ") + " (registry)"
      : null;

    const report = {
      company: {
        name: entity?.verified && entity.legal_name ? entity.legal_name : hu?.company?.name || hu?.org || application?.legal_name || head,
        domain,
        hq: hu?.company?.hq || fill.hq || "",
        founded: entityLine || fill.founded || hu?.company?.founded || (regDate ? `Domain reg. ${regDate}` : ""),
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
        tech_signals: bw?.tech?.length ? bw.tech : sc.site.platform ? [sc.site.platform] : [],
        notable: sw?.rank ? `SimilarWeb global rank #${num(sw.rank)}` : "",
      },
      infrastructure: {
        domain_age: di?.age?.age ? `${di.age.age}${regDate ? ` (registered ${regDate})` : ""}` : regDate || "",
        registrar: di?.age?.registrar || "",
        dns_provider: nsProvider(di?.dns?.ns) || "",
        email_provider: mxProvider(di?.dns?.mx) || "",
        hosting: sc.http?.server || di?.dns?.ptr || "",
        cdn: sc.http?.cdn || "",
        ssl_issuer: di?.ssl?.issuer || "",
        ssl_expiry: di?.ssl?.valid_to || "",
        spf: di?.dns?.spf ? "present" : di?.dns?.txt ? "none" : "",
      },
      digital_presence: { social: hu?.social || [], app_presence: fill.app_presence || "" },
      payment_risk: guarded.payment_risk,
      boardability: guarded.boardability,
      corepay_fit: guarded.corepay_fit,
      adverse_media: {
        flags: allFlags,
        summary: synth?.adverse_media?.summary || "",
        regulatory: synth?.adverse_media?.regulatory || "",
        sources: relevant.slice(0, 12),
        sources_discarded: discarded.length,
        flags_discarded_similar_name: dropped,
      },
      outreach: {
        ...guarded.outreach,
        possible_contacts: guarded.outreach.suppressed
          ? guarded.outreach.possible_contacts
          : hu?.contacts?.length ? hu.contacts : guarded.outreach.possible_contacts || [],
      },

      // ---- new in v3 (frontend panels to be added; key points are also folded
      //      into boardability / corepay_fit / adverse_media above) ----
      site_check: { ...sc.site, signals: sc.signals },
      application: application,
      consistency: { mismatches, summary: synth?.consistency_check?.summary || "" },
      gates,
      entity_verification: entity,
      principal_screening,
      guard_adjustments: guarded.adjustments,
      confidence_detail: confidence,

      sources: [swHas && "SimilarWeb", bwHas && "BuiltWith", hu && "Hunter", di && "Domain/DNS", "Site check", registry?.verified && "OpenCorporates", synth && "Claude+web"].filter(Boolean),
      confidence: confidence.level,
      _meta: {
        version: VERSION,
        resolved_domain: domain,
        cache: "miss",
        application_context: !!application,
        sources_used: { similarweb: swHas, builtwith: bwHas, hunter: !!hu, domain: !!di, site_check: true, opencorporates: !!registry?.verified, claude: !!synth },
      },
    };
    cacheSet(cacheKey, report);
    res.json(report);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "enrichment failed" });
  }
});

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    version: VERSION,
    token_required: !!DEAL_DESK_TOKEN,
    keys: { anthropic: !!ANTHROPIC_API_KEY, similarweb: !!SIMILARWEB_API_KEY, builtwith: !!BUILTWITH_API_KEY, hunter: !!HUNTER_API_KEY, opencorporates: !!OPENCORPORATES_API_TOKEN },
  })
);

if (process.env.NODE_ENV !== "test") app.listen(PORT, () => console.log(`Merchant Intel backend v${VERSION} on :${PORT}`));
export default app;
