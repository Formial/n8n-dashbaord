# Temporary HTTPS testing

The dashboard uses Cloudflare Quick Tunnel for testing, not permanent hosting.
Its generated URL stops working when the tunnel process stops and changes on
each restart. Keep the laptop awake and online.

The dashboard password is in `.env`, under `DASHBOARD_PASSWORD`. Never share the
webhook secret or Google API key. Only the dashboard password is used to log in.

## Start

From this dashboard folder, with port 3002 free:

```powershell
npm.cmd run tunnel -- --port=3002
```

This starts password-protected demo mode. The script updates `.env` with the
HTTPS callback origin automatically, preserves existing credentials, and binds
the server only to loopback. Open the HTTPS URL printed by the command, rather
than an older localhost dashboard. Do not run two dashboards against the same
data folder or submit jobs from an older dashboard process.

Once the n8n workflow is published and its credentials checked, start live mode:

```powershell
npm.cmd run tunnel -- --port=3002 --live
```

Live submissions invoke paid Gemini APIs. Do not submit another job or revision
until you have inspected the previous execution when a request fails.

Press Ctrl+C in the startup terminal to stop both child processes. A background
instance must be stopped before starting another one; ask Codex to stop the
specific test instance if it was started in the background.

## Where values go

- Dashboard login: the `.env` value `DASHBOARD_PASSWORD`.
- n8n Dashboard Webhook credential: header `x-formial-secret`, value from
  `.env` `N8N_WEBHOOK_SECRET`.
- All five Gemini nodes: header `x-goog-api-key`, raw Google AI Studio API key.
- Callback URL: generated automatically by this script and attached to each job.
- Production webhook: already configured in `.env` `N8N_WEBHOOK_URL`.

The Cloudflare client is stored in `.tools/cloudflared.exe`; logs are in
`.runtime/tunnel.log`. Both folders and `.env` are excluded from Git. No tunnel
is installed as a Windows service.
