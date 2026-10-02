// =============================================================================
// checks.js — Deal Desk v3 deterministic layer
// -----------------------------------------------------------------------------
// Everything in this file is pure (no network). It exists so that:
//   1. the application being underwritten (declared business) is compared with
//      what is actually observed online,
//   2. hard gates (site not live, entity unverified, declared-vs-observed
//      mismatch) can never be overridden by the Claude judgment layer,
//   3. name collisions are filtered before sources/flags reach the report,
//   4. confidence is calibrated from what was actually verified.
// Unit tests: checks.test.js  (npm test)
// =============================================================================

export const VERSION = "3.0.0";

// ---- generic helpers --------------------------------------------------------
export const norm = (s) =>
  String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

export function dedupeText(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr || []) {
    if (!s) continue;
    const k = norm(s).slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export function parseMoney(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).toLowerCase().replace(/usd|eur|gbp|[,$€£\s]/g, "").trim();
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}

const fmtUsd = (n) => (n == null ? "?" : "$" + Math.round(n).toLocaleString("en-US"));

// ---- domain / query parsing -------------------------------------------------
// Fixes the v2 bug where "https://example.com/" was passed through unchanged as
// the "domain", which silently broke DNS, RDAP, Hunter and the HTTP fetch.
export function cleanDomain(input) {
  let s = String(input || "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#\s]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

const KEY_ALIASES = {
  legal_name: ["entity", "legal", "legal_name", "company"],
  dba: ["dba"],
  entity_state: ["state", "inc_state", "jurisdiction"],
  incorporation_date: ["incorporated", "inc_date", "formed", "incorporation_date"],
  declared_vertical: ["vertical", "goods", "services", "type", "product", "business"],
  principals: ["principal", "principals", "owner", "owners", "ubo"],
  avg_ticket: ["ticket", "aov", "avg_ticket"],
  monthly_volume: ["volume", "monthly_volume", "vol"],
  monthly_txn_count: ["txns", "transactions", "count", "txn_count"],
  currencies: ["currency", "currencies"],
  current_processor: ["processor", "current_processor"],
  current_mcc: ["mcc"],
  previously_accepted_cards: ["history", "prior_processing", "accepted_cards"],
  referral_partner: ["referred", "referral", "partner", "iso"],
  linked_companies: ["linked", "linked_companies", "associated"],
  notes: ["notes", "note"],
};

// Top-bar syntax, so context works before the frontend gets dedicated fields:
//   inspire2shine.com | vertical: Travel Membership | volume: 140000 | ticket: 140
//   | txns: 1000 | entity: Inspire 2 Shine, LLC | state: FL
//   | principals: Ron and Adriana Sacka | linked: YTB; Vida Divina | referred: Marc Lefebvre
export function parseQuery(raw) {
  const parts = String(raw || "").split("|").map((s) => s.trim()).filter(Boolean);
  const head = parts.shift() || "";
  const app = {};
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i < 1) continue;
    const k = p.slice(0, i).trim().toLowerCase().replace(/[\s-]+/g, "_");
    const v = p.slice(i + 1).trim();
    for (const [field, aliases] of Object.entries(KEY_ALIASES)) {
      if (aliases.includes(k)) { app[field] = v; break; }
    }
  }
  return { head, application: Object.keys(app).length ? app : null };
}

