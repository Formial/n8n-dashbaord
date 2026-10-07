# Verification

Verified on 2026-10-05 with Node.js 24.13.1.

`npm.cmd --prefix dashboard test` passes nine test groups:

1. Complete local primary flow: upload, reuse saved asset, save brief, asynchronous progress, two candidates, selection, human decisions, validated ZIP and report, preserved revisions, asset removal and restart persistence.
2. Rejection of missing references, spoofed signatures, excessive file counts/sizes, invalid themes/fields, unsafe origins, traversal and unknown jobs.
3. Workspace password authentication, Unicode passwords, HttpOnly/SameSite cookies, login throttling and logout.
4. Real HTTP calls between the server and a local mock n8n receiver: authenticated dispatch, private callback tokens, progress monotonicity, callback authentication, result dimension validation, failure delivery, replay safety and secret isolation.
5. All original **16 workflow behavioral groups**, run separately against the original and adapted JSON using mocked Google responses. Checks include reference roles, individual image/review requests, exact-copy transcription, PNG/JPEG header dimensions, one-repair limit, worse-repair selection, malformed model responses and 19 MB request limits.
6. Adapted graph: authenticated immediate-202 trigger, progress item restoration, explicit failure paths and absence of built-in form completion.
7. Dashboard envelope normalization, filesystem-backed binary fields, multi-image preservation and malformed request rejection.
8. Result adapter: filesystem-backed candidate/report extraction into the callback contract.
9. The shipped client JavaScript executed with a minimal document adapter against the real local HTTP server: every screen, submission, comparison/selection, human approval, revision UI, saved presets/history and escaped user text. This tests client behavior and API wiring; it is not visual browser verification.

The dashboard server starts successfully on http://127.0.0.1:3001 in explicit **demo** mode. Static assets and the configuration endpoint are available. A demo never calls Google or assigns a quality score.

## Remaining verification limits

- No n8n endpoint, deployment credentials or company Google API key were supplied. Import into n8n, real n8n node runtime, account-specific model access and paid end-to-end generation remain unverified. The provider pipeline and request/result contract were tested with mocks; that does not prove live service behavior.
- Browser automation failed repeatedly with `Unable to load browser request-header policy`, including after resetting its runtime. Consequently screenshot-based QA and interactive desktop/mobile layout verification could not be completed. Responsive CSS is implemented at 1500, 1100, 850 and 650 px, but visual behavior must be checked in a functioning browser session.
- Server validation reads signatures and PNG/JPEG dimensions; it is not a full image decoder. The browser decodes selected local files for early feedback. Synthetic PNG fixtures fully encode image data; JPEG fixtures in the inherited harness check headers only.
- Automated visual review and its transcription are model assessments. Neither implies human approval or guarantees exact packaging/text fidelity.

No billable Google request, publishing action or live n8n mutation occurred.
