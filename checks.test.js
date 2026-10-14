// Run: npm test
// Unit tests for checks.js plus an end-to-end replay of the Inspire 2 Shine scan
// (the case that exposed the v2 gaps) with the website and Claude mocked.
process.env.NODE_ENV = "test";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanDomain, parseQuery, splitPrincipals, normalizeApplication, classifySite, scanSignals,
  buildNeedles, splitCitations, filterFlags, deterministicMismatches, mergeMismatches,
  evaluateGates, applyGuards, computeConfidence, mergeEntity, entityMismatches, stateToJurisdiction,
  primaryMccs, candidateMccs, isServiceProvider, cleanScreening, parseWhoisField, parseRegistrar,
} from "./checks.js";
import { detectPacks, buildVerticalRequirements, checkProhibited, isStartupFile } from "./verticals.js";

const pad = (s) => s + " " + "Lorem ipsum dolor sit amet consectetur. ".repeat(60);

test("cleanDomain strips scheme, www, path (v2 bug)", () => {
  assert.equal(cleanDomain("https://inspire2shine.com/"), "inspire2shine.com");
  assert.equal(cleanDomain("http://www.Example.co.uk/shop?x=1"), "example.co.uk");
  assert.equal(cleanDomain("Inspire 2 Shine"), null);
});

test("top-bar context syntax", () => {
  const { head, application } = parseQuery("https://inspire2shine.com/ | vertical: Travel Membership | volume: 140000 | ticket: 140 | txns: 1000 | principals: Ron and Adriana Sacka | referred: Marc Lefebvre | linked: YTB; Vida Divina | state: FL | entity: Inspire 2 Shine, LLC");
  assert.equal(head, "https://inspire2shine.com/");
  const a = normalizeApplication(application);
  assert.deepEqual(a.principals, ["Ron Sacka", "Adriana Sacka"]);
  assert.equal(a.monthly_volume, 140000);
  assert.deepEqual(a.linked_companies, ["YTB", "Vida Divina"]);
  assert.equal(a.referral_partner, "Marc Lefebvre");
  assert.equal(stateToJurisdiction(a.entity_state), "us_fl");
});

test("splitPrincipals variants", () => {
  assert.deepEqual(splitPrincipals("Ron Sacka and Adriana Sacka"), ["Ron Sacka", "Adriana Sacka"]);
  assert.deepEqual(splitPrincipals(["Jane Doe"]), ["Jane Doe"]);
});

test("site classification", () => {
  const maint = classifySite({ inputDomain: "inspire2shine.com", httpStatus: 200, finalUrl: "https://inspire2shine.com/", html: "<title>Inspire 2 Shine</title><h1>Site under maintenance</h1><p>We'll be back soon.</p>" });
  assert.equal(maint.status, "maintenance");
  assert.equal(maint.gating, true);

  const pw = classifySite({ inputDomain: "x.com", httpStatus: 200, finalUrl: "https://x.com/password", html: "<body class='template-password'>Opening soon</body>" });
  assert.equal(pw.status, "password_protected");

  const cf = classifySite({ inputDomain: "x.com", httpStatus: 403, finalUrl: "https://x.com/", html: "<title>Just a moment...</title><div id='challenge-platform'></div>" });
  assert.equal(cf.status, "blocked");
  assert.equal(cf.gating, false);

  const rich = classifySite({ inputDomain: "x.com", httpStatus: 200, finalUrl: "https://x.com/", html: pad("<title>Shop</title><p>New collection coming soon!</p>") });
  assert.equal(rich.status, "live", "a 'coming soon' banner on a full page is not a gate");

  const down = classifySite({ inputDomain: "x.com", error: "ENOTFOUND" });
  assert.equal(down.status, "unreachable");
});

test("signal families: MLM strong vs jewelry", () => {
  const mlm = scanSignals(["Join our team! Log in to your Back Office. See the Compensation Plan and Income Disclosure."]);
  assert.ok(mlm.affiliate_mlm.strong.length >= 3);
  const shop = scanSignals(["18K gold plated bracelet, hoop earrings, necklaces. Free domestic shipping over $75."]);
  assert.ok(shop.jewelry_fashion.score >= 2);
  assert.equal(shop.travel, undefined);
});