export function splitPrincipals(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/;|\n/);
  const out = [];
  for (let item of arr) {
    item = String(item || "").trim();
    if (!item) continue;
    // "Ron and Adriana Sacka" -> "Ron Sacka", "Adriana Sacka"
    const m = item.match(/^([\p{L}'.-]+)\s+(?:and|&)\s+([\p{L}'.-]+)\s+([\p{L}'.\- ]+)$/iu);
    if (m) { out.push(`${m[1]} ${m[3]}`.trim(), `${m[2]} ${m[3]}`.trim()); continue; }
    out.push(...item.split(/\s+(?:and|&)\s+|,\s*/i).map((s) => s.trim()).filter(Boolean));
  }
  return uniq(out);
}

const splitList = (v) =>
  !v ? [] : uniq((Array.isArray(v) ? v : String(v).split(/;|\n|,/)).map((s) => String(s).trim()));

export function normalizeApplication(a) {
  if (!a || typeof a !== "object") return null;
  const n = {
    legal_name: a.legal_name || a.entity || null,
    dba: a.dba || null,
    entity_state: a.entity_state || a.state || null,
    incorporation_date: a.incorporation_date || null,
    declared_vertical: a.declared_vertical || a.vertical || null,
    principals: splitPrincipals(a.principals),
    avg_ticket: parseMoney(a.avg_ticket),
    monthly_volume: parseMoney(a.monthly_volume),
    monthly_txn_count: parseMoney(a.monthly_txn_count),
    currencies: a.currencies || null,
    current_processor: a.current_processor || null,
    current_mcc: a.current_mcc || null,
    previously_accepted_cards: toBool(a.previously_accepted_cards),
    referral_partner: a.referral_partner || null,
    linked_companies: splitList(a.linked_companies),
    notes: a.notes || null,
  };
  const has = Object.values(n).some((v) => (Array.isArray(v) ? v.length : v != null));
  return has ? n : null;
}

const LEGAL_SUFFIX = /\b(l\.?l\.?c|inc|incorporated|corp|corporation|co|company|ltd|limited|gmbh|b\.?v|s\.?r\.?o|plc|s\.?a|srl|oy|ab|ag|pte|pty|sia|ou|oü|llp|lp)\b\.?/giu;
export const coreName = (s) => norm(String(s || "").replace(LEGAL_SUFFIX, " "));

const US_STATES = { AL:"alabama",AK:"alaska",AZ:"arizona",AR:"arkansas",CA:"california",CO:"colorado",CT:"connecticut",DE:"delaware",DC:"district of columbia",FL:"florida",GA:"georgia",HI:"hawaii",ID:"idaho",IL:"illinois",IN:"indiana",IA:"iowa",KS:"kansas",KY:"kentucky",LA:"louisiana",ME:"maine",MD:"maryland",MA:"massachusetts",MI:"michigan",MN:"minnesota",MS:"mississippi",MO:"missouri",MT:"montana",NE:"nebraska",NV:"nevada",NH:"new hampshire",NJ:"new jersey",NM:"new mexico",NY:"new york",NC:"north carolina",ND:"north dakota",OH:"ohio",OK:"oklahoma",OR:"oregon",PA:"pennsylvania",RI:"rhode island",SC:"south carolina",SD:"south dakota",TN:"tennessee",TX:"texas",UT:"utah",VT:"vermont",VA:"virginia",WA:"washington",WV:"west virginia",WI:"wisconsin",WY:"wyoming" };
export function stateToJurisdiction(state) {
  if (!state) return null;
  const s = String(state).trim();
  if (/^[a-z]{2}$/i.test(s) && US_STATES[s.toUpperCase()]) return "us_" + s.toLowerCase();
  const hit = Object.entries(US_STATES).find(([, name]) => name === s.toLowerCase());
  return hit ? "us_" + hit[0].toLowerCase() : null;
}

// ---- HTML helpers -----------------------------------------------------------
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function htmlTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : "";
}
export function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) && out.length < 400) {
    try {
      const href = new URL(m[1], baseUrl).toString();
      if (!/^https?:/i.test(href)) continue;
      out.push({ href, text: htmlToText(m[2]).slice(0, 80) });
    } catch {}
  }
  return out;
}
export function detectPlatform(html) {
  const h = String(html || "");
  if (/cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i.test(h)) return "Shopify";
  if (/woocommerce/i.test(h)) return "WooCommerce";
  if (/wixstatic\.com|_wixCIDX|wix-code/i.test(h)) return "Wix";
  if (/squarespace\.com|static1\.squarespace/i.test(h)) return "Squarespace";
  if (/bigcommerce/i.test(h)) return "BigCommerce";
  if (/webflow\.(com|io)/i.test(h)) return "Webflow";
  if (/wp-content|wp-includes/i.test(h)) return "WordPress";
  return null;
}

const POLICY_PATTERNS = {
  refund: /refund|return/i,
  terms: /terms|conditions|tos\b/i,
  privacy: /privacy/i,
  cancellation: /cancel/i,
  shipping: /shipping|delivery/i,
  contact: /contact|support/i,
};
export function policyLinks(links) {
  const out = {};
  for (const [k, re] of Object.entries(POLICY_PATTERNS)) {
    const hit = (links || []).find((l) => re.test(l.text) || re.test(new URL(l.href).pathname));
    out[k] = hit ? hit.href : null;
  }
  return out;
}

const FOLLOW_RE = /affiliate|opportunit|compensation|income-?disclosure|join|membership|pricing|plans|about|how-it-works|back-?office|travel|become/i;
export function pickFollowLinks(links, domain, max = 4) {
  const out = [];
  for (const l of links || []) {
    let u;
    try { u = new URL(l.href); } catch { continue; }
    const host = u.hostname.replace(/^www\./, "");
    if (!(host === domain || host.endsWith("." + domain))) continue;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|css|js|ico)$/i.test(u.pathname)) continue;
    if (u.pathname === "/" || u.pathname === "") continue;
    if (!(FOLLOW_RE.test(u.pathname) || FOLLOW_RE.test(l.text))) continue;
    const key = u.origin + u.pathname;
    if (out.includes(key)) continue;
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

