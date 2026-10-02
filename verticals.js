// =============================================================================
// verticals.js — Corepay vertical requirement packs (Deal Desk v3.1)
// -----------------------------------------------------------------------------
// Turns Corepay's own underwriting guidelines into the conditions the pre-check
// produces, instead of generic reserve/cap numbers invented per scan.
//
// EDIT THIS FILE when a guideline changes. Each pack carries:
//   id, label
//   source     "Corepay guideline"  = taken from Corepay's own underwriting docs
//              "Drafted"            = assembled from scheme rules + case practice,
//                                     NOT yet ratified by Underwriting — review it
//   kind       "primary" (the vertical itself) or "overlay" (applies on top)
//   match      how it is detected (signals / MCC / declared text)
//   floor      minimum card-acceptance risk class for this vertical
//   reserve    headline reserve + pricing guidance shown in the routing note
//   items      the documents / controls Underwriting will ask for
//   prohibited rules that force a stop rather than a condition
// =============================================================================

export const PACK_VERSION = "3.1.0";

const S = {
  COREPAY: "Corepay guideline",
  DRAFTED: "Drafted — confirm with Underwriting",
};

export const PACKS = {
  // ---------------------------------------------------------------- adult ----
  adult: {
    id: "adult",
    label: "Adult content",
    floor: "High",
    kind: "primary",
    source: S.COREPAY,
    mcc: ["5967"],
    signals: ["adult"],
    declared: /adult|porn|nsfw|explicit|cam\b|camming|onlyfans|creator content|fan ?club/i,
    reserve:
      "Under 12 months processing: 20% rolling reserve for 180 days, or a minimum EUR 50,000 fixed deposit. Mandatory high-risk scheme registration.",
    items: [
      "Mandatory high-risk scheme registration (Visa HBR and Mastercard MRP) before any card volume",
      "Operational age and ID verification at sign-up for ALL users, with the provider agreement — a click-through 18+ gate does not satisfy this",
      "18 U.S.C. § 2257 compliance: named Custodian of Records, records location, and the consent/release process for every person depicted",
      "Confirmation of who produces the content, and whether the operator appears in it personally",
      "Content moderation policy covering both AI and human review layers, with pre-publication review described",
      "Published website policy suite: AUP, age/ID verification, anti-human-trafficking, content moderation, complaints/takedown/appeals, § 2257 (or § 2257-exempt statement for purely synthetic content)",
      "Complaint and takedown responses within 7 days, with a published appeal process",
      "Incident notification to Corepay within 24–48 hours",
      "6 months financials and processing history (or the reserve above in their absence)",
      "Business licence where required in the operating jurisdiction",
    ],
    startup_items: [
      "Third-party guardrail attestation (Aether Labs or equivalent)",
      "Proof of funding for 1–2 years of operation",
      "Business plan and management CVs evidencing experienced key personnel",
    ],
  },

  // AI overlay on adult files
  adult_ai: {
    id: "adult_ai",
    label: "AI-generated adult content",
    kind: "overlay",
    source: S.COREPAY,
    signals: ["ai_generation"],
    requires: ["adult"],
    reserve: "Minimum USD 50,000 reserve, reviewed after 3 months. EU/UK routing preferred where 50%+ of traffic is from regulated markets.",
    items: [
      "Guardrail documentation plus working test logins with conversation history, so reviewers can test generation directly",
      "Hard-block coverage evidenced for: CSAM including fictional minors, deepfake/NCII, incest, bestiality, rape/non-consensual, trafficking facilitation",
      "Quarterly guardrail testing attestation",
      "§ 2257-exempt statement published, where content is purely synthetic with no human performers",
    ],
    prohibited: {
      // Internal rule agreed 4 Sep 2026 (Plamen/Assen/Jose, cc Jonathan)
      test: /face ?swap|nudif|undress|deepfake|swap (?:a |the )?face|real[- ]person likeness|celebrity likeness/i,
      message:
        "Corepay rule (agreed 4 Sep 2026): altering a real person's photo, face or body is a no-go because consent cannot be verified. Fully synthetic content with no real person is treated normally. Anything in between goes to joint review before proceeding.",
    },
  },

  // ------------------------------------------------------------- peptides ----
  peptides: {
    id: "peptides",
    label: "Research peptides (US)",
    floor: "High",
    kind: "primary",
    source: S.COREPAY,
    signals: ["peptides"],
    declared: /peptide|research chemical|\bruo\b|research use only/i,
    reserve:
      "Visa only — Mastercard blocked. Minimum pricing IC+4.00%. Upfront reserve (volume-dependent) plus 10% rolling. T+3 settlement.",
    items: [
      "Research-use-only disclaimer on every product page",
      "Researcher confirmation step at checkout",
      "No health claims, dosage guidance, or needles sold alongside",
      "Certificates of analysis visible on the site, issued by an unaffiliated accredited laboratory",
      "No human-consumption marketing on social channels",
      "Merchant must hold a US entity with an SSB bank account",
      "3 months bank statements and 3 months processing statements",
    ],
  },

  // --------------------------------------------------- telehealth / pharma ----
  telehealth: {
    id: "telehealth",
    label: "Telehealth / online pharmacy (US)",
    floor: "High",
    kind: "primary",
    source: S.COREPAY,
    mcc: ["5912", "5122"],
    signals: ["telehealth_pharma"],
    declared: /telehealth|telemedicine|online pharmacy|prescription|glp-?1/i,
    reserve: "Standard US high-risk terms; LegitScript certification expected (Corepay is a certified partner and can submit at a discount).",
    items: [
      "Proof of current licensing for all medical providers (confirm whether every prescriber's licence is required or the Chief Medical Director's alone)",
      "Pharmacy partner agreements",
      "LegitScript certification, or evidence the application is in progress",
      "Full product catalogue with any controlled substances identified by DEA schedule",
      "Documented telehealth prescribing compliance: state-specific licensed clinician, DEA registration, video visit evidence",
      "Clinical-need/differentiation statement for any compounded product",
    ],
  },

  // --------------------------------------------------------------- travel ----
  travel: {
    id: "travel",
    label: "Travel club / membership",
    floor: "High",
    kind: "primary",
    source: S.DRAFTED,
    mcc: ["5962"],
    signals: ["travel"],
    declared: /travel (club|membership)|vacation club|timeshare|discount travel/i,
    reserve:
      "Visa high-brand-risk MCC 5962 — registration mandatory before processing. Expect a starting monthly cap with step-ups after 90 days clean, plus a rolling reserve sized to forward delivery.",
    items: [
      "Seller of Travel registration for the home state and every state requiring one (Florida, California, Washington, Hawaii, Iowa)",
      "Membership agreement, refund and cancellation policy, and the in-product cancellation path",
      "Who supplies the booking engine, and whether the merchant is merchant of record for bookings or only for the membership fee",
      "Treatment of forward delivery: how long members hold unused benefits, and the exposure if the merchant stops trading",
      "Proof of supplier contracts behind the advertised discounts",
    ],
  },

  // ------------------------------------------------------- overlays ----------
  mlm: {
    id: "mlm",
    label: "Affiliate / MLM business opportunity",
    floor: "Medium",
    kind: "overlay",
    source: S.DRAFTED,
    signals: ["affiliate_mlm"],
    reserve: "Affiliate-fee transactions are a separate chargeback pool from retail sales — consider segmenting them on their own MID and descriptor.",
    items: [
      "Compensation plan, and whether commissions are paid on retail sales only or also on enrolments",
      "Income disclosure statement and the policy governing earnings claims",
      "Affiliate agreement and marketing-compliance policy, with the enforcement process",
      "Whether affiliates pay any fee by card (starter kit, back office, monthly) and the refund terms on those fees",
      "Split between retail customers and affiliate/participant customers",
      "FTC exposure review where the company or its principals have prior regulatory history",
    ],
  },

  recurring: {
    id: "recurring",
    label: "Recurring / negative-option billing",
    floor: "Medium",
    kind: "overlay",
    source: S.DRAFTED,
    signals: ["recurring_billing"],
    reserve: "Rebill exposure sits in the reserve: size it against the forward-billing book, not just the monthly run rate.",
    items: [
      "Clear disclosure of price, frequency and renewal date before checkout (ROSCA / negative-option rules)",
      "Express informed consent captured and retained for each subscriber",
      "Online cancellation that is as simple as sign-up, with the cancellation path demonstrated",
      "Trial-to-rebill terms stated on the checkout page, if a trial is offered",
      "Billing descriptor that the cardholder will recognise, with a support contact",
      "Pre-dispute alert coverage (Ethoca / Verifi RDR) at go-live",
    ],
  },
};