test("declared vertical mismatch when site is live", () => {
  const application = normalizeApplication({ declared_vertical: "Travel Membership", avg_ticket: 140, monthly_volume: 140000, monthly_txn_count: 1000 });
  const signals = scanSignals(["18K gold plated bracelet, hoop earrings, necklaces"]);
  const m = deterministicMismatches({ application, site: { status: "live" }, signals, trafficVisits: 800 });
  const fields = m.map((x) => x.field);
  assert.ok(fields.includes("vertical"));
  assert.equal(m.find((x) => x.field === "vertical").severity, "high");
  assert.ok(fields.includes("traffic_vs_transactions"));
  assert.ok(!fields.includes("volume_math"), "140 × 1000 = 140000 reconciles");
});

test("name-collision filter on sources and flags", () => {
  const application = normalizeApplication({ legal_name: "Inspire 2 Shine, LLC", principals: "Ron and Adriana Sacka", linked_companies: "YTB; Vida Divina" });
  const needles = buildNeedles({ domain: "inspire2shine.com", application });
  const cites = [
    { title: "INSPIRE 2 SHINE / Accessories (@inspire2shine.i2s) • Instagram", url: "https://www.instagram.com/inspire2shine.i2s/" },
    { title: "Inspire Uplift LLC | BBB Complaints", url: "https://www.bbb.org/us/inspire-uplift" },
    { title: "Inspire Reviews | inspire.com", url: "https://www.trustpilot.com/review/inspire.com" },
    { title: "Ron Sacka - Inspire 2 Shine | LinkedIn", url: "https://www.linkedin.com/in/ron-sacka" },
    { title: "Brown Ends YTB's Online Travel Pyramid Scheme", url: "https://oag.ca.gov/news/ytb" },
  ];
  const { relevant, discarded } = splitCitations(cites, needles);
  assert.equal(relevant.length, 3);
  assert.equal(discarded.length, 2);

  const { flags, dropped } = filterFlags([
    { subject: "Inspire Uplift", match_basis: "similar_name_only", claim: "BBB complaints", url: "https://www.bbb.org/us/inspire-uplift", severity: "medium" },
    { subject: "YTB", match_basis: "linked_company", kind: "third_party_adverse", claim: "CA AG pyramid scheme settlement 2009", url: "https://oag.ca.gov/news/ytb", severity: "high" },
    { subject: "Vida Divina", match_basis: "linked_company", kind: "third_party_adverse", claim: "FTC notice", url: "https://made-up.example/url", severity: "medium" },
  ], cites);
  assert.equal(dropped, 1);
  assert.equal(flags.length, 2);
  assert.equal(flags[0].url_verified, true);
  assert.equal(flags[1].url, "", "URL not in real search results is blanked");
});

test("entity: grounded registry claim verifies, officers cross-checked", () => {
  const application = normalizeApplication({ legal_name: "Inspire 2 Shine, LLC", principals: "Ron and Adriana Sacka", incorporation_date: "2024-04-04" });
  const citations = [{ title: "Inspire 2 Shine LLC - filing information", url: "https://www.bizprofile.net/fl/north-palm-beach/inspire-2-shine-llc" }];
  const entity = mergeEntity({
    registry: null, citations, application,
    claude: { found: true, legal_name: "INSPIRE 2 SHINE LLC", registry_id: "L24000162168", jurisdiction: "us_fl", status: "Active", formation_date: "2024-04-04", officers: ["Sacka, Adriana C (MGR)", "Sacka, Stephen Ronald (AMBR)"], registered_address_type: "residential", source_url: "https://www.bizprofile.net/fl/north-palm-beach/inspire-2-shine-llc" },
  });
  assert.equal(entity.verified, true);
  assert.deepEqual(entityMismatches({ entity, application }), []);
  const ungrounded = mergeEntity({ registry: null, citations: [], application, claude: { found: true, legal_name: "Inspire 2 Shine LLC", source_url: "https://invented.example" } });
  assert.equal(ungrounded.verified, false);
});