// ---- site status classification (hard gate input) ---------------------------
export const GATING_STATUSES = new Set([
  "unreachable", "maintenance", "password_protected", "coming_soon", "parked", "suspended", "not_found", "server_error",
]);
const RE_BLOCK = /cf-browser-verification|challenge-platform|just a moment\.\.\.|attention required! \| cloudflare|verify you are human|captcha|access denied/i;
const RE_PASSWORD = /template-password|enter (the )?store using password|password-page|this store is password protected/i;
const RE_PARKED = /domain (is )?for sale|buy this domain|parked free|sedoparking|this domain may be for sale|domain has expired/i;
const RE_SUSPENDED = /account (has been )?suspended|(site|website) has been suspended|this store (is )?(currently )?unavailable|this store does not exist|shop is currently unavailable/i;
const RE_MAINT = /under maintenance|down for maintenance|scheduled maintenance|maintenance mode|we['’]?ll be back soon|site is being updated/i;
const RE_COMING = /coming soon|launching soon|under construction|opening soon/i;

function snippet(text, re) {
  const m = String(text || "").match(re);
  if (!m) return null;
  const i = Math.max(0, m.index - 40);
  return text.slice(i, m.index + m[0].length + 40).trim();
}

export function classifySite({ inputDomain, httpStatus, finalUrl, html, error }) {
  const base = { status: "live", http_status: httpStatus ?? null, final_url: finalUrl || null, title: null, evidence: null, redirect_off_domain: false, text_length: 0 };
  if (error || httpStatus == null) {
    return { ...base, status: "unreachable", evidence: String(error || "no response").slice(0, 160), gating: true };
  }
  const text = htmlToText(html);
  const title = htmlTitle(html);
  const hay = `${title} ${text.slice(0, 5000)}`;
  const raw = String(html || "").slice(0, 300000);
  const thin = text.length < 1500;
  const res = { ...base, title, text_length: text.length };

  const finalHost = cleanDomain(finalUrl || "");
  if (finalHost && inputDomain && !(finalHost === inputDomain || finalHost.endsWith("." + inputDomain) || inputDomain.endsWith("." + finalHost))) {
    res.redirect_off_domain = true;
  }
  let path = "";
  try { path = new URL(finalUrl).pathname; } catch {}

  const set = (status, ev) => ({ ...res, status, evidence: ev || null, gating: GATING_STATUSES.has(status) });

  if (RE_BLOCK.test(raw) && ([403, 429, 503].includes(httpStatus) || thin)) return set("blocked", snippet(hay, RE_BLOCK) || `HTTP ${httpStatus}`);
  if (/^\/password\/?$/.test(path) || RE_PASSWORD.test(raw)) return set("password_protected", snippet(hay, RE_PASSWORD) || path);
  if (RE_PARKED.test(hay)) return set("parked", snippet(hay, RE_PARKED));
  if (RE_SUSPENDED.test(hay) && thin) return set("suspended", snippet(hay, RE_SUSPENDED));
  if (RE_MAINT.test(hay) && (thin || httpStatus === 503)) return set("maintenance", snippet(hay, RE_MAINT));
  if (RE_COMING.test(hay) && thin) return set("coming_soon", snippet(hay, RE_COMING));
  if (httpStatus === 404 || httpStatus === 410) return set("not_found", `HTTP ${httpStatus}`);
  if (httpStatus === 401) return set("password_protected", "HTTP 401");
  if (httpStatus === 403 || httpStatus === 429) return set("blocked", `HTTP ${httpStatus}`);
  if (httpStatus >= 500) return set("server_error", `HTTP ${httpStatus}`);
  return set("live", null);
}

// ---- content signal families --------------------------------------------------
// strong = 2 points, weak = 1 point. Families with score >= 2 count as "observed".
const FAMILIES = {
  affiliate_mlm: {
    strong: [/back[\s-]?office/i, /compensation plan|comp plan/i, /income disclosure/i, /\bdownline\b/i, /rank advancement/i, /\b(binary|unilevel|matrix) (plan|compensation)/i, /independent business owner/i, /business opportunity/i, /residual income/i],
    weak: [/\baffiliates?\b/i, /\bambassadors?\b/i, /\bdistributors?\b/i, /become an? (affiliate|ambassador|partner)/i, /join (our|the) team/i, /earn commissions?/i, /refer (and|&) earn/i],
  },
  recurring_billing: {
    strong: [/auto[\s-]?renew/i, /recurring (billing|charge|payment)/i, /free trial/i, /billed (monthly|annually|yearly)/i],
    weak: [/subscription/i, /\bmembership\b/i, /cancel any ?time/i, /per month|\/\s?mo\b/i],
  },
  travel: {
    strong: [/booking engine/i, /travel club/i, /vacation club/i, /discount(ed)? travel/i, /wholesale travel/i, /travel membership/i],
    weak: [/\btravel\b/i, /vacations?\b/i, /\bresorts?\b/i, /\bcruises?\b/i, /\bhotels?\b/i, /\bflights?\b/i],
  },
  jewelry_fashion: {
    strong: [/gold[\s-]?(plated|filled)/i, /\bjewel(le)?ry\b/i, /\bnecklaces?\b/i, /\bbracelets?\b/i, /\bearrings?\b/i],
    weak: [/\baccessories\b/i, /\brings?\b/i, /\bpendants?\b/i, /\bhoops?\b/i],
  },
  nutra: {
    strong: [/dietary supplement/i, /nutraceutical/i, /weight loss (pill|supplement|formula)/i],
    weak: [/\bsupplements?\b/i, /\bcapsules?\b/i, /\bgummies\b/i, /\bdetox\b/i],
  },
  telehealth_pharma: {
    strong: [/telehealth|telemedicine/i, /\bprescription\b/i, /\bglp-?1\b/i, /semaglutide|tirzepatide/i, /online pharmacy/i],
    weak: [/\bpharmacy\b/i, /\bclinician\b/i, /\bprovider\b/i],
  },
  peptides: { strong: [/research use only/i, /\bpeptides?\b/i, /\bbpc-?157\b/i], weak: [/certificate of analysis|\bcoa\b/i] },
  crypto_trading: { strong: [/\bcrypto(currency)?\b/i, /prop(rietary)? trading/i, /\bforex\b/i], weak: [/\btrading\b/i, /\bbitcoin\b/i] },
  gambling: { strong: [/\bcasino\b/i, /sports ?betting/i, /\bsweepstakes\b/i], weak: [/\bslots\b/i, /\bwager/i] },
  adult: { strong: [/\badult content\b/i, /\b18\+/i, /\bnsfw\b/i, /2257/i], weak: [/\bexplicit\b/i] },
  dating: { strong: [/\bdating\b/i, /hook ?up/i], weak: [/\bsingles\b/i, /\bmatches\b/i] },
  ai_generation: { strong: [/ai (companion|girlfriend|image generator|video generator)/i, /face ?swap/i], weak: [/\bai[- ]generated\b/i, /\bgenerate\b/i] },
};
const CONTENT_FAMILIES = ["travel", "jewelry_fashion", "nutra", "telehealth_pharma", "peptides", "crypto_trading", "gambling", "adult", "dating", "ai_generation"];

export function scanSignals(texts) {
  const joined = (texts || []).join(" \n ").slice(0, 400000);
  const out = {};
  for (const [fam, { strong, weak }] of Object.entries(FAMILIES)) {
    const s = uniq(strong.map((re) => (joined.match(re) || [])[0]?.toLowerCase()));
    const w = uniq(weak.map((re) => (joined.match(re) || [])[0]?.toLowerCase()));
    const score = s.length * 2 + w.length;
    if (score) out[fam] = { score, strong: s.slice(0, 6), weak: w.slice(0, 6) };
  }
  return out;
}
export const observedFamilies = (signals, min = 2) =>
  CONTENT_FAMILIES.filter((f) => (signals?.[f]?.score || 0) >= min);

// ---- relevance / name-collision filter ----------------------------------------
export function buildNeedles({ domain, application }) {
  const long = new Set();
  const short = new Set();
  const add = (s) => {
    const n = norm(s);
    if (n.length >= 5) long.add(n);
    else if (n.length >= 3) short.add(String(s).trim().toLowerCase());
  };
  if (domain) { long.add(norm(domain)); add(domain.split(".")[0]); }
  if (application) {
    add(coreName(application.legal_name));
    add(coreName(application.dba));
    for (const p of application.principals || []) { const n = norm(p); if (n.length >= 6) long.add(n); }
    for (const c of application.linked_companies || []) add(c);
  }
  return { long: [...long], short: [...short] };
}

export function matchNeedle(text, needles) {
  const raw = String(text || "").toLowerCase();
  const n = norm(text);
  for (const x of needles.long) if (n.includes(x)) return x;
  for (const x of needles.short) {
    const esc = x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(raw)) return x;
  }
  return null;
}

