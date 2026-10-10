# Dashboard ↔ n8n integration

## Configure

1. Import `integration/formial-dashboard.n8n.json` as a **new inactive workflow**. It preserves generation, visual checks, literal transcription checks, native canvas validation, selection and the maximum-one-repair behavior of the original. It replaces n8n Form Trigger/completion with an asynchronous Webhook and authenticated callbacks. No credentials are embedded in the JSON.
2. In **Dashboard Webhook**, select/create Header Auth: name `x-formial-secret`; value a long random secret. Put the same value in the dashboard's server-only `N8N_WEBHOOK_SECRET`.
3. In **Creative Director**, **Generate Candidates**, **Inspect Candidates**, **Repair Candidate**, and **Inspect Repair**, select the company's Google Header Auth credential: name `x-goog-api-key`; value the raw Gemini API key. These are the only five Google nodes. Do not put the key in the dashboard or a browser field.
4. Confirm **Brand Settings**: `gemini-3.1-pro-preview` for direction/review, `gemini-3-pro-image` for Nano Banana Pro, `4K`, two candidates, threshold 90, one repair maximum. `gemini-3.1-flash-image` is also supported by the existing pipeline. Verify billing/quota/model access in your Google project. For an initial paid connectivity test you can reduce to 2K/one candidate/no repair.
5. Activate the new workflow, copy its **Production Webhook URL**, and set `N8N_WEBHOOK_URL`. n8n's Webhook uses Header Auth and returns immediately with 202, as described in the [n8n Webhook documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/).
6. Copy `.env.example` to `.env`; set `GENERATION_MODE=n8n`, the webhook URL/secret and `DASHBOARD_PUBLIC_URL` to a URL **reachable from n8n**. Restart the dashboard. A container cannot reach the host dashboard through its own `127.0.0.1`; configure a host-reachable address. A remote n8n instance needs a reachable HTTPS dashboard URL and a workspace password.
7. Submit a real authorized product reference and inspect the n8n execution, progress callbacks, both returned images, exact copy, report and ZIP. Live import/execution and paid generation have not been performed during implementation because no endpoint or credentials were supplied.