test("guards: replay of the v2 Inspire 2 Shine verdict", () => {
  const application = normalizeApplication({ legal_name: "Inspire 2 Shine, LLC", declared_vertical: "Travel Membership", referral_partner: "Marc Lefebvre", principals: "Ron and Adriana Sacka" });
  const site = { status: "maintenance", evidence: "Site under maintenance" };
  const v2Synth = {
    payment_risk: { classification: "Low", mcc_guess: "5094 — Jewelry", mcc_candidates: [{ mcc: "5962", description: "Direct marketing travel", when: "if travel club sold via affiliates" }, { mcc: "4722", description: "Travel agency", when: "agency model" }], vertical_flags: [], chargeback_risk: "", rationale: "" },
    boardability: { verdict: "CONDITIONAL", rationale: "Clean vertical", conditions: ["Set initial cap $10,000"], routing_note: "RISK CLASS: Low" },
    corepay_fit: { score: 72, verdict: "CONDITIONAL", reasons: [], watchouts: [] },
    outreach: { angle: "Position Corepay as jewelry-friendly PSP", possible_contacts: ["Instagram DM: @inspire2shine.i2s"] },
  };
  const { mismatches } = mergeMismatches(deterministicMismatches({ application, site, signals: {} }), [
    { field: "vertical", declared: "Travel Membership", observed: "handmade jewelry DTC store", severity: "high", note: "" },
  ], { hasApplication: true });
  const gates = evaluateGates({ application, site, mismatches, entity: { verified: true }, synthOk: true });
  assert.deepEqual(gates.map((g) => g.code), ["SITE_NOT_LIVE", "DECLARED_VS_OBSERVED"]);

  const verticals = buildVerticalRequirements(detectPacks({ signals: {}, primaryMccs: ["5094"], application }));
  assert.deepEqual(verticals.map((v) => v.id), ["travel"], "declared travel membership selects the travel pack");

  const g = applyGuards({ synth: v2Synth, gates, mismatches, signals: {}, application, verticals });
  assert.equal(g.boardability.verdict, "HOLD");
  assert.equal(g.payment_risk.classification, "High", "the declared travel vertical lifts the floor, not the 5962 candidate");
  assert.ok(g.corepay_fit.score <= 40);
  assert.ok(g.boardability.conditions[0].startsWith("BLOCKING"));
  assert.ok(g.boardability.routing_note.startsWith("DEAL DESK GATES: SITE_NOT_LIVE"));
  assert.equal(g.outreach.suppressed, true);
  assert.ok(!JSON.stringify(g.outreach).includes("Instagram"));
  assert.ok(!g.payment_risk.vertical_flags.some((f) => /registration required/i.test(f) && f.includes("5962")), "5962 is only a candidate here, so no registration flag");
  assert.ok(g.payment_risk.vertical_flags.some((f) => /Travel club/i.test(f)));
  assert.ok(g.boardability.routing_note.includes("MCC 5094 (candidates: 5962, 4722)"));
});

test("guards: DECLINE is never softened; major-only gates stop a PASS", () => {
  const gates = [{ code: "ENTITY_UNVERIFIED", level: "major", message: "x" }];
  assert.equal(applyGuards({ synth: { boardability: { verdict: "DECLINE" } }, gates, mismatches: [], signals: {} }).boardability.verdict, "DECLINE");
  assert.equal(applyGuards({ synth: { boardability: { verdict: "PRE-CHECK PASS" } }, gates, mismatches: [], signals: {} }).boardability.verdict, "CONDITIONAL");
});

test("confidence is not HIGH for a domain-only scan of an offline site", () => {
  const c = computeConfidence({ synthOk: true, site: { status: "maintenance" }, trafficVisits: null, entity: { verified: false }, application: null, relevantSources: 2, principalsScreened: false, mismatches: [] });
  assert.notEqual(c.level, "high");
  assert.ok(c.reasons.length >= 3);
});


// ---------------------------------------------------------------------------
// v3.1 regressions — every one of these was produced by the boppythots scan
// ---------------------------------------------------------------------------
test("no application context means no declared-vs-observed mismatch", () => {
  const claudeMm = [{ field: "payment_capability_vs_current_integration", declared: "N/A — no application", observed: "WooCommerce cart but join-now routes to NOWPayments crypto only", severity: "medium", note: "" }];
  const { mismatches, demoted } = mergeMismatches([], claudeMm, { hasApplication: false });
  assert.equal(mismatches.length, 0, "a mismatch cannot exist with nothing declared");
  assert.equal(demoted.length, 1, "the observation is kept, just not as a mismatch");
  const withApp = mergeMismatches([], claudeMm, { hasApplication: true });
  assert.equal(withApp.mismatches.length, 1);
});