export function splitCitations(citations, needles) {
  const relevant = [];
  const discarded = [];
  for (const c of citations || []) {
    const hit = matchNeedle(`${c.title} ${c.url}`, needles);
    (hit ? relevant : discarded).push(hit ? { ...c, matched: hit } : c);
  }
  return { relevant, discarded };
}

const normUrl = (u) => {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "")).toLowerCase(); } catch { return null; }
};
const ALLOWED_BASIS = new Set(["domain", "legal_name", "dba", "principal", "linked_company", "registry"]);
const SEVERITIES = new Set(["high", "medium", "low"]);

export function filterFlags(flags, citations) {
  const cited = new Set((citations || []).map((c) => normUrl(c.url)).filter(Boolean));
  const kept = [];
  let dropped = 0;
  for (const f of Array.isArray(flags) ? flags : []) {
    if (!f || !f.claim) continue;
    const basis = String(f.match_basis || "").toLowerCase();
    if (!ALLOWED_BASIS.has(basis)) { dropped++; continue; }
    const u = f.url && cited.has(normUrl(f.url)) ? f.url : "";
    kept.push({
      claim: f.subject && !String(f.claim).startsWith("[") ? `[${f.subject}] ${f.claim}` : f.claim,
      url: u,
      subject: f.subject || "",
      match_basis: basis,
      severity: SEVERITIES.has(f.severity) ? f.severity : "medium",
      url_verified: !!u,
    });
  }
  return { flags: kept, dropped };
}

