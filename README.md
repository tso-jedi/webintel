# Merchant Intel — backend (Deal Desk v3.1)

Pulls **real** website/lead data and hands it to the Deal Desk frontend. Vendors and
direct checks supply the facts; Claude supplies the judgment layer (card-acceptance
risk, Corepay/Dispu fit, business model, adverse media). **Deterministic rules in
`checks.js` sit on top of Claude**, so a hard gate can never be talked out of by the model.

| Field group | Source |
|---|---|
| Website status (live / maintenance / password / coming soon / parked / suspended / blocked), platform, policy links, affiliate/MLM + recurring-billing signals | **Direct site check** (homepage + up to 4 relevant internal pages) |
| Traffic tier, monthly visits, top geographies, channels, global rank | **SimilarWeb** REST API |
| Tech-stack signals | **BuiltWith** Domain API v21 (falls back to detected platform) |
| Company enrichment + contacts + social | **Hunter.io** v2 |
| Legal entity: status, formation date, officers | **OpenCorporates** (optional key) → otherwise grounded Claude registry search |
| Domain age, DNS, email provider, SSL | RDAP / WHOIS / DNS / TLS (free) |
| Risk classification, MCC candidates, fit, business model, principal + linked-company screening, consistency check | **Claude + web_search** |

Every source degrades gracefully — a missing key or failed call drops that section, the
rest still returns, and `_meta.sources_used` reports what actually returned data.

## What changed in v3.1

Seven fixes, all found by the boppythots scan, plus vertical requirement packs.

1. **No application context, no mismatches.** With nothing declared, a declared-vs-observed
   mismatch cannot exist. The model's `declared: "N/A — no application"` rows are demoted to
   watchouts instead of driving gates and conditions.
2. **MCC candidates no longer act like facts.** Only `mcc_guess` (plus a declared `current_mcc`)
   sets the scheme floor and produces a registration flag. Candidates are listed as alternatives;
   a high-brand-risk candidate under a non-HBR primary gets one soft "final MCC not settled" note.
   The model's own wording for the same registration point is de-duplicated.
3. **Structural risk is split from adverse media.** `adverse_media.flags` now holds only
   third-party findings (regulator, court, scheme, press). Observations about the merchant's own
   setup — new entity, missing policies, which gateway it uses — go to the new `risk_observations`.
   A merchant with a clean record no longer shows FLAGS FOUND in red.
4. **Evidence citations survive the name filter.** A source that evidenced the registry record or a
   kept finding is about this merchant by definition, even when its page title never says the name,
   so the registry record is no longer discarded and no longer docks confidence.
5. **Registrar parsing fixed.** `Registrar:` is matched at line start, so "Registrar WHOIS Server:"
   and "Registrar URL:" no longer win; a hostname or REDACTED value is dropped rather than shown.
6. **DNS provider fixed.** NS1 is only reported for nsone.net, not for any generic `ns1.<host>`.
7. **Registered agents are not screened.** Northwest Registered Agent, CSC, LegalZoom and the like
   are service providers, not related parties — excluded from screening and officer cross-checks.

Also: the vertical floor comes from the **declared** business, so a travel-membership file stays
high risk even while its domain still serves a jewelry store; a guideline reserve replaces any
reserve percentage the model invented; and a domain-only scan can no longer report high confidence,
because the tool's main check never ran.

### Vertical requirement packs (`verticals.js`)

Conditions now come from Corepay's own guidelines instead of generic numbers. Each pack carries a
risk floor, reserve/pricing terms, and the documents Underwriting will ask for. They land in the
report as `vertical_requirements`, in the routing note, and in the PDF and CSV.

| Pack | Kind | Source |
|---|---|---|
| Adult content | primary | Corepay guideline |
| AI-generated adult content | overlay on adult | Corepay guideline |
| Research peptides (US) | primary | Corepay guideline |
| Telehealth / online pharmacy (US) | primary | Corepay guideline |
| Travel club / membership | primary | Drafted — confirm with Underwriting |
| Affiliate / MLM business opportunity | overlay | Drafted — confirm with Underwriting |
| Recurring / negative-option billing | overlay | Drafted — confirm with Underwriting |

Packs marked **Drafted** are assembled from scheme rules and case practice, not from a ratified
Corepay document — the UI labels them so nobody quotes them as policy by accident. **Edit
`verticals.js` to change any pack**; the file is plain data with comments and needs no other change.

Startup extras (guardrail attestation, funding proof, business plan, management CVs) fold in
automatically when there is no processing history to lean on.

The adult-AI pack also carries a prohibition: altering a real person's photo, face or body is a
no-go (internal rule, 4 Sep 2026). Matching content raises a **blocking** `VERTICAL_PROHIBITED`
gate so a human decides, rather than an automatic decline that a false positive could trigger.

## What changed in v3

1. **Application context.** Send what the merchant *declared* (precheck form) and the
   scan compares it with what is *observed*. Risk and MCC are classified on the declared
   business, because that is what will be processed.
2. **Hard gates** (`gates[]`):
   - `SITE_NOT_LIVE` (blocking) → verdict forced to **HOLD**, fit capped at 40.
   - `DECLARED_VS_OBSERVED` (major) → verdict at least **ESCALATE**.
   - `ENTITY_UNVERIFIED`, `SITE_UNVERIFIED`, `NO_JUDGMENT_LAYER` (major) → never PRE-CHECK PASS, fit capped at 65.
   - `DECLINE` from the model is never softened.
3. **Principal and linked-company screening** (`principal_screening[]`), with material
   findings also folded into `adverse_media.flags` so the current UI shows them.