test("MCC candidates never raise the floor or add a registration flag", () => {
  const pr = { mcc_guess: "5967", mcc_candidates: [{ mcc: "7273" }, { mcc: "5818" }] };
  assert.deepEqual(primaryMccs(pr, null), ["5967"]);
  assert.deepEqual(candidateMccs(pr, null), ["7273", "5818"]);
  const g = applyGuards({
    synth: { payment_risk: { classification: "High", ...pr, vertical_flags: ["Visa high-brand-risk MCC (5967) requires card-scheme registration before boarding"] }, boardability: { verdict: "CONDITIONAL" } },
    gates: [], mismatches: [], signals: {},
  });
  const regFlags = g.payment_risk.vertical_flags.filter((f) => /registration/i.test(f));
  assert.equal(regFlags.length, 1, "one registration line, not three: " + JSON.stringify(regFlags));
  assert.ok(regFlags[0].includes("5967"));
  assert.ok(!JSON.stringify(g.payment_risk.vertical_flags).includes("7273"), "dating MCC candidate must not appear as a scheme flag");
  assert.deepEqual(g.payment_risk.scheme_registration.map((x) => x.mcc), ["5967"]);
  assert.ok(g.boardability.routing_note.includes("MCC 5967 (candidates: 7273, 5818)"));
});

test("a non-high-brand-risk primary with an HBR candidate gets one soft note", () => {
  const g = applyGuards({
    synth: { payment_risk: { classification: "Medium", mcc_guess: "5399", mcc_candidates: [{ mcc: "5962" }], vertical_flags: [] } },
    gates: [], mismatches: [], signals: {},
  });
  assert.equal(g.payment_risk.classification, "Medium", "a candidate alone must not raise the class");
  assert.ok(g.payment_risk.vertical_flags.some((f) => /Final MCC not settled/.test(f)));
});

test("structural risk is separated from third-party adverse media", () => {
  const cites = [{ url: "https://oag.ca.gov/x", title: "AG action" }];
  const { flags, structural } = filterFlags([
    { subject: "boppythots.com", match_basis: "domain", claim: "Site integrates NOWPayments crypto gateway on the join-now page", severity: "medium" },
    { subject: "boppythots.com", match_basis: "domain", claim: "No refund or cancellation policy present on a subscription-billing site", severity: "medium" },
    { subject: "Boppythots LLC", match_basis: "legal_name", claim: "Entity and domain are both fewer than 6 months old; no operating history", severity: "medium" },
    { subject: "Acme", match_basis: "legal_name", kind: "third_party_adverse", claim: "State AG enforcement action", url: "https://oag.ca.gov/x", severity: "high" },
  ], cites);
  assert.equal(structural.length, 3, "setup observations are structural: " + JSON.stringify(structural.map((f) => f.claim)));
  assert.equal(flags.length, 1);
  assert.ok(flags[0].claim.includes("enforcement"));
  assert.equal(flags[0].url_verified, true);
});

test("an explicit kind from the model wins over the keyword backstop", () => {
  const { flags, structural } = filterFlags([
    { subject: "x.com", match_basis: "domain", kind: "structural_risk", claim: "Something with no keywords at all", severity: "low" },
    { subject: "x.com", match_basis: "domain", kind: "third_party_adverse", claim: "New entity named in an FTC complaint", severity: "high" },
  ], []);
  assert.equal(structural.length, 1);
  assert.equal(flags.length, 1);
  assert.ok(flags[0].claim.includes("FTC"));
});

test("registered agents are not screened and not cross-checked as officers", () => {
  assert.ok(isServiceProvider("Northwest Registered Agent LLC"));
  assert.ok(isServiceProvider("CT Corporation System"));
  assert.ok(!isServiceProvider("Corinthian Collier"));
  const cleaned = cleanScreening([
    { subject: "Corinthian Collier", type: "principal", summary: "No adverse findings", findings: [] },
    { subject: "Northwest Registered Agent LLC", type: "linked_company", summary: "Registered agent address only", findings: [{ claim: "agent address", severity: "low" }] },
  ], []);
  assert.deepEqual(cleaned.map((x) => x.subject), ["Corinthian Collier"]);
  const application = normalizeApplication({ legal_name: "Boppythots LLC", principals: "Corinthian Collier" });
  const entity = { verified: true, officers: ["Corinthian Collier", "Northwest Registered Agent LLC"] };
  assert.deepEqual(entityMismatches({ entity, application }), []);
});