export function cleanScreening(list, citations) {
  const cited = new Set((citations || []).map((c) => normUrl(c.url)).filter(Boolean));
  return (Array.isArray(list) ? list : []).filter((x) => x && x.subject).map((x) => ({
    subject: x.subject,
    type: x.type === "linked_company" ? "linked_company" : "principal",
    summary: x.summary || "",
    findings: (Array.isArray(x.findings) ? x.findings : []).filter((f) => f && f.claim).map((f) => {
      const u = f.url && cited.has(normUrl(f.url)) ? f.url : "";
      return { claim: f.claim, severity: SEVERITIES.has(f.severity) ? f.severity : "medium", url: u, url_verified: !!u };
    }),
  }));
}

// Material screening findings are folded into adverse_media.flags so the
// existing frontend renders them without changes.
export function foldScreeningIntoFlags(flags, screening) {
  const out = [...flags];
  const seen = new Set(out.map((f) => norm(f.claim).slice(0, 60)));
  for (const s of screening) {
    for (const f of s.findings) {
      if (f.severity === "low") continue;
      const claim = `[${s.subject}] ${f.claim}`;
      const k = norm(claim).slice(0, 60);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ claim, url: f.url, subject: s.subject, match_basis: s.type, severity: f.severity, url_verified: f.url_verified });
    }
  }
  return out;
}

// ---- entity verification --------------------------------------------------------
export function mergeEntity({ registry, claude, citations, application }) {
  if (registry?.verified) return { ...registry };
  const cited = new Set((citations || []).map((c) => normUrl(c.url)).filter(Boolean));
  const c = claude || {};
  const grounded = !!(c.found && c.source_url && cited.has(normUrl(c.source_url)));
  const nameOk = !application?.legal_name || (c.legal_name && coreName(c.legal_name) === coreName(application.legal_name));
  return {
    verified: grounded && nameOk,
    source: grounded ? "Claude+web (registry record)" : registry?.source || null,
    legal_name: c.legal_name || null,
    registry_id: c.registry_id || null,
    jurisdiction: c.jurisdiction || null,
    status: c.status || null,
    formation_date: c.formation_date || null,
    officers: Array.isArray(c.officers) ? c.officers : [],
    registered_address_type: c.registered_address_type || "unknown",
    source_url: grounded ? c.source_url : "",
    note: !c.found ? "No registry record found" : !grounded ? "Registry claim not backed by a cited source" : !nameOk ? "Registry name does not match declared legal name" : null,
    registry_error: registry?.error || null,
  };
}

export function entityMismatches({ entity, application }) {
  const m = [];
  if (!application || !entity?.verified) return m;
  const officers = (entity.officers || []).map((o) => (typeof o === "string" ? o : o.name || "")).join(" ");
  if (officers && application.principals?.length) {
    const on = norm(officers);
    for (const p of application.principals) {
      const surname = norm(p.split(/\s+/).pop());
      if (surname.length >= 3 && !on.includes(surname)) {
        m.push({ field: "principal_not_in_registry", declared: p, observed: `registry officers: ${officers.slice(0, 120)}`, severity: "medium", note: "Declared principal not listed among registry officers/managers" });
      }
    }
  }
  if (application.incorporation_date && entity.formation_date) {
    const a = new Date(application.incorporation_date);
    const b = new Date(entity.formation_date);
    if (!isNaN(a) && !isNaN(b) && Math.abs(a - b) > 3 * 864e5) {
      m.push({ field: "incorporation_date", declared: application.incorporation_date, observed: entity.formation_date, severity: "medium", note: "Declared incorporation date differs from registry" });
    }
  }
  if (entity.status && !/active|good standing/i.test(entity.status)) {
    m.push({ field: "entity_status", declared: "active entity", observed: entity.status, severity: "high", note: "Registry status is not active" });
  }
  return m;
}

