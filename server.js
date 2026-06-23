// =============================================================================
// Merchant Intel backend
// -----------------------------------------------------------------------------
// POST /api/enrich  { query, region }  -> unified intel report
//
// Data sources:
//   - Clearbit Autocomplete (free, no key)  -> resolve company name -> domain
//   - SimilarWeb REST API                    -> traffic, geo, channels, rank
//   - BuiltWith Domain API v21               -> tech stack fingerprint
//   - Hunter.io v2                           -> contacts + company enrichment
//   - Anthropic (Claude)                     -> risk classification, deal fit,
//                                               business-model + outreach synthesis
//
// Every vendor call is wrapped so that one failing key/tier never kills the
// response. _meta.sources_used tells the frontend which sources actually fired.
// Requires Node >= 18 (global fetch).
// =============================================================================

import express from "express";
import cors from "cors";
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
app.use(
  cors({
    origin: ALLOWED_ORIGINS === "*" ? true : ALLOWED_ORIGINS.split(",").map((s) => s.trim()),
  })
);

// ---- helpers ---------------------------------------------------------------
const ok = (r) => r && r.ok;
const num = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : null);

function trafficTier(v) {
  if (v == null) return "unknown";
  if (v >= 50e6) return "Very high (50M+/mo)";
  if (v >= 10e6) return "High (10–50M/mo)";
  if (v >= 1e6) return "Mid (1–10M/mo)";
  if (v >= 1e5) return "Low-mid (100K–1M/mo)";
  if (v >= 1e4) return "Low (10–100K/mo)";
  return "Minimal (<10K/mo)";
}

// SimilarWeb geo endpoint returns numeric ISO-3166 codes. Compact map of the
// ones you'll see most; unknown codes fall back to "Country <code>".
const ISO = {
  4:"Afghanistan",32:"Argentina",36:"Australia",40:"Austria",56:"Belgium",76:"Brazil",
  100:"Bulgaria",124:"Canada",152:"Chile",156:"China",170:"Colombia",191:"Croatia",
  196:"Cyprus",203:"Czechia",208:"Denmark",233:"Estonia",246:"Finland",250:"France",
  276:"Germany",300:"Greece",344:"Hong Kong",348:"Hungary",356:"India",360:"Indonesia",
  372:"Ireland",376:"Israel",380:"Italy",392:"Japan",410:"South Korea",428:"Latvia",
  440:"Lithuania",442:"Luxembourg",458:"Malaysia",484:"Mexico",528:"Netherlands",
  554:"New Zealand",578:"Norway",586:"Pakistan",604:"Peru",608:"Philippines",616:"Poland",
  620:"Portugal",642:"Romania",643:"Russia",682:"Saudi Arabia",688:"Serbia",702:"Singapore",
  703:"Slovakia",705:"Slovenia",710:"South Africa",724:"Spain",752:"Sweden",756:"Switzerland",
  764:"Thailand",792:"Turkey",804:"Ukraine",784:"UAE",826:"United Kingdom",840:"United States",
  704:"Vietnam",
};
const countryName = (code) => ISO[code] || `Country ${code}`;

// last 3 complete months, formatted YYYY-MM (SimilarWeb data lags ~1 month)
function dateWindow() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
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