test("vertical packs carry Corepay's own adult terms, not invented numbers", () => {
  const signals = scanSignals(["Explicit adult content. You must be 18+ to enter. Membership join now. 2257 compliance."]);
  const packs = detectPacks({ signals, primaryMccs: ["5967"], application: null, businessModelText: "Adult content subscription site" });
  assert.ok(packs.some((p) => p.id === "adult"));
  const reqs = buildVerticalRequirements(packs, { startup: true });
  const adult = reqs.find((r) => r.id === "adult");
  assert.match(adult.reserve, /20% rolling reserve for 180 days/);
  assert.match(adult.reserve, /EUR 50,000/);
  assert.equal(adult.source, "Corepay guideline");
  const joined = adult.items.join(" | ");
  assert.match(joined, /2257/);
  assert.match(joined, /anti-human-trafficking/i);
  assert.match(joined, /age and ID verification at sign-up/i);
  assert.match(joined, /Aether Labs/, "startup extras fold in when there is no processing history");

  const g = applyGuards({ synth: { boardability: { verdict: "CONDITIONAL" }, payment_risk: { classification: "High", mcc_guess: "5967" } }, gates: [], mismatches: [], signals, verticals: reqs });
  assert.ok(g.boardability.conditions.some((c) => /20% rolling reserve/.test(c)), JSON.stringify(g.boardability.conditions));
  assert.ok(g.boardability.routing_note.includes("ADULT CONTENT REQUIREMENTS"));
});

test("the AI overlay only applies on top of an adult file, and flags prohibited likeness editing", () => {
  const aiOnly = detectPacks({ signals: scanSignals(["AI image generator for marketing teams"]), primaryMccs: ["5818"], application: null });
  assert.ok(!aiOnly.some((p) => p.id === "adult_ai"), "no adult base pack, so no adult-AI overlay");

  const both = detectPacks({ signals: scanSignals(["Explicit adult content, 18+. AI girlfriend companion with face swap uploads."]), primaryMccs: ["5967"], application: null });
  assert.ok(both.some((p) => p.id === "adult") && both.some((p) => p.id === "adult_ai"));
  const prohibited = checkProhibited(both, "upload a photo and face swap it onto the model");
  assert.equal(prohibited.length, 1);
  assert.match(prohibited[0].message, /no-go/);
  const gates = evaluateGates({ application: null, site: { status: "live" }, mismatches: [], entity: {}, synthOk: true, prohibited });
  assert.ok(gates.some((g) => g.code === "VERTICAL_PROHIBITED" && g.level === "blocking"));
});

test("peptide and travel packs match their own verticals", () => {
  const pep = detectPacks({ signals: scanSignals(["Research use only peptides. BPC-157. Certificate of analysis."]), primaryMccs: [], application: null });
  const p = buildVerticalRequirements(pep).find((x) => x.id === "peptides");
  assert.match(p.reserve, /Visa only/);
  assert.match(p.items.join(" "), /SSB bank account/);

  const trav = detectPacks({ signals: {}, primaryMccs: ["5962"], application: normalizeApplication({ declared_vertical: "Travel membership" }) });
  const t = buildVerticalRequirements(trav).find((x) => x.id === "travel");
  assert.match(t.items.join(" "), /Seller of Travel/);
  assert.match(t.source, /^Drafted/, "travel pack is not from a ratified Corepay doc and says so");
});

test("isStartupFile keys off processing history, not just age", () => {
  assert.equal(isStartupFile({ application: normalizeApplication({ previously_accepted_cards: "yes" }), site: { status: "live" } }), false);
  assert.equal(isStartupFile({ application: null, site: { status: "live" }, domainCreated: "2026-05-29" }), true);
});


