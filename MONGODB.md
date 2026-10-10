# MongoDB and GridFS setup

The dashboard uses database `formial`, collection `creatives-n8n` for jobs, briefs, brand assets, sessions, login-rate limits and temporary upload parts. Every dashboard record has an application marker and a record type; existing unrelated records in the same collection are not read, overwritten or subject to the dashboard's expiry index. Images use the companion GridFS collections `creatives-n8n.files` and `creatives-n8n.chunks`. The app never accesses `doctors`, `summaries` or the pharmacy database. No database credential goes into n8n or browser JavaScript.

## Private connection

1. In your existing Atlas project, use a dedicated dashboard database user. Have your Atlas administrator restrict its permissions to the creative collections. Do not use an organization administrator credential or grant access to doctor or pharmacy records.
2. Atlas > Connect > Drivers > Node.js: obtain the connection string and replace its username/password placeholders privately. URL-encode special characters in database credentials.
3. Put the string in local `.env` as `MONGODB_URI`. Set `MONGODB_DATABASE=formial` and `MONGODB_COLLECTION=creatives-n8n`. These settings select the database and collection even if the URI's default database is different. Keep `STORAGE_BACKEND=local` while preparing migration. Do not paste the URI into chat or commit it.
4. Allow this computer's IP in Atlas Network Access, then run `npm.cmd run db:check`. No URI or password is printed. Network permissions for Vercel's deployment must also be planned; do not automatically open the cluster to every IP.

If the system resolver refuses Atlas SRV lookups, the optional `MONGODB_DNS_SERVERS=1.1.1.1,8.8.8.8` setting applies only to the dashboard's Node.js process. It does not alter Windows DNS or disable TLS verification. Keep it unset when the platform's normal resolver works.

## Preserve the current workspace

Run `npm.cmd run db:migrate` after existing jobs finish. It copies current images into GridFS, then jobs/assets/briefs. It checks file hashes, can resume an identical partial migration, and refuses to overwrite differing records. Local files remain untouched. Existing login sessions are not migrated.

After migration is verified, set `STORAGE_BACKEND=mongodb` and restart a single dashboard process. For local use, `N8N_PAYLOAD_VERSION=1` continues to support the existing published Cloud workflow. MongoDB mode automatically uses chunked browser uploads. Do not run two local-file dashboard processes against the same `data/` directory.

## Version 2 workflow for Vercel

`npm.cmd run workflow:mongodb` prepares `integration/formial-dashboard-mongodb.n8n.json`. Import it as a new inactive workflow. Connect the existing dashboard secret credential to Dashboard Webhook and the existing Google credential to all five Gemini nodes. The webhook path is `formial-dashboard-mongodb`, avoiding a collision with the currently published workflow.

Version 2 sends small job manifests with authenticated reference URLs. n8n fetches each reference using the job's private bearer token. Generated images upload back in 1 MiB binary parts; the completion callback contains file references and QA metadata, not base64 image data. Full original-reference review, exact-copy checks, canvas validation and human approval are retained. The first-test profile remains one 2K candidate with no repair and no automatic provider retries.

Publish the new workflow only after credentials are connected. Set `N8N_PAYLOAD_VERSION=2` and `N8N_WEBHOOK_URL` to its Production URL. Test a real authorized creative before retiring the old workflow. Import and paid generation of this new version are not performed automatically.

## Vercel deployment

Use the dashboard directory as the Vercel project root. The Node.js API entry is `api/index.mjs`; static files are in `public/`. Set these server-only variables in Vercel, not browser-prefixed variables:

| Variable | Value |
| --- | --- |
| `STORAGE_BACKEND` | `mongodb` |
| `MONGODB_URI` | Your private Atlas connection string |
| `MONGODB_DATABASE` | `formial` |
| `MONGODB_COLLECTION` | `creatives-n8n` |
| `GENERATION_MODE` | `n8n` |
| `N8N_PAYLOAD_VERSION` | `2` |
| `N8N_WEBHOOK_URL` | New workflow's Production URL |
| `N8N_WEBHOOK_SECRET` | Same secret as its Webhook credential |
| `DASHBOARD_PUBLIC_URL` | Your production HTTPS dashboard origin |
| `JOB_TIMEOUT_MINUTES` | `65` |

The deployment rejects local storage, the old payload protocol, demo mode and disabled authentication. The shared password is fixed in the server source; no `DASHBOARD_PASSWORD` environment variable is needed. Repository readers can see this password. Job dispatch is awaited before the serverless response, with no automatic generation retries. Shared MongoDB sessions and compare-and-swap updates prevent different instances overwriting one another's job state.

Vercel deployment protection must allow authenticated application callbacks to reach the API; an extra Vercel login screen in front of callbacks will block n8n. Do not remove the dashboard's own authentication. Verify API routing, streamed image/ZIP downloads and callbacks on a deployed preview before declaring production ready. Those deployment checks cannot be confirmed from local tests.

## Storage and operations

Upload parts and transfer records expire after 24 hours. Complete GridFS images remain until deliberately removed, including images from interrupted or abandoned finalized uploads. GridFS files do not use a TTL index because deleting only their metadata would orphan chunks. Monitor Atlas usage, define an explicit retention/archive policy, and use a reviewed cleanup job before high-volume production. Your existing cluster's storage quota applies to both images and document data.

This remains a password-protected single-team workspace, not a multi-tenant application. MongoDB credentials stay server-side; Gemini credentials stay in n8n. Use a dedicated database user, an appropriate network allowlist, backups and strong workspace authentication for production.

Sources: [MongoDB GridFS](https://www.mongodb.com/docs/drivers/node/current/crud/gridfs/), [connection pools](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/connection-pools/), [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js).
