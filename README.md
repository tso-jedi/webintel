# Merchant Intel — backend

Pulls **real** website/lead data and hands it to the frontend in the same shape the
artifact already renders. Vendors supply the facts; Claude only supplies the
judgment layer (card-acceptance risk, Corepay/Dispu fit, business-model and outreach
synthesis) — because none of the data vendors sell that.

| Field group | Source |
|---|---|
| Traffic tier, monthly visits, top geographies, channels, global rank | **SimilarWeb** REST API |
| Tech-stack signals | **BuiltWith** Domain API v21 |
| Company enrichment + contacts + social | **Hunter.io** v2 |
| name → domain resolution | Clearbit Autocomplete (free, keyless) |
| Risk classification, fit score, business model, outreach angle | **Claude** |

Every vendor call degrades gracefully — a missing or rate-limited key just drops that
section, the rest still returns, and `_meta.sources_used` reports what actually fired.

## Setup

```bash
cd backend
npm install
cp .env.example .env      # then paste your keys
npm start                 # -> http://localhost:3001
```

Check it's alive and which keys are loaded:

```bash
curl http://localhost:3001/api/health
```

Test an enrichment:

```bash
curl -X POST http://localhost:3001/api/enrich \
  -H 'content-type: application/json' \
  -d '{"query":"ivimhealth.com","region":"US"}'
```

## Point the frontend at it

Open the Merchant Intel artifact, click the **⚙** in the command bar, paste your
backend URL (`http://localhost:3001`), and run a scan. The source badge switches from
`AI ESTIMATE` to `LIVE VENDOR DATA`. Leave the field blank and the artifact keeps using
the in-browser Claude estimate path, so it still works with no backend running.

## Getting the keys

- **Anthropic** — console.anthropic.com → API keys. Required for risk/fit.
- **SimilarWeb** — developers.similarweb.com. The endpoints used here
  (`total-traffic-and-engagement/visits`, `geo/traffic-by-country`,
  `traffic-sources/overview-share`, `global-rank`) are on the standard REST API;
  your **plan tier** governs which are enabled. If one 403s it's silently skipped.
- **BuiltWith** — api.builtwith.com (Domain API v21).
- **Hunter** — hunter.io → API. Free tier covers light testing of
  `domain-search` and `companies/find`.

## Notes / tweaks you may need

- **Response shapes vary by SimilarWeb plan.** The parsers are deliberately tolerant
  (they look for `visits` / `records` / `overview` arrays and read `share`/`value`).
  If your plan returns a different envelope, adjust `similarweb()` in `server.js` — the
  spots are commented.
- **Country codes.** SimilarWeb's geo endpoint returns ISO-3166 *numeric* codes; a
  compact lookup is in `ISO`. Add any missing codes there.
- **Cost control.** Each `/api/enrich` = up to 4 SimilarWeb calls + 1 BuiltWith + 2
  Hunter + 1 Claude. Add a cache (e.g. keep results 24h keyed by domain) before you
  point a busy team at it.
- **Lock down CORS** in `.env` (`ALLOWED_ORIGINS`) before hosting anywhere public.
- **Not in flow of funds / no PII storage** — this server holds nothing; it proxies and
  returns. If you add caching, keep it to the report JSON, not raw contact dumps.