// ---- 1. resolve name -> domain --------------------------------------------
async function resolveDomain(query) {
  const q = query.trim();
  // already a domain?
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(q) && !q.includes(" ")) {
    return q.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  }
  // Clearbit autocomplete is free and keyless
  try {
    const arr = await jsonFetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`
    );
    if (Array.isArray(arr) && arr[0]?.domain) return arr[0].domain.toLowerCase();
  } catch {
    /* fall through */
  }
  return q; // let downstream handle a best-effort string
}

// ---- 2. SimilarWeb ---------------------------------------------------------
async function similarweb(domain) {
  if (!SIMILARWEB_API_KEY) return null;
  const { start, end } = dateWindow();
  const SW = "https://api.similarweb.com/v1/website";
  const base = `api_key=${SIMILARWEB_API_KEY}&format=json&main_domain_only=false`;
  const out = {};

  // visits (monthly)  -> response: { visits: [{ date, visits }] }
  try {
    const j = await jsonFetch(
      `${SW}/${domain}/total-traffic-and-engagement/visits?${base}&start_date=${start}&end_date=${end}&country=world&granularity=monthly`
    );
    const series = j.visits || [];
    out.visits = series.length ? series[series.length - 1].visits : null;
  } catch {}

  // geography  -> response: { records: [{ country, share }] } (country = ISO numeric)
  try {
    const j = await jsonFetch(
      `${SW}/${domain}/geo/traffic-by-country?${base}&start_date=${start}&end_date=${end}`
    );
    const recs = j.records || [];
    out.geo = recs
      .sort((a, b) => b.share - a.share)
      .slice(0, 4)
      .map((r) => `${countryName(r.country)} (${Math.round(r.share * 100)}%)`);
  } catch {}

  // traffic sources  -> tolerant parse of overview-share
  try {
    const j = await jsonFetch(
      `${SW}/${domain}/traffic-sources/overview-share?${base}&start_date=${start}&end_date=${end}&country=world&granularity=monthly`
    );
    const arr =
      j.visits || j.overview || j.records || (Array.isArray(j) ? j : []);
    out.channels = (arr || [])
      .map((x) => {
        const label = x.source_type || x.source || x.channel || x.name;
        const share = x.share ?? x.value;
        return label && share != null
          ? `${label} (${Math.round(share * 100)}%)`
          : null;
      })
      .filter(Boolean)
      .slice(0, 5);
  } catch {}

  // global rank  -> response: { global_rank: { rank } } or { rank }
  try {
    const j = await jsonFetch(`${SW}/${domain}/global-rank/global-rank?${base}`);
    out.rank = j.global_rank?.rank ?? j.rank ?? null;
  } catch {}

  return out;
}

// ---- 3. BuiltWith ----------------------------------------------------------
async function builtwith(domain) {
  if (!BUILTWITH_API_KEY) return null;
  try {
    const j = await jsonFetch(
      `https://api.builtwith.com/v21/api.json?KEY=${BUILTWITH_API_KEY}&LOOKUP=${domain}`
    );
    const paths = j.Results?.[0]?.Result?.Paths || [];
    const names = new Set();
    // surface the commercially interesting tags first
    const priorityTags = new Set([
      "payment", "analytics", "ecommerce", "framework", "cms", "javascript",
      "cdn", "hosting", "ssl", "tag-management", "advertising", "widgets",
    ]);
    const priority = [];
    const rest = [];
    for (const p of paths) {
      for (const t of p.Technologies || []) {
        if (!t.Name || names.has(t.Name)) continue;
        names.add(t.Name);
        const tag = (t.Tag || "").toLowerCase();
        (priorityTags.has(tag) ? priority : rest).push(t.Name);
      }
    }
    return { tech: [...priority, ...rest].slice(0, 10) };
  } catch {
    return null;
  }
}

// ---- 4. Hunter -------------------------------------------------------------
async function hunter(domain) {
  if (!HUNTER_API_KEY) return null;
  const out = {};
  // contacts
  try {
    const j = await jsonFetch(
      `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${HUNTER_API_KEY}&limit=10`
    );
    out.contacts = (j.data?.emails || [])
      .filter((e) => e.first_name || e.position)
      .slice(0, 5)
      .map((e) => {
        const name = [e.first_name, e.last_name].filter(Boolean).join(" ");
        return [name, e.position, e.value].filter(Boolean).join(" — ");
      });
    out.org = j.data?.organization || null;
  } catch {}
  // company enrichment
  try {
    const j = await jsonFetch(
      `https://api.hunter.io/v2/companies/find?domain=${domain}&api_key=${HUNTER_API_KEY}`
    );
    const d = j.data || {};
    out.company = {
      name: d.name || out.org || null,
      industry: d.category?.industry || null,
      employees: d.metrics?.employees || d.metrics?.employeesRange || null,
      founded: d.foundedYear ? String(d.foundedYear) : null,
      hq: [d.geo?.city, d.geo?.state, d.geo?.country].filter(Boolean).join(", ") || null,
      description: d.description || null,
    };
    out.social = [
      d.twitter && `Twitter/X @${d.twitter}`,
      d.linkedin && `LinkedIn: ${d.linkedin}`,
      d.facebook && `Facebook: ${d.facebook}`,
      d.instagram && `Instagram @${d.instagram}`,
      d.youtube && `YouTube: ${d.youtube}`,
    ].filter(Boolean);
  } catch {}
  return out;
}