test("a guideline reserve replaces a reserve figure the model invented", () => {
  const verticals = buildVerticalRequirements(detectPacks({ signals: scanSignals(["explicit adult content 18+ membership"]), primaryMccs: ["5967"], application: null }), { startup: true });
  const g = applyGuards({
    synth: { boardability: { verdict: "CONDITIONAL", conditions: ["Rolling reserve: minimum 10% for 180 days", "Monthly volume cap of $15,000 for first 90 days"] }, payment_risk: { classification: "High", mcc_guess: "5967" } },
    gates: [], mismatches: [], signals: {}, verticals,
  });
  assert.ok(!g.boardability.conditions.some((c) => /10%/.test(c)), "the 10% figure must not sit under a 20% guideline");
  assert.ok(g.boardability.conditions.some((c) => /\$15,000/.test(c)), "a volume cap is not a reserve and stays");
  assert.ok(g.boardability.conditions.some((c) => /20% rolling reserve/.test(c)));
});

test("a domain-only scan never reports high confidence", () => {
  const c = computeConfidence({ synthOk: true, site: { status: "live" }, trafficVisits: 50000, entity: { verified: true }, application: null, relevantSources: 5, principalsScreened: true, mismatches: [] });
  assert.equal(c.level, "medium", "the declared-vs-observed check never ran, so the report is not high confidence");
  const withApp = computeConfidence({ synthOk: true, site: { status: "live" }, trafficVisits: 50000, entity: { verified: true }, application: { legal_name: "X" }, relevantSources: 5, principalsScreened: true, mismatches: [] });
  assert.equal(withApp.level, "high");
});


test("registrar is read from the Registrar line, not Registrar WHOIS Server", () => {
  // Shape of a real .com record: the decoy lines come first.
  const whois = [
    "   Domain Name: BOPPYTHOTS.COM",
    "   Registry Domain ID: 1234_DOMAIN_COM-VRSN",
    "   Registrar WHOIS Server: whois.webcentralgroup.com.au",
    "   Registrar URL: http://www.webcentralgroup.com.au",
    "   Creation Date: 2026-05-29T04:12:00Z",
    "   Registrar: Web Central Group Pty Ltd",
    "   Registrar IANA ID: 1234",
  ].join("\r\n");
  assert.equal(parseRegistrar(whois), "Web Central Group Pty Ltd");
  assert.equal(parseWhoisField(whois, ["Creation Date"]), "2026-05-29T04:12:00Z");
  // A record with only the decoy lines yields nothing rather than a hostname.
  assert.equal(parseRegistrar("Registrar WHOIS Server: whois.example.com\nRegistrar URL: https://example.com"), null);
  assert.equal(parseRegistrar("Registrar: REDACTED FOR PRIVACY"), null);
});

