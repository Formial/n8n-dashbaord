# Formial creative dashboard

Optional private Google Drive image storage: see [GOOGLE-DRIVE.md](GOOGLE-DRIVE.md). MongoDB remains the metadata database; Drive can store image bytes and upload parts. Existing images are preserved until a verified migration.

MongoDB and Vercel migration: see [MONGODB.md](MONGODB.md). The target is `formial.creatives-n8n`, with GridFS companion collections for images. Keep local storage active until the private Atlas connection and migration are verified.

A local creative workspace with a server backend and an asynchronous n8n integration. Includes validated uploads with previews and reference roles, saved brand assets, reusable campaign briefs, generation progress, candidate comparison and selection, individual/report/ZIP downloads, human decisions, persistent history, and explicit revisions that preserve previous jobs.

The interface uses a pale blue and silver palette with clean sans-serif typography. The main screen shows the reference, brief and format; extra images and detailed copy/settings are collapsed by default. Upload the approved current logo in **Brand assets** with the **Brand logo** role to use it in the sidebar and preview. Without supplied logo artwork, the interface uses plain FORMIAL LABS text; it does not recreate the mark.

## Run locally

Requires Node.js 24 or newer. No third-party runtime packages, build step or external fonts are required.

```powershell
git clone https://github.com/Formial/n8n-dashbaord.git
cd n8n-dashbaord
npm.cmd ci
npm.cmd start
```

Open http://127.0.0.1:3001. The default mode is **demo**: it arranges the uploaded reference into two clearly labeled SVG layouts. It makes no Google calls and assigns no quality score. Uploads and campaign data persist in `dashboard/data/`. Demo ZIPs contain SVG layouts and a report; live ZIPs contain the returned PNG/JPEG bytes.

```powershell
npm.cmd test
npm.cmd run workflow
```

Tests use synthetic PNG fixtures, mocked Google responses and a local mock webhook. They never make billable calls. The adapted workflow is generated at `integration/formial-dashboard.n8n.json`. Its credential-free source is bundled in `integration/source/formial-ad-creative.n8n.json`, and the behavioral verifier is `scripts/verify-workflow.mjs`. No files outside the repository are required.

## Connect Gemini + Nano Banana

Follow [INTEGRATION.md](INTEGRATION.md). Create `.env` from `.env.example`, configure an authenticated production n8n webhook and its callback URL, and select the Google Header Auth credential in all five provider nodes. Google credentials stay in n8n. The dashboard never receives or exposes the company API key.

The default workflow uses Gemini 3.1 Pro for direction/review and Nano Banana Pro for two native 4K image candidates, with at most one targeted repair. The adapted copy uses REST `generationConfig.responseFormat.image` with enum values such as `ASPECT_RATIO_FOUR_BY_FIVE` and `IMAGE_SIZE_FOUR_K`. It accepts returned PNG/JPEG and preserves bytes. See [Google REST image-output reference](https://ai.google.dev/api/generate-content#ImageResponseFormat) and [Gemini 3.1 Pro documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview).

## Storage and access

- A shared workspace login uses a fixed server-side password in `dashboard-server.mjs`; `DASHBOARD_PASSWORD` is no longer read. Anyone with access to the server source can see this shared password. Use HTTPS for remote access. Sessions use an HttpOnly, SameSite=Strict cookie with a 12-hour lifetime. No roles or individual accounts are implemented.
- Assets, references, generated files, briefs and reports are stored on this server. Back up `data/` as a unit. This is a single-process local application with atomic JSON persistence, not a distributed service.
- Each upload is at most 5 MiB, with 8 MiB total per job. Main reference: exactly one; product/item photos: up to three each; logo: up to one. The browser decodes selected images; the server and workflow validate file signatures. Server signature validation is not a full image decoder.
- Jobs have UUIDs and private random callback tokens. Callback tokens and n8n credentials never appear in public job responses or downloads. Progress cannot move backward; terminal results cannot be overwritten by replayed callbacks.
- Removing a saved asset removes its library entry. Reference bytes remain for earlier jobs and revisions. There is no file garbage collector or retention scheduler yet.
- A server restart preserves live jobs for callbacks. Interrupted demo jobs become recoverable failures. Jobs exceeding the configured 65-minute deadline are marked failed when next accessed. Check n8n before creating another billable job.
- Downloads record the dashboard selection and human decision alongside the original automated report. Selecting another candidate resets the human decision to pending. Automated QA never grants human approval.
- Requesting changes creates a new job using the original uploaded references and explicit revision instructions. It does not feed the previous candidate as an additional reference. The previous images and report remain available.

## Verification

See [VERIFICATION.md](VERIFICATION.md) for completed checks and live/visual verification limits.
