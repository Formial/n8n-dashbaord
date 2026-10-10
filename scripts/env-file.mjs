import { parseEnv } from 'node:util';

export { parseEnv };

// Runtime connection settings are simple values. Preserve all other lines,
// including the original quoting of passwords and secrets.
export function updateRuntimeEnv(source, updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || !/^[A-Za-z0-9:/._-]+$/.test(value)) {
      throw new Error('Invalid runtime environment setting: ' + key);
    }
  }
  const remaining = new Set(Object.keys(updates));
  const lines = source.trimEnd().split(/\r?\n/).map(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !Object.hasOwn(updates, match[1])) return line;
    remaining.delete(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const key of remaining) lines.push(`${key}=${updates[key]}`);
  return lines.join('\n') + '\n';
}

export function updateDriveSecrets(source, updates) {
  const allowed = ['GOOGLE_DRIVE_REFRESH_TOKEN', 'GOOGLE_DRIVE_FOLDER_ID'];
  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key) || typeof value !== 'string' || !value || /[\r\n"\\]/.test(value)) throw new Error('Invalid private Google Drive setting.');
  }
  const remaining = new Set(Object.keys(updates));
  const lines = source.trimEnd().split(/\r?\n/).map(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !Object.hasOwn(updates, match[1])) return line;
    remaining.delete(match[1]); return `${match[1]}="${updates[match[1]]}"`;
  });
  for (const key of remaining) lines.push(`${key}="${updates[key]}"`);
  return lines.join('\n') + '\n';
}
