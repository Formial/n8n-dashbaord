import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuth2Client } from 'google-auth-library';
import { authorizationUrl, validatePickedFolder, authorizationFailure } from '../scripts/drive-authorization.mjs';
import { DRIVE_SCOPE } from '../drive-api.mjs';

const folderId = '1gTE-JUPOBbfpBdbYq5cVtQKfgBWVeczO';
const auth = new OAuth2Client('test-client', 'test-secret', 'http://127.0.0.1:12345/oauth2callback');
const options = { state: 'test-state', proof: { codeChallenge: 'test-proof' } };

test('Existing folder authorization uses Desktop Picker with only drive.file scope', () => {
  const url = new URL(authorizationUrl(auth, { ...options, folderId }));
  assert.equal(url.origin, 'https://accounts.google.com');
  for (const [key, value] of Object.entries({ scope: DRIVE_SCOPE, state: 'test-state', code_challenge: 'test-proof', code_challenge_method: 'S256', access_type: 'offline', include_granted_scopes: 'false', prompt: 'consent', trigger_onepick: 'true', allow_multiple: 'false', allow_folder_selection: 'true', mimetypes: 'application/vnd.google-apps.folder', file_ids: folderId })) assert.equal(url.searchParams.get(key), value);
  assert(!url.toString().includes('test-secret'));
  assert.throws(() => authorizationUrl(auth, { ...options, folderId: '../invalid' }));
});

test('Folder selection must exactly match the requested destination before credentials are saved', () => {
  validatePickedFolder(new URLSearchParams({ picked_file_ids: folderId }), folderId);
  for (const params of [new URLSearchParams(), new URLSearchParams({ picked_file_ids: 'other-folder' }), new URLSearchParams({ picked_file_ids: folderId + ',other-folder' }), new URLSearchParams([['picked_file_ids', folderId], ['picked_file_ids', folderId]])]) assert.throws(() => validatePickedFolder(params, folderId));
});

test('New app-created folder flow does not request Picker access', () => {
  const url = new URL(authorizationUrl(auth, options));
  assert.equal(url.searchParams.get('scope'), DRIVE_SCOPE);
  assert(!url.searchParams.has('trigger_onepick'));
  validatePickedFolder(new URLSearchParams(), undefined);
});

test('Authorization diagnostics identify configuration failures without exposing Google responses or secrets', () => {
  const secret = 'do-not-print-private-token';
  for (const stage of ['consent', 'folder-selection', 'token-exchange', 'offline-token', 'saving-settings', 'folder-check', 'folder-create']) assert(!authorizationFailure(stage, { message: secret, response: { data: { error: secret } }, code: secret }).includes(secret));
  assert.match(authorizationFailure('folder-check', { code: 'DRIVE_API_DISABLED' }), /Enable Google Drive API/);
  assert.match(authorizationFailure('folder-check', { code: 'DRIVE_HTTP_404' }), /cannot access/);
  assert.match(authorizationFailure('folder-selection', {}), /selection/);
  assert.match(authorizationFailure('token-exchange', { response: { data: { error: 'invalid_client', secret } } }), /same Desktop app/);
});
