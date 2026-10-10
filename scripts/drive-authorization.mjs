import { DRIVE_SCOPE } from '../drive-api.mjs';
import { check } from '../lib.mjs';

export function authorizationUrl(auth, { state, proof, folderId }) {
  if (folderId) check(/^[A-Za-z0-9_-]{10,200}$/.test(folderId), 'Invalid Google Drive folder ID.');
  const url = new URL(auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [DRIVE_SCOPE], state, code_challenge: proof.codeChallenge, code_challenge_method: 'S256', include_granted_scopes: false }));
  if (folderId) {
    url.searchParams.set('trigger_onepick', 'true');
    url.searchParams.set('allow_multiple', 'false');
    url.searchParams.set('allow_folder_selection', 'true');
    url.searchParams.set('mimetypes', 'application/vnd.google-apps.folder');
    url.searchParams.set('file_ids', folderId);
  }
  return url.toString();
}

export function validatePickedFolder(params, folderId) {
  if (!folderId) return;
  const selections = params.getAll('picked_file_ids');
  check(selections.length === 1 && selections[0] === folderId, 'Select only the configured destination folder in Google Picker.');
}

export function authorizationFailure(stage, error) {
  if (stage === 'consent') return 'Google consent was cancelled or no authorization code was returned.';
  if (stage === 'folder-selection') return 'Google did not return exactly the configured folder selection. Select the destination folder and confirm it in Google Picker.';
  if (stage === 'offline-token') return 'Google did not return an offline refresh token. Approve offline access with the configured Desktop OAuth client.';
  if (stage === 'saving-settings') return 'The private .env file could not be updated. Check local file permissions.';
  if (error?.code === 'DRIVE_API_DISABLED') return 'Google Drive API is disabled in the OAuth client project. Enable Google Drive API, not only Google Picker API.';
  if (error?.code === 'DRIVE_QUOTA') return 'The selected Google account has no remaining Drive storage quota.';
  if (stage === 'token-exchange') {
    const code = error?.response?.data?.error;
    if (['invalid_client', 'unauthorized_client'].includes(code)) return 'Google rejected the OAuth client. Check that client ID and secret belong to the same Desktop app.';
    if (code === 'invalid_grant') return 'Google rejected the authorization code. Retry with a fresh link and do not refresh an old callback page.';
    return 'Google token exchange failed. Check OAuth client configuration and network access.';
  }
  if (stage === 'folder-check') {
    if (error?.code === 'DRIVE_HTTP_404') return 'The selected account or this OAuth app cannot access the destination folder. Check the account and Google Picker selection.';
    if (error?.code === 'DRIVE_HTTP_403') return 'Google denied access to the destination folder. Check Drive API enablement, account permissions and organization policy.';
    if (error?.message === 'Use a private Google Drive folder, not a publicly or domain-shared folder.') return 'The destination folder is public or domain-shared. Change its General access to Restricted before retrying.';
    if (error?.message === 'Google Drive folder is missing or not writable.') return 'The destination is not a writable Drive folder for this account.';
    return 'The private destination folder could not be verified. Check account access and network connectivity.';
  }
  return 'Drive authorization failed. No credential values are included in this diagnostic.';
}
