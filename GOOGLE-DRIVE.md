# Google Drive image storage

MongoDB keeps jobs, briefs, reviews, login sessions and file references in `formial.creatives-n8n`. New image bytes and temporary upload-part bytes go to a dedicated private My Drive folder when `IMAGE_STORAGE_BACKEND=drive` is enabled. n8n's version 2 workflow stays unchanged: it still uploads 1 MiB parts through the dashboard API.

Drive does not replace MongoDB. The dashboard still needs a working MongoDB connection to open the workspace and track jobs. Switching images to Drive will not fix an Atlas connection or permission error by itself.

## One-time Google setup

Use user OAuth for a normal My Drive folder. A Gemini API key cannot authenticate Drive requests, and a service account cannot own files in a normal My Drive account.

1. In Google Cloud Console, select the appropriate project and enable **Google Drive API**.
2. Configure the OAuth consent app for your organization/account. Request only `https://www.googleapis.com/auth/drive.file`, not access to every file in Drive. If using an external app in Testing, add the chosen Google account as a test user. Drive refresh tokens for external Testing apps normally expire after seven days; use an appropriate Internal/Production consent setup for ongoing use.
3. Create an **OAuth client ID > Desktop app**. Put its client ID and secret privately in the dashboard `.env`:

```dotenv
GOOGLE_DRIVE_CLIENT_ID=your-desktop-client-id.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=your-private-client-secret
```

4. Run `npm.cmd run drive:authorize` on your computer. Open the printed Google sign-in link yourself and check the selected account/app before approving. The helper uses a loopback callback, state validation and PKCE. It creates a private **Formial Creatives** folder and saves `GOOGLE_DRIVE_REFRESH_TOKEN` and `GOOGLE_DRIVE_FOLDER_ID` into `.env` without printing credentials. It does not enable Drive storage automatically.
5. Run `npm.cmd run drive:check`. This verifies authentication and private writable folder access without uploading images.

Without a configured folder ID, the helper creates its own private folder. To use an existing My Drive folder, set `GOOGLE_DRIVE_FOLDER_ID` to the ID from its URL before authorization. Enable **Google Picker API** as well as Drive API in the same Google Cloud project. The Desktop OAuth flow opens Google Picker in your normal browser: select exactly that folder and confirm access. The helper rejects a different or missing selection and checks private writable access before saving credentials. No extra API key or all-Drive scope is requested. Do not make the folder public or shared with everyone in a domain.

## Preserve existing images

Stop new submissions and wait for active jobs to finish. Keep the current image backend enabled while migrating.

```powershell
npm.cmd run drive:migrate
npm.cmd run drive:migrate -- --apply
```

The first command is a dry-run inventory. The second copies referenced images to Drive and verifies downloaded SHA-256 hashes. It keeps the original GridFS files and existing job/asset IDs. It does not delete MongoDB images, change storage configuration or rerun Gemini. Do not run two migrations concurrently.

Once verification succeeds, configure the server-only fields below locally and in **Vercel > Project > Settings > Environment Variables > Production**:

| Variable | Value |
| --- | --- |
| `STORAGE_BACKEND` | `mongodb` |
| `IMAGE_STORAGE_BACKEND` | `drive` |
| `GOOGLE_DRIVE_CLIENT_ID` | Desktop OAuth client ID |
| `GOOGLE_DRIVE_CLIENT_SECRET` | Private client secret |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | Private token saved by the authorization helper |
| `GOOGLE_DRIVE_FOLDER_ID` | Dedicated app folder ID |

Keep MongoDB and n8n settings unchanged. Do not use browser-prefixed names for secrets. Restart the local dashboard or redeploy Vercel after changing variables. Copy the four Google settings through the private environment settings UI, never chat or GitHub.

## Verification and rollback

Test an upload, generation callback, private preview, original-byte download and ZIP export. `/api/config` reports `imageStorageBackend: "drive"` when enabled. Live Google authorization, migration and deployment require your account setup and cannot be confirmed by mocked tests.

Files that have not been copied remain readable from GridFS. Ready Drive mappings take precedence and are validated against the dedicated folder, application marker, size and SHA-256 checksum. Links in the dashboard stay the same; Google access tokens and raw Drive IDs are not sent to the browser. Downloads go through authenticated, non-publicly-cacheable dashboard routes. No public sharing permissions are created.

Do not simply switch back to GridFS after producing Drive-only creatives: those new files will not have GridFS copies. Keep Drive enabled to read them, or perform a separately reviewed reverse migration. Old GridFS copies are kept as backups and still consume Atlas space until a deliberate, verified cleanup is authorized.

Temporary upload parts are stored on Drive, with only metadata in MongoDB. Successfully finalized parts go to recoverable Drive Trash; they are not permanently deleted. Trashed files can still consume storage until removed. Interrupted uploads may leave app-owned parts behind; review these separately after jobs finish. No unrelated Drive files, folders, doctor records or pharmacy records are scanned or deleted.

Sources: [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [service-account storage limitations](https://developers.google.com/workspace/drive/api/guides/handle-errors#storageQuotaExceeded), [OAuth offline access](https://developers.google.com/identity/protocols/oauth2/web-server).
