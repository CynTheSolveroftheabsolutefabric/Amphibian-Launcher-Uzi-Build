# Amphibian Wisp Server

A tiny always-on proxy that the launcher tunnels **all game traffic** through (asset downloads
from Mojang's CDNs, libraries, Fabric maven, and multiplayer server connections). The deployed
site defaults to the shared community proxy (`wss://anura.pro/`), which is often overloaded and
stalls the asset-download phase. Hosting your own removes that bottleneck and makes multiplayer
snappier too.

Same package the dev server already uses (`@mercuryworkshop/wisp-js`) — just standalone.

## Deploy on Render (free, ~10 minutes, one-time)

1. Push this repo to GitHub (the `wisp-server/` folder is all Render needs).
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**.
3. **Build and deploy from a Git repository** → connect your GitHub account → pick
   `AmphibianIsToad/Amphibian-Launcher`.
4. Settings:
   - **Root Directory**: `wisp-server`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. **Create Web Service**. Wait for the first deploy, note the URL:
   `wss://<whatever-you-named-it>.onrender.com/`

From now on **every push to `main` redeploys the wisp server automatically** — no Actions,
no manual steps, nothing running on your laptop.

## Keep it awake (free tier sleeps after 15 min idle)

A sleeping instance wakes in ~30-60s, but the first player to connect would wait that out.
To make it effectively always-on, add a free uptime pinger:

- [cron-job.org](https://cron-job.org) (free account) → new cron job →
  URL `https://<your-app>.onrender.com/health` → every 10 minutes. Done.

## Point the launcher at it

Either way works:

- **Per visit** — open the site with `?wisp=wss://<your-app>.onrender.com/` appended.
- **Permanent** — edit `PROD_WISP_URL` in `frontend/src/net.ts` (one line), commit, push.
  The next Pages build picks it up.

## Smoke test

```bash
curl https://<your-app>.onrender.com/health   # -> ok
```

Then open the launcher with the `?wisp=` URL above and press Play — the console log line
`wisp server wss://<your-app>.onrender.com/` confirms the game is using your instance.

## Notes

- Private/loopback destinations are refused (`allow_private_ips` / `allow_loopback_ips` are
  `false`), so the public instance cannot be used as an SSRF relay into its host network.
- The `#main` note about Actions: GitHub Actions runners are ephemeral (6 h cap, no inbound
  connections) and hosting long-lived servers there is the fastest way to get the account
  flagged again. That's why the wisp server is a Render service that the repo deploys to,
  not an Actions job.