The copied workflow uses the [Google REST ImageResponseFormat](https://ai.google.dev/api/generate-content#ImageResponseFormat): `responseModalities: ["TEXT", "IMAGE"]`, `responseFormat.image.aspectRatio: "ASPECT_RATIO_FOUR_BY_FIVE"` and `imageSize: "IMAGE_SIZE_FOUR_K"`. It keeps the original 19,000,000-byte serialized request ceiling. PNG/JPEG results retain their original bytes. Native 4K canvases are 3712×4608, 4096×4096, 3072×5504 and 5504×3072 for feed, square, story and landscape respectively. Automated QA requires score ≥90, all seven checks, zero issues, literal copy transcription and correct dimensions. No automatic retry can trigger additional provider calls.

## n8n Cloud migration

Run `node scripts/adapt-workflow.mjs --cloud` to create `integration/formial-dashboard-cloud.n8n.json`. This separate inactive workflow starts with one 2K candidate and no repair, retains the full accuracy review, and disables successful execution-data saving. It does not change the original two-candidate 4K export. Cloud still has memory limits; this profile reduces the first test's workload but does not guarantee it will succeed.

Import into the Cloud workspace and create the two Header Auth credentials privately there. Credentials from Render are not included in the JSON. Connect the Google credential to all five Gemini nodes and the dashboard secret credential to Dashboard Webhook. Publish only after both are ready. Copy Dashboard Webhook's Production URL into the dashboard `.env` as `N8N_WEBHOOK_URL`, preserving the existing password, secret, port and callback origin, and restart the dashboard. The `/assistant` page is not a webhook URL. Cloud does not need Render's reverse-proxy environment settings. Keep the current Cloudflare tunnel running for callbacks while the dashboard remains local.

## Request contract (version 1)

The browser sends `multipart/form-data` to `POST /api/jobs` with:

- `brief`: JSON string containing name, campaign, audience, reference_role, theme, format, copy_mode, headline, supporting_line, cta, must_include and avoid.
- Image fields: `reference_image`, `product_images`, `item_images`, `logo`.
- `savedAssets`: JSON array of `{ "id": "asset UUID", "field": "image field" }`.

The dashboard validates and persists the job **before** asynchronous dispatch. It returns 202 with a public job object, including its durable UUID. The browser polls `GET /api/jobs/:id`; leaving the page does not cancel generation.

The server sends JSON to n8n with `x-formial-secret`:

```json
{
  "version": 1,
  "jobId": "server-issued UUID",
  "callbackUrl": "https://dashboard.example.com/api/n8n/callback/server-issued-UUID",
  "callbackToken": "private random token issued by server",
  "fields": { "campaign": "...", "reference_role": "Product photo" },
  "files": [
    { "field": "reference_image", "fileName": "product.png", "mimeType": "image/png", "data": "base64 bytes" }
  ]
}
```

Normalization creates n8n binary fields with binary-data helpers (compatible with filesystem-backed storage). Duplicate product/item fields gain numeric suffixes. It revalidates counts, MIME/signatures, base64, file size, combined size and the callback envelope. Arbitrary browser-provided settings, credentials, URLs and provider model overrides are not forwarded.

## Callbacks

All callbacks use `POST /api/n8n/callback/:jobId` with `Authorization: Bearer <per-job callbackToken>`. The token is distinct for every job and is available only in server storage and the authenticated n8n execution. It is not a browser session or a company provider credential.

Progress:

```json
{ "version": 1, "jobId": "UUID", "event": "progress", "stage": "generating" }
```

Stages: directing, generating, reviewing, repairing. Packaging is included in local demo progress; the live workflow sends a completion event after packaging. Progress notification nodes restore every original item, preserving two separate candidate generation and review requests.

Completion:

```json
{
  "version": 1,
  "jobId": "UUID",
  "event": "complete",
  "status": "qa_pass",
  "selectedId": 1,
  "report": {
    "status": "qa_pass",
    "selected_candidate": 1,
    "model_assessment_only": true,
    "requested_size": "3712x4608",
    "image_resolution": "4K"
  },
  "candidates": [
    {
      "id": 1,
      "mimeType": "image/png",
      "data": "base64 bytes",
      "width": 3712,
      "height": 4608,
      "dimensionsMatch": true,
      "review": {
        "score": 96,
        "pass": true,
        "issues": [],
        "product_fidelity": true,
        "brand_consistency": true,
        "text_accuracy": true,
        "required_items_present": true,
        "claims_accurate": true,
        "composition_clean": true,
        "no_visible_artifacts": true
      }
    }
  ]
}
```

The actual report additionally contains the original prompt, brief, direction, reference metadata, reviews, warnings, repair flag and usage. Uploaded reference bytes are excluded from reports. The server validates candidate IDs, count, image signature, canonical base64, actual header dimensions, scores, checks, selected ID and report agreement. At most three candidates and 50 MiB of returned image bytes are stored. Callback bodies have a 72 MiB ceiling; adjust reverse-proxy limits to accommodate the complete JSON body. n8n submission bodies are under approximately 12 MiB for the supported reference limit; its webhook/proxy limit must accommodate that.

Failure:

```json
{ "version": 1, "jobId": "UUID", "event": "failed" }
```

Provider and Code node failures route to an explicit failure callback. Raw error contents are not forwarded because they may include request/provider details. See n8n execution history for the exact cause. Callback delivery itself cannot report an unreachable dashboard; the dashboard eventually marks the job timed out. Results stay in the n8n execution for recovery. The [n8n error-handling guide](https://docs.n8n.io/flow-logic/error-handling/) describes execution inspection and error workflows.

Callback replay cannot overwrite completed/failed jobs. Expired jobs reject late replacement by returning `{ "ok": true, "ignored": true }`. Submission timeouts are not retried automatically: check executions before starting a revision, because n8n may have received the request and incurred charges.

## Operational scope

Use one dashboard process, start with one generation at a time, and apply n8n execution-retention limits. n8n executions can contain uploaded images, generated base64 and callback tokens; restrict editor access. Remote deployment requires HTTPS and the server-side workspace login; `DASHBOARD_PASSWORD` is no longer used. Per-user authorization, a production queue, audit export and retention controls are future work.