const has = (sig, fam, min = 2) => (sig?.[fam]?.score || 0) >= min;

/**
 * Decide which packs apply. Detection is deliberately conservative:
 * a pack matches on a primary MCC, a strong-enough content signal, or the
 * declared vertical text — never on a speculative MCC candidate alone.
 */
export function detectPacks({ signals, primaryMccs, application, businessModelText }) {
  const text = [application?.declared_vertical, application?.notes, businessModelText].filter(Boolean).join(" ");
  const matched = [];
  for (const p of Object.values(PACKS)) {
    const on = [];
    if (p.mcc && (primaryMccs || []).some((m) => p.mcc.includes(m))) on.push(`MCC ${(primaryMccs || []).filter((m) => p.mcc.includes(m)).join("/")}`);
    for (const fam of p.signals || []) if (has(signals, fam)) on.push(`site signals: ${fam.replace(/_/g, " ")}`);
    if (p.declared && text && p.declared.test(text)) on.push("declared business");
    if (on.length) matched.push({ ...p, matched_on: on });
  }
  // Overlays that need a base pack (adult_ai without adult) are dropped.
  const ids = new Set(matched.map((m) => m.id));
  return matched.filter((m) => !m.requires || m.requires.every((r) => ids.has(r)));
}

/** Startup extras apply when there is no processing history to lean on. */
export function isStartupFile({ application, site, entityFormationDate, domainCreated }) {
  if (application?.previously_accepted_cards === true) return false;
  const young = (d) => {
    const t = new Date(d);
    return !isNaN(t) && (Date.now() - t) / 864e5 < 365;
  };
  return !!(young(entityFormationDate) || young(domainCreated) || site?.status !== "live");
}

/** Build the report block: one entry per matched pack. */
export function buildVerticalRequirements(packs, { startup } = {}) {
  return packs.map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    source: p.source,
    floor: p.floor || "",
    matched_on: p.matched_on,
    reserve: p.reserve || "",
    items: startup && p.startup_items ? [...p.items, ...p.startup_items] : [...p.items],
  }));
}

/** Prohibited-content rules that should stop a file rather than condition it. */
export function checkProhibited(packs, haystack) {
  const out = [];
  for (const p of packs) {
    if (p.prohibited && p.prohibited.test.test(String(haystack || ""))) {
      out.push({ pack: p.id, label: p.label, message: p.prohibited.message, matched: (String(haystack).match(p.prohibited.test) || [])[0] || "" });
    }
  }
  return out;
}