// ---- 5. Claude judgment layer ---------------------------------------------
// Given the real vendor data, produce ONLY the things vendors can't sell:
// business model, payment-risk classification, Corepay/Dispu fit, outreach.
async function synthesize({ query, region, domain, vendor }) {
  if (!ANTHROPIC_API_KEY) {
    return {
      business_model: { type: "", monetization: "", products: [] },
      payment_risk: {
        classification: "Medium",
        mcc_guess: "",
        vertical_flags: [],
        chargeback_risk: "Not assessed (no ANTHROPIC_API_KEY set)",
        rationale: "",
      },
      corepay_fit: { score: 0, verdict: "Not scored", reasons: [], watchouts: [] },
      outreach: { angle: "", possible_contacts: [] },
      company_fill: {},
    };
  }

  const sys =
    "You are a merchant-intelligence analyst for Corepay (a global high-risk PSP) and Dispu (its chargeback/dispute platform). " +
    "You are given a target company plus REAL data already pulled from SimilarWeb, BuiltWith and Hunter. " +
    "Do NOT restate the traffic/tech/contact numbers — those are handled. Produce ONLY the judgment layer. " +
    "payment_risk is from a card-acquiring view: classify card-acceptance risk (Low/Medium/High/Prohibited) and flag verticals such as " +
    "adult, dating, iGaming/gambling, CBD, nutra, telehealth/pharma, FX/trading, crypto, AI companion. " +
    "Respond with ONLY valid JSON, no markdown, no fences. Keep arrays to 3-5 short items. Schema: {" +
    '"business_model":{"type":string,"monetization":string,"products":string[]},' +
    '"payment_risk":{"classification":"Low"|"Medium"|"High"|"Prohibited","mcc_guess":string,"vertical_flags":string[],"chargeback_risk":string,"rationale":string},' +
    '"corepay_fit":{"score":number,"verdict":string,"reasons":string[],"watchouts":string[]},' +
    '"outreach":{"angle":string,"possible_contacts":string[]},' +
    '"company_fill":{"summary":string,"industry":string,"founded":string,"app_presence":string}}';

  const user =
    `Target: ${query} (resolved domain: ${domain})` +
    (region ? `, focus region ${region}` : "") +
    `.\nReal vendor data:\n${JSON.stringify(vendor, null, 2)}\nReturn the JSON object only.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!ok(r)) throw new Error(`Anthropic ${r.status}`);
  const data = await r.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const raw = text.replace(/```json|```/g, "").trim();
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
}

// ---- 6. assemble -----------------------------------------------------------
app.post("/api/enrich", async (req, res) => {
  try {
    const { query, region } = req.body || {};
    if (!query || !query.trim()) return res.status(400).json({ error: "query is required" });

    const domain = await resolveDomain(query);
    const [sw, bw, hu] = await Promise.all([similarweb(domain), builtwith(domain), hunter(domain)]);

    const vendor = {
      similarweb: sw,
      builtwith: bw,
      hunter: hu ? { company: hu.company, social: hu.social, contacts: hu.contacts } : null,
    };

    let synth;
    try {
      synth = await synthesize({ query, region, domain, vendor });
    } catch (e) {
      synth = null;
    }

    const fill = synth?.company_fill || {};
    const report = {
      company: {
        name: hu?.company?.name || hu?.org || query,
        domain,
        hq: hu?.company?.hq || "",
        founded: hu?.company?.founded || fill.founded || "",
        summary: hu?.company?.description || fill.summary || "",
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
      digital_presence: {
        social: hu?.social || [],
        app_presence: fill.app_presence || "",
      },
      payment_risk: synth?.payment_risk || {
        classification: "Medium",
        mcc_guess: "",
        vertical_flags: [],
        chargeback_risk: "",
        rationale: "",
      },
      corepay_fit: synth?.corepay_fit || { score: 0, verdict: "Not scored", reasons: [], watchouts: [] },
      outreach: {
        angle: synth?.outreach?.angle || "",
        // prefer real Hunter contacts; fall back to Claude's guesses
        possible_contacts:
          hu?.contacts && hu.contacts.length ? hu.contacts : synth?.outreach?.possible_contacts || [],
      },
      sources: [
        sw && "SimilarWeb",
        bw && "BuiltWith",
        hu && "Hunter",
        synth && "Claude (risk/fit)",
      ].filter(Boolean),
      confidence: sw && hu ? "high" : sw || hu || bw ? "medium" : "low",
      _meta: {
        resolved_domain: domain,
        sources_used: {
          similarweb: !!sw,
          builtwith: !!bw,
          hunter: !!hu,
          claude: !!synth,
        },
      },
    };

    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message || "enrichment failed" });
  }
});

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    keys: {
      anthropic: !!ANTHROPIC_API_KEY,
      similarweb: !!SIMILARWEB_API_KEY,
      builtwith: !!BUILTWITH_API_KEY,
      hunter: !!HUNTER_API_KEY,
    },
  })
);

app.listen(PORT, () => console.log(`Merchant Intel backend on :${PORT}`));