// ---- declared vs observed ---------------------------------------------------------
export function deterministicMismatches({ application, site, signals, trafficVisits, domainCreated }) {
  const m = [];
  if (!application) return m;
  const { avg_ticket: t, monthly_volume: v, monthly_txn_count: c } = application;

  if (t && v && c) {
    const implied = t * c;
    if (Math.abs(implied - v) / v > 0.2) {
      m.push({ field: "volume_math", declared: `${fmtUsd(v)}/mo`, observed: `${c.toLocaleString("en-US")} txns × ${fmtUsd(t)} = ${fmtUsd(implied)}`, severity: "medium", note: "Ticket × count does not reconcile with declared volume" });
    }
  }
  if (c && trafficVisits != null) {
    if (trafficVisits < c) m.push({ field: "traffic_vs_transactions", declared: `${c.toLocaleString("en-US")} txns/mo`, observed: `${trafficVisits.toLocaleString("en-US")} visits/mo`, severity: "high", note: "Fewer site visits than declared transactions" });
    else if (c / trafficVisits > 0.2) m.push({ field: "traffic_vs_transactions", declared: `${c.toLocaleString("en-US")} txns/mo`, observed: `${trafficVisits.toLocaleString("en-US")} visits/mo`, severity: "medium", note: "Implied conversion above 20% — confirm traffic source (affiliate/offline sales?)" });
  }
  if (site && GATING_STATUSES.has(site.status)) {
    m.push({ field: "website_status", declared: "processing URL live", observed: `site ${site.status}${site.evidence ? ` — "${site.evidence.slice(0, 90)}"` : ""}`, severity: "high", note: "Checkout, pricing, product and policies cannot be reviewed" });
  }
  if (site?.redirect_off_domain) {
    m.push({ field: "redirect", declared: "processing URL", observed: `redirects to ${site.final_url}`, severity: "medium", note: "Declared URL redirects to a different domain" });
  }
  if (application.declared_vertical && site?.status === "live") {
    const declared = observedFamilies(scanSignals([application.declared_vertical]), 1);
    const observed = observedFamilies(signals);
    const missing = declared.filter((f) => !observed.includes(f));
    if (declared.length && missing.length) {
      m.push({
        field: "vertical",
        declared: application.declared_vertical,
        observed: observed.length ? `site content signals: ${observed.join(", ")}` : "no matching product signals on site",
        severity: observed.length ? "high" : "medium",
        note: "Declared business not evidenced on the website",
      });
    }
  }
  if (signals?.affiliate_mlm?.strong?.length && application.declared_vertical && !/affiliat|mlm|network marketing|direct sell/i.test(`${application.declared_vertical} ${application.notes || ""}`)) {
    m.push({ field: "undisclosed_affiliate_model", declared: application.declared_vertical, observed: `site shows ${signals.affiliate_mlm.strong.join(", ")}`, severity: "medium", note: "Affiliate/MLM structure not disclosed on the application" });
  }
  if (application.previously_accepted_cards === true && domainCreated) {
    const ageDays = (Date.now() - new Date(domainCreated)) / 864e5;
    if (!isNaN(ageDays) && ageDays < 180) m.push({ field: "history_vs_domain_age", declared: "previously accepted cards", observed: `domain registered ${String(domainCreated).slice(0, 10)}`, severity: "medium", note: "Processing history claimed on a young domain — confirm which URL processed" });
  }
  return m;
}