// ---- end-to-end: /api/enrich with mocked website + Claude --------------------------
test("e2e: /api/enrich returns HOLD for the Inspire 2 Shine file", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const claudeJson = {
    business_model: { type: "Travel membership (declared) / jewelry DTC (observed)", monetization: "Membership fees", products: ["Travel membership"] },
    payment_risk: { classification: "Low", mcc_guess: "5094", mcc_candidates: [{ mcc: "5962", description: "Direct marketing – travel", when: "travel club sold via affiliates" }], vertical_flags: [], chargeback_risk: "", rationale: "" },
    corepay_fit: { score: 72, verdict: "CONDITIONAL", reasons: ["US entity"], watchouts: [] },
    boardability: { verdict: "CONDITIONAL", rationale: "", conditions: ["10% rolling reserve"], routing_note: "MERCHANT: Inspire 2 Shine" },
    outreach: { angle: "Instagram DM", possible_contacts: ["@inspire2shine.i2s"] },
    adverse_media: {
      flags: [
        { subject: "Inspire Uplift", match_basis: "similar_name_only", claim: "BBB complaints", url: "https://www.bbb.org/us/inspire-uplift", severity: "medium" },
        { subject: "YTB International", match_basis: "linked_company", claim: "California AG pyramid-scheme suit (2008), settled 2009", url: "https://oag.ca.gov/news/press-releases/brown-ends-ytbs-online-travel-pyramid-scheme", severity: "high" },
      ],
      summary: "", regulatory: "",
    },
    entity_verification: { found: true, legal_name: "Inspire 2 Shine LLC", registry_id: "L24000162168", jurisdiction: "us_fl", status: "Active", formation_date: "2024-04-04", officers: ["Sacka, Adriana C", "Sacka, Stephen Ronald"], registered_address_type: "residential", source_url: "https://www.bizprofile.net/fl/north-palm-beach/inspire-2-shine-llc" },
    principal_screening: [{ subject: "Vida Divina", type: "linked_company", summary: "", findings: [{ claim: "FTC Notice of Penalty Offenses recipient (Oct 2021)", severity: "medium", url: "https://truthinadvertising.org/brands/vida-divina/" }] }],
    consistency_check: { summary: "", mismatches: [{ field: "vertical", declared: "Travel Membership", observed: "handmade jewelry store", severity: "high", note: "" }] },
    company_fill: { summary: "Florida LLC", industry: "Travel", founded: "2024", app_presence: "", hq: "North Palm Beach, FL" },
  };
  const searchResults = [
    { url: "https://www.bbb.org/us/inspire-uplift", title: "Inspire Uplift LLC | BBB Complaints" },
    { url: "https://oag.ca.gov/news/press-releases/brown-ends-ytbs-online-travel-pyramid-scheme", title: "Brown Ends YTB's Online Travel Pyramid Scheme" },
    { url: "https://www.bizprofile.net/fl/north-palm-beach/inspire-2-shine-llc", title: "Inspire 2 Shine LLC North Palm Beach, FL - filing information" },
    { url: "https://truthinadvertising.org/brands/vida-divina/", title: "Vida Divina - Truth in Advertising" },
    { url: "https://www.instagram.com/inspire2shine.i2s/", title: "INSPIRE 2 SHINE / Accessories" },
  ];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1")) return realFetch(url, opts);
    if (u.startsWith("https://inspire2shine.com")) {
      return new Response("<title>Inspire 2 Shine</title><h1>Under maintenance</h1><p>We'll be back soon.</p>", { status: 200, headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "x" } });
    }
    if (u.startsWith("https://api.anthropic.com")) {
      return new Response(JSON.stringify({ content: [
        { type: "web_search_tool_result", content: searchResults },
        { type: "text", text: JSON.stringify(claudeJson) },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("network disabled in test");
  };
  const { default: app } = await import("./server.js");
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await realFetch(`http://127.0.0.1:${port}/api/enrich`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "https://inspire2shine.com/ | vertical: Travel Membership | volume: 140000 | ticket: 140 | txns: 1000 | entity: Inspire 2 Shine, LLC | state: FL | principals: Ron and Adriana Sacka | linked: YTB; Vida Divina | referred: Marc Lefebvre" }),
    });
    const rep = await r.json();
    assert.equal(r.status, 200, JSON.stringify(rep));
    assert.equal(rep.company.domain, "inspire2shine.com");
    assert.equal(rep.site_check.status, "maintenance");
    assert.equal(rep.boardability.verdict, "HOLD");
    assert.equal(rep.payment_risk.classification, "High");
    assert.deepEqual(rep.vertical_requirements.map((v) => v.id), ["travel"]);
    assert.ok(rep.vertical_requirements[0].items.some((i) => /Seller of Travel/.test(i)));
    assert.ok(Array.isArray(rep.risk_observations));
    assert.ok(rep.corepay_fit.score <= 40);
    assert.equal(rep.entity_verification.verified, true);
    assert.ok(rep.company.founded.includes("L24000162168"));
    assert.equal(rep.adverse_media.flags_discarded_similar_name, 1);
    assert.ok(rep.adverse_media.flags.some((f) => f.claim.includes("YTB")));
    assert.ok(rep.adverse_media.flags.some((f) => f.claim.includes("Vida Divina")));
    assert.ok(!rep.adverse_media.sources.some((s) => s.url.includes("inspire-uplift")));
    assert.equal(rep.outreach.suppressed, true);
    assert.notEqual(rep.confidence, "high");
    assert.ok(rep.gates.some((g) => g.code === "SITE_NOT_LIVE"));
    console.log("\n--- routing note ---\n" + rep.boardability.routing_note + "\n--- confidence ---\n" + JSON.stringify(rep.confidence_detail));
  } finally {
    server.close();
    globalThis.fetch = realFetch;
  }
});
