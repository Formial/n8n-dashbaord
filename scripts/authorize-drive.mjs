import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import { DriveApi, DRIVE_APP } from '../drive-api.mjs';
import { parseEnv, updateDriveSecrets } from './env-file.mjs';
import { authorizationUrl, validatePickedFolder, authorizationFailure } from './drive-authorization.mjs';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const source = readFileSync(envPath, 'utf8'), env = parseEnv(source);
if (!env.GOOGLE_DRIVE_CLIENT_ID || !env.GOOGLE_DRIVE_CLIENT_SECRET) {
  console.error('Set the Google Desktop OAuth client ID and secret privately in .env first. See GOOGLE-DRIVE.md.'); process.exitCode = 1;
} else {
  const state = randomBytes(32).toString('hex'); let auth, verifier, finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/oauth2callback' || url.searchParams.get('state') !== state) { response.writeHead(400); response.end('Invalid authorization callback.'); return; }
    let stage = 'consent';
    try {
      if (!url.searchParams.get('code') || url.searchParams.has('error')) throw new Error('Authorization was not approved.');
      stage = 'folder-selection';
      validatePickedFolder(url.searchParams, env.GOOGLE_DRIVE_FOLDER_ID);
      stage = 'token-exchange';
      const { tokens } = await auth.getToken({ code: url.searchParams.get('code'), codeVerifier: verifier });
      stage = 'offline-token';
      if (!tokens.refresh_token) throw new Error('Offline authorization was not returned.');
      auth.setCredentials(tokens);
      let folderId = env.GOOGLE_DRIVE_FOLDER_ID;
      if (!folderId) {
        stage = 'folder-create';
        const setup = new DriveApi({ auth, folderId: 'setup-folder-pending' });
        const created = await setup.request('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Formial Creatives', mimeType: 'application/vnd.google-apps.folder', appProperties: { formialApp: DRIVE_APP, formialType: 'folder' } }) });
        folderId = (await created.json()).id;
      }
      stage = 'folder-check';
      await new DriveApi({ auth, folderId }).checkFolder();
      // Re-read so edits made during sign-in are preserved.
      stage = 'saving-settings';
      writeFileSync(envPath, updateDriveSecrets(readFileSync(envPath, 'utf8'), { GOOGLE_DRIVE_REFRESH_TOKEN: tokens.refresh_token, GOOGLE_DRIVE_FOLDER_ID: folderId }), { mode: 0o600 });
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end('Google Drive authorization saved privately. You can close this tab.');
      console.log('Google Drive authorized. The configured private destination folder is ready. Image storage has NOT been switched yet.'); finish();
    } catch (error) {
      const diagnostic = authorizationFailure(stage, error);
      response.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end('Drive authorization failed. ' + diagnostic);
      console.error('Drive authorization failed at ' + stage + ': ' + diagnostic); process.exitCode = 1; finish();
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  auth = new OAuth2Client(env.GOOGLE_DRIVE_CLIENT_ID, env.GOOGLE_DRIVE_CLIENT_SECRET, redirectUri);
  const proof = await auth.generateCodeVerifierAsync(); verifier = proof.codeVerifier;
  console.log('Open this Google sign-in link yourself and approve access only if the account and app are correct:');
  if (env.GOOGLE_DRIVE_FOLDER_ID) console.log('Select the configured destination folder when Google Picker opens. Use your normal browser, not an embedded browser.');
  console.log(authorizationUrl(auth, { state, proof, folderId: env.GOOGLE_DRIVE_FOLDER_ID }));
  const timeout = setTimeout(() => { console.error('Authorization timed out. Run the command again when ready.'); process.exitCode = 1; finish(); }, 15 * 60000);
  await completed; clearTimeout(timeout); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
