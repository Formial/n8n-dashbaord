import { DriveApi, driveOAuth } from '../drive-api.mjs';
try {
  await new DriveApi({ auth: driveOAuth(), folderId: process.env.GOOGLE_DRIVE_FOLDER_ID }).checkFolder();
  console.log('Google Drive OAuth and private writable folder access are verified. No images were uploaded.');
} catch (error) { console.error('Google Drive is not ready. Check private OAuth configuration and folder access. ' + (error.code || error.name)); process.exitCode = 1; }