4. **Name-collision filter.** Sources are kept only if they match the domain, legal/DBA
   name, a principal or a linked company (`adverse_media.sources_discarded` counts the
   rest). Flags marked `similar_name_only` are dropped, and any flag URL that did not
   come back from a real web_search result is blanked (`url_verified: false`).
5. **Scheme floors.** Visa high-brand-risk MCCs (5962, 5966, 5967, 7273, 7995, 5122,
   5912; 5993/4816/5816 conditional) raise the risk class and add a registration flag.
   Strong affiliate/MLM signals raise it to at least Medium.
6. **Outreach suppressed** for partner-referred files (`referral_partner`).
7. **Calibrated confidence** (`confidence_detail` = score + reasons) instead of "high
   whenever two vendors answered".
8. **Fixes.** A URL like `https://example.com/` in the top bar was previously used as
   the "domain", which silently broke DNS, RDAP, Hunter and the HTTP check. Vendors are
   only marked as sources when they returned data. 24h report cache. Optional access token.

## Sending application context

**Option A — top bar (works with the current frontend, no UI change):**

```
inspire2shine.com | vertical: Travel Membership | volume: 140000 | ticket: 140 | txns: 1000 | entity: Inspire 2 Shine, LLC | state: FL | principals: Ron and Adriana Sacka | linked: YTB; Vida Divina | referred: Marc Lefebvre
```

Keys (aliases in brackets): `entity` [legal, company], `dba`, `state`, `incorporated`,
`vertical` [goods, services, type], `principals` [owner, ubo], `ticket` [aov],
`volume`, `txns` [transactions, count], `currency`, `processor`, `mcc`,
`history` (yes/no — previously accepted cards), `linked` (prior employers/affiliated
companies, `;`-separated), `referred` [referral, partner, iso], `notes`.

**Option B — JSON body:**

```bash
curl -X POST https://merchant-intel.onrender.com/api/enrich \
  -H 'content-type: application/json' \
  -H 'x-deal-desk-token: <token if DEAL_DESK_TOKEN is set>' \
  -d '{
    "query": "inspire2shine.com",
    "region": "US",
    "refresh": false,
    "application": {
      "legal_name": "Inspire 2 Shine, LLC", "entity_state": "FL", "incorporation_date": "2024-04-04",
      "declared_vertical": "Travel Membership", "avg_ticket": 140, "monthly_volume": 140000, "monthly_txn_count": 1000,
      "principals": ["Ron Sacka", "Adriana Sacka"], "linked_companies": ["YTB", "Vida Divina"],
      "previously_accepted_cards": true, "current_processor": "Maverick", "referral_partner": "Marc Lefebvre"
    }
  }'
```

## New response fields

All v2 fields keep their shape. Added: `site_check`, `application`, `consistency`
(`mismatches[]`), `gates[]`, `entity_verification`, `principal_screening[]`,
`guard_adjustments[]`, `confidence_detail`, `risk_observations[]`, `vertical_requirements[]`,
`payment_risk.mcc_candidates[]`,
`payment_risk.scheme_registration[]`, `adverse_media.sources_discarded`,
`adverse_media.flags_discarded_similar_name`, `outreach.suppressed`, `_meta.version`,
`_meta.cache`. `boardability.verdict` can now also be **`HOLD`**.

Until the frontend has dedicated panels, the key points are folded into fields it
already renders: gates and mismatches lead `boardability.conditions`,
`corepay_fit.watchouts` and the `routing_note` header; the verified entity appears in
`company.founded`; screening findings appear in `adverse_media.flags`.

## Files

| File | What it is |
|---|---|
| `server.js` | HTTP layer, vendor calls, website check, the Claude prompt |
| `checks.js` | Deterministic rules — gates, mismatches, filters, guards. The model cannot override these |
| `verticals.js` | **Corepay's underwriting guidelines as data. Edit this when a guideline changes** |
| `checks.test.js` | 25 tests, including replays of the Inspire 2 Shine and boppythots scans |
| `merchant-intel.html` | The Deal Desk front end |

## Setup

```bash
npm install
cp .env.example .env      # paste your keys
npm test                  # unit tests + end-to-end replay (network mocked)
npm start                 # -> http://localhost:3001
curl http://localhost:3001/api/health
```

## Environment

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Judgment layer |
| `ANTHROPIC_MODEL` | no | default `claude-sonnet-4-6` |
| `SIMILARWEB_API_KEY`, `BUILTWITH_API_KEY`, `HUNTER_API_KEY` | no | skipped if missing |
| `OPENCORPORATES_API_TOKEN` | no | registry lookup; without it Claude searches registries and must cite the record |
| `DEAL_DESK_TOKEN` | no | if set, `/api/enrich` requires `x-deal-desk-token`. **Only set once the frontend sends it.** |
| `WEB_SEARCH_MAX_USES` | no | default 10 searches per scan |
| `CACHE_TTL_HOURS` | no | default 24; send `"refresh": true` to bypass |
| `SITE_CHECK_USER_AGENT` | no | UA for the website check |
| `ALLOWED_ORIGINS` | no | default `*` |

## Notes

- **Cost per uncached scan:** up to 4 SimilarWeb + 1 BuiltWith + 2 Hunter + 2 OpenCorporates
  + 1 Claude call with up to `WEB_SEARCH_MAX_USES` searches, plus ≤5 page fetches.
- **SimilarWeb response shapes vary by plan** — adjust `similarweb()` if your envelope differs.
- **Not in flow of funds / no PII storage** — the in-memory cache holds report JSON only
  and is cleared on restart.
