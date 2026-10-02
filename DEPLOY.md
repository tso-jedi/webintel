# Deploy the Merchant Intel backend

Goal: get an HTTPS URL you can paste into the tool's **⚙ Backend URL** field.
Pick **one** path below. ~5 minutes either way.

Before you start: put the `backend/` folder in a GitHub repo (it can be the repo root,
or a subfolder — both paths below assume the **backend folder is the repo root**; if it's
a subfolder, set the service's root directory to `backend` in the dashboard).

---

## Option A — Render (uses render.yaml, simplest)

1. Push the backend folder to a GitHub repo.
2. Render dashboard → **New → Blueprint** → connect the repo.
3. Render reads `render.yaml` and proposes the service. Click **Apply**.
4. It asks for the secret env vars — paste your keys:
   - `ANTHROPIC_API_KEY` (required for risk/fit)
   - `SIMILARWEB_API_KEY`, `BUILTWITH_API_KEY`, `HUNTER_API_KEY` (each optional — missing ones are skipped)
5. Deploy finishes → you get a URL like `https://merchant-intel.onrender.com`.
6. Verify: open `https://merchant-intel.onrender.com/api/health` — it lists which keys loaded.
7. In the tool: ⚙ → paste the base URL (`https://merchant-intel.onrender.com`, **no** `/api/health`).

> Free plan note: the service sleeps after ~15 min idle, so the **first** scan after a quiet
> spell takes ~50s to wake. Scans after that are fast. Upgrade to a paid instance to remove the sleep.

---

## Option B — Railway (uses Dockerfile)

1. Push the backend folder to a GitHub repo.
2. Railway → **New Project → Deploy from GitHub repo** → pick it. Railway detects the `Dockerfile`.
3. Project → **Variables** → add: `ANTHROPIC_API_KEY`, `SIMILARWEB_API_KEY`, `BUILTWITH_API_KEY`,
   `HUNTER_API_KEY`, and `ALLOWED_ORIGINS=*`.
4. **Settings → Networking → Generate Domain** → you get `https://<name>.up.railway.app`.
5. Verify `…/api/health`, then paste the base URL into the tool's ⚙ field.

---

## After it's live

- The merchant you're researching always goes in the **top bar**. The **⚙ Backend URL** is set
  **once** to your server and left alone. (Common slip: pasting the merchant's URL into the backend field.)
- Health check `…/api/health` is the quickest way to confirm the server is up and which vendor keys are active.

## Lock it down for real use

`ALLOWED_ORIGINS=*` is fine for testing. Once you settle on where the front end lives
(a hosted URL, or `http://localhost:8080` if you serve the HTML locally), set
`ALLOWED_ORIGINS` to exactly that origin so random sites can't call your server and burn your API quota.

## Cost guard

Each scan = up to 4 SimilarWeb + 1 BuiltWith + 2 Hunter + 1 Claude call. Before a team leans on it,
add a 24h per-domain cache in `server.js` (noted in README) so repeat lookups don't re-bill every vendor.

## Updating an existing deploy to v3

1. In the GitHub repo, **Add file → Upload files** and upload `server.js`, `checks.js`,
   `checks.test.js`, `package.json`, `README.md`, `DEPLOY.md` and `.env.example`. Commit to `main`.
2. Render auto-deploys from `main`. Open `…/api/health` — it should show `"version":"3.0.0"`.
3. Optional, in Render → **Environment**: add `OPENCORPORATES_API_TOKEN`. Add
   `DEAL_DESK_TOKEN` only after the frontend sends the `x-deal-desk-token` header,
   otherwise every scan returns 401.
4. Rollback: Render → Deploys → previous deploy → **Rollback**.