const SEV_RANK = { low: 0, medium: 1, high: 2 };
export function mergeMismatches(det, claude) {
  const byField = new Map();
  const push = (x, origin) => {
    if (!x || !x.field) return;
    const field = String(x.field).toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const sev = SEVERITIES.has(x.severity) ? x.severity : "medium";
    const item = { field, declared: String(x.declared ?? ""), observed: String(x.observed ?? ""), severity: sev, note: x.note || "", origin };
    const prev = byField.get(field);
    if (!prev || SEV_RANK[sev] > SEV_RANK[prev.severity]) byField.set(field, prev && prev.origin !== origin ? { ...item, origin: "both" } : item);
  };
  (det || []).forEach((x) => push(x, "deterministic"));
  (Array.isArray(claude) ? claude : []).forEach((x) => push(x, "claude"));
  return [...byField.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}

// ---- gates ------------------------------------------------------------------------
export function evaluateGates({ application, site, mismatches, entity, synthOk }) {
  const g = [];
  if (site && GATING_STATUSES.has(site.status)) {
    g.push({ code: "SITE_NOT_LIVE", level: "blocking", message: `Website not live (${site.status.replace(/_/g, " ")}) — hold until the processing URL is live with product, pricing, checkout and policies reviewable` });
  } else if (site?.status === "blocked") {
    g.push({ code: "SITE_UNVERIFIED", level: "major", message: "Website blocks automated review — manual browser check required before underwriting" });
  }
  const high = (mismatches || []).filter((x) => x.severity === "high" && x.field !== "website_status");
  if (high.length) {
    g.push({ code: "DECLARED_VS_OBSERVED", level: "major", message: `Application does not match what is observed (${high.map((h) => h.field.replace(/_/g, " ")).join(", ")}) — written explanation required` });
  }
  if (application?.legal_name && !entity?.verified) {
    g.push({ code: "ENTITY_UNVERIFIED", level: "major", message: `Legal entity "${application.legal_name}" not verified against a registry` });
  }
  if (!synthOk) {
    g.push({ code: "NO_JUDGMENT_LAYER", level: "major", message: "Judgment layer failed — risk, fit and adverse media not assessed" });
  }
  return g;
}

// ---- scheme / risk guards -------------------------------------------------------------
export const VISA_HBR = {
  "5962": { label: "Direct Marketing – Travel-Related Arrangement Services", floor: "High" },
  "5966": { label: "Direct Marketing – Outbound Telemarketing", floor: "High" },
  "5967": { label: "Direct Marketing – Inbound Teleservices", floor: "High" },
  "7273": { label: "Dating Services", floor: "High" },
  "7995": { label: "Betting / Gambling", floor: "High" },
  "5122": { label: "Drugs, Drug Proprietaries (card-absent)", floor: "High" },
  "5912": { label: "Drug Stores / Pharmacies (card-absent)", floor: "High" },
  "5993": { label: "Cigar Stores (card-absent tobacco)", floor: "Medium" },
  "4816": { label: "Computer Network Services (cyberlockers only)", floor: "Medium" },
  "5816": { label: "Digital Goods – Games (skill games only)", floor: "Medium" },
};
const RISK_ORDER = ["Low", "Medium", "High", "Prohibited"];
const maxRisk = (a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a);

export function collectMccs(pr, application) {
  const text = [pr?.mcc_guess, ...(Array.isArray(pr?.mcc_candidates) ? pr.mcc_candidates.map((c) => c?.mcc) : []), application?.current_mcc].join(" ");
  return uniq(text.match(/\b\d{4}\b/g) || []);
}

export function buildRoutingHeader({ gates, mismatches, application, pr }) {
  const lines = [];
  if (gates.length) lines.push(`DEAL DESK GATES: ${gates.map((g) => `${g.code} (${g.level})`).join("; ")}`);
  if (application) {
    const d = [
      application.declared_vertical,
      application.monthly_volume != null && `${fmtUsd(application.monthly_volume)}/mo`,
      application.monthly_txn_count != null && `${application.monthly_txn_count.toLocaleString("en-US")} txns`,
      application.avg_ticket != null && `${fmtUsd(application.avg_ticket)} AOV`,
      application.principals?.length && `principals ${application.principals.join(", ")}`,
      application.referral_partner && `referred by ${application.referral_partner}`,
    ].filter(Boolean);
    if (d.length) lines.push(`DECLARED: ${d.join(" · ")}`);
  }
  const mm = (mismatches || []).filter((x) => x.severity !== "low");
  if (mm.length) lines.push(`MISMATCHES: ${mm.map((x) => `${x.field} (${x.severity})`).join("; ")}`);
  const codes = collectMccs(pr, application);
  lines.push(`RISK: ${pr.classification}${codes.length ? ` · MCC ${codes.join("/")}` : ""}`);
  return lines.join("\n");
}

export function applyGuards({ synth, gates, mismatches, signals, application }) {
  const pr = { classification: "Medium", mcc_guess: "", mcc_candidates: [], vertical_flags: [], chargeback_risk: "", rationale: "", ...(synth?.payment_risk || {}) };
  const bd = { verdict: "", rationale: "", conditions: [], routing_note: "", ...(synth?.boardability || {}) };
  const fit = { score: 0, verdict: "Not scored", reasons: [], watchouts: [], ...(synth?.corepay_fit || {}) };
  let outreach = { angle: "", possible_contacts: [], ...(synth?.outreach || {}) };
  for (const k of ["vertical_flags"]) pr[k] = Array.isArray(pr[k]) ? pr[k] : [];
  if (!Array.isArray(pr.mcc_candidates)) pr.mcc_candidates = [];
  bd.conditions = Array.isArray(bd.conditions) ? bd.conditions : [];
  fit.reasons = Array.isArray(fit.reasons) ? fit.reasons : [];
  fit.watchouts = Array.isArray(fit.watchouts) ? fit.watchouts : [];
  if (!RISK_ORDER.includes(pr.classification)) pr.classification = "Medium";
  if (typeof fit.score !== "number") fit.score = Number(fit.score) || 0;

  const adjustments = [];
  const addFlag = (s) => pr.vertical_flags.push(s);

  // 1. Scheme registration floors
  let floor = "Low";
  const codes = collectMccs(pr, application);
  const hbr = codes.filter((c) => VISA_HBR[c]).map((c) => ({ mcc: c, ...VISA_HBR[c] }));
  for (const h of hbr) {
    floor = maxRisk(floor, h.floor);
    addFlag(`Visa high-brand-risk MCC ${h.mcc} (${h.label}) — registration required if coded here`);
  }
  pr.scheme_registration = hbr.map((h) => ({ mcc: h.mcc, program: "Visa High-Brand Risk registration", label: h.label, note: "Confirm Mastercard registration requirements for the final MCC" }));

  // 2. Affiliate / MLM and recurring billing signals
  const mlm = signals?.affiliate_mlm;
  if (mlm?.strong?.length) {
    floor = maxRisk(floor, "Medium");
    addFlag(`Affiliate/MLM signals on site (${mlm.strong.slice(0, 3).join(", ")}) — review comp plan, income disclosure, earnings claims`);
  } else if (mlm?.weak?.length) {
    addFlag(`Affiliate program signals (${mlm.weak.slice(0, 3).join(", ")}) — confirm commission structure`);
  }
  if (signals?.recurring_billing?.strong?.length) {
    addFlag(`Recurring-billing signals (${signals.recurring_billing.strong.slice(0, 3).join(", ")}) — verify cancellation flow and dispute exposure`);
  }

  // 3. Declared-vs-observed mismatch floor
  if ((mismatches || []).some((x) => x.severity === "high" && x.field !== "website_status")) floor = maxRisk(floor, "Medium");

  if (pr.classification !== "Prohibited" && RISK_ORDER.indexOf(floor) > RISK_ORDER.indexOf(pr.classification)) {
    adjustments.push(`risk ${pr.classification} → ${floor}`);
    pr.classification = floor;
  }
  pr.vertical_flags = dedupeText(pr.vertical_flags).slice(0, 8);

  // 4. Verdict guards
  const blocking = gates.filter((g) => g.level === "blocking");
  const major = gates.filter((g) => g.level === "major");
  const original = bd.verdict;
  if (bd.verdict !== "DECLINE") {
    if (blocking.length) bd.verdict = "HOLD";
    else if (gates.some((g) => g.code === "DECLARED_VS_OBSERVED") && ["PRE-CHECK PASS", "CONDITIONAL", ""].includes(bd.verdict)) bd.verdict = "ESCALATE";
    else if (major.length && ["PRE-CHECK PASS", ""].includes(bd.verdict)) bd.verdict = "CONDITIONAL";
  }
  if (bd.verdict !== original) adjustments.push(`verdict ${original || "none"} → ${bd.verdict}`);

  // 5. Conditions & watchouts led by gates and mismatches
  const gateConds = gates.map((g) => `${g.level === "blocking" ? "BLOCKING" : "REQUIRED"}: ${g.message}`);
  const mmConds = (mismatches || [])
    .filter((x) => x.severity !== "low" && x.field !== "website_status")
    .map((x) => `Explain ${x.field.replace(/_/g, " ")}: declared "${x.declared}" vs observed "${x.observed}"`);
  bd.conditions = dedupeText([...gateConds, ...mmConds, ...bd.conditions]).slice(0, 12);
  fit.watchouts = dedupeText([...gates.map((g) => g.message), ...fit.watchouts]).slice(0, 8);

  // 6. Fit cap
  const cap = blocking.length ? 40 : major.length ? 65 : 100;
  if (fit.score > cap) { adjustments.push(`fit ${fit.score} → ${cap}`); fit.score = cap; }
  if (gates.length) fit.verdict = bd.verdict;

  // 7. Partner-referred files: no direct outreach
  if (application?.referral_partner) {
    outreach = {
      angle: `Referred by ${application.referral_partner} — route all merchant communication through the partner; no direct outreach.`,
      possible_contacts: [`Via referral partner: ${application.referral_partner}`],
      suppressed: true,
    };
  }

  // 8. Routing note header (deterministic, cannot be softened by the model)
  bd.routing_note = [buildRoutingHeader({ gates, mismatches, application, pr }), bd.routing_note].filter(Boolean).join("\n");
  if (adjustments.length) bd.rationale = `${bd.rationale ? bd.rationale + " " : ""}[Deal Desk guards applied: ${adjustments.join("; ")}]`;

  return { payment_risk: pr, boardability: bd, corepay_fit: fit, outreach, adjustments };
}

// ---- confidence calibration ------------------------------------------------------------
export function computeConfidence({ synthOk, site, trafficVisits, entity, application, relevantSources, principalsScreened, mismatches }) {
  let score = 100;
  const reasons = [];
  const dock = (n, r) => { score -= n; reasons.push(r); };
  if (!synthOk) dock(40, "Judgment layer failed");
  if (!site || site.status === "unreachable") dock(15, "Website could not be fetched");
  else if (GATING_STATUSES.has(site.status)) dock(20, `Website not live (${site.status.replace(/_/g, " ")}) — product, pricing and policies unreviewed`);
  else if (site.status === "blocked") dock(15, "Website blocks automated review");
  if (trafficVisits == null) dock(10, "No traffic data");
  if (!entity?.verified) dock(application?.legal_name ? 15 : 10, application?.legal_name ? "Declared legal entity not verified" : "No legal entity identified");
  if (!application) dock(10, "Domain-only scan — no application context, declared-vs-observed checks skipped");
  else if (application.principals?.length && !principalsScreened) dock(10, "Principals named but not screened");
  if ((relevantSources || 0) < 2) dock(10, `Only ${relevantSources || 0} source(s) directly about this merchant`);
  if ((mismatches || []).some((x) => x.severity === "high")) dock(10, "High-severity inconsistencies unresolved");
  score = Math.max(0, score);
  return { level: score >= 75 ? "high" : score >= 45 ? "medium" : "low", score, reasons };
}
