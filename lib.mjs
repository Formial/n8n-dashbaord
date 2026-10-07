import { randomUUID } from 'node:crypto';

export const FILE_LIMIT = 5 * 1024 * 1024;
export const TOTAL_LIMIT = 8 * 1024 * 1024;
export const groups = { reference_image: 1, product_images: 3, item_images: 3, logo: 1 };
export const choices = {
  reference_role: ['Product photo', 'Style reference', 'Scene to edit'],
  theme: ['Current social', 'Website green', 'Match uploaded assets'],
  format: ['Feed 4:5', 'Square 1:1', 'Story 9:16', 'Landscape 16:9'],
  copy_mode: ['Branded ad', 'Photography only'],
};
export const defaults = {
  name: 'Personal care, personal formula', campaign: 'Introduce personalised skincare with dermatologist guidance.',
  audience: 'Adults in India seeking a simpler, personalised skincare routine.',
  headline: 'Skincare, made personal.', supporting_line: 'Personalised formulas. Dermatologist guidance.',
  cta: 'Find your custom formula', must_include: '', avoid: '', reference_role: 'Product photo',
  theme: 'Current social', format: 'Feed 4:5', copy_mode: 'Branded ad',
};
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function check(condition, message, status = 400) { if (!condition) throw new HttpError(status, message); }
export function validateBrief(input) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Provide a campaign brief.');
  const limits = { name: 100, campaign: 1800, audience: 400, headline: 90, supporting_line: 140, cta: 55, must_include: 1200, avoid: 800 };
  const result = {};
  for (const [field, limit] of Object.entries(limits)) {
    const value = input[field] ?? defaults[field];
    check(typeof value === 'string' && value.trim().length <= limit, `${field} must be text, up to ${limit} characters.`);
    result[field] = value.trim();
  }
  check(result.name.length > 0 && result.campaign.length > 0, 'Campaign name and brief are required.');
  for (const [field, allowed] of Object.entries(choices)) {
    result[field] = input[field] ?? defaults[field];
    check(allowed.includes(result[field]), `Invalid ${field}.`);
  }
  return result;
}
export function imageMime(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'image/png';
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new HttpError(400, 'Upload a valid PNG, JPEG or WebP image. SVG and other file types are not accepted.');
}
export const canvasSizes = {
  'Feed 4:5': { '1K': [928,1152], '2K': [1856,2304], '4K': [3712,4608] },
  'Square 1:1': { '1K': [1024,1024], '2K': [2048,2048], '4K': [4096,4096] },
  'Story 9:16': { '1K': [768,1376], '2K': [1536,2752], '4K': [3072,5504] },
  'Landscape 16:9': { '1K': [1376,768], '2K': [2752,1536], '4K': [5504,3072] },
};
export function imageDimensions(bytes, mimeType) {
  if (mimeType === 'image/png') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      check(bytes[offset++] === 255, 'Invalid JPEG marker.');
      while (offset < bytes.length && bytes[offset] === 255) offset++;
      const marker = bytes[offset++]; if ([217,218].includes(marker)) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      const length = bytes.readUInt16BE(offset); check(length >= 2 && offset + length <= bytes.length, 'Invalid JPEG segment.');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) return [bytes.readUInt16BE(offset + 5),bytes.readUInt16BE(offset + 3)];
      offset += length;
    }
  }
  throw new HttpError(400, 'Candidate image dimensions cannot be read.');
}
export function validateReferences(refs) {
  const count = Object.fromEntries(Object.keys(groups).map(k => [k, 0]));
  let total = 0;
  for (const ref of refs) {
    check(Object.hasOwn(groups, ref.field), 'Unknown upload field.');
    check(++count[ref.field] <= groups[ref.field], `Too many ${ref.field.replaceAll('_', ' ')} files.`);
    check(ref.size > 0 && ref.size <= FILE_LIMIT, 'Each image must be nonempty and at most 5 MiB.');
    total += ref.size;
  }
  check(count.reference_image === 1, 'Choose exactly one main reference image.');
  check(total <= TOTAL_LIMIT, 'Combined images must be at most 8 MiB.');
}
export const id = () => randomUUID();
export const escapeXml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
export function demoSvg(brief, refData, variant) {
  const sizes = { 'Feed 4:5': [800, 1000], 'Square 1:1': [800, 800], 'Story 9:16': [720, 1280], 'Landscape 16:9': [1200, 675] };
  const [w, h] = sizes[brief.format];
  const green = brief.theme === 'Website green';
  const bg = green ? '#e7eadb' : variant === 1 ? '#dceafa' : '#e7eaef';
  const copy = brief.copy_mode === 'Photography only' ? '' : `<text x="${w * .085}" y="${h * .15}" font-family="Arial,sans-serif" font-size="${w * .047}" fill="#214964">${escapeXml(brief.headline || defaults.headline)}</text><text x="${w * .085}" y="${h * .21}" font-family="Arial,sans-serif" font-size="${w * .018}" fill="#53748c">${escapeXml(brief.supporting_line || defaults.supporting_line)}</text><text x="${w * .085}" y="${h * .89}" font-family="Arial,sans-serif" font-size="${w * .021}" fill="#214964">${escapeXml(brief.cta || defaults.cta)} →</text><text x="${w * .085}" y="${h * .94}" font-family="Arial,sans-serif" font-size="${w * .017}" fill="#53748c">formial.in</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${bg}"/><circle cx="${w * .85}" cy="${h * .55}" r="${w * .43}" fill="white" opacity=".35"/><text x="${w * .085}" y="${h * .07}" font-family="Arial,sans-serif" font-size="${w * .018}" fill="#214964" letter-spacing="3">FORMIAL LABS</text>${copy}<image x="${w * (variant === 1 ? .13 : .24)}" y="${h * .28}" width="${w * .64}" height="${h * .52}" preserveAspectRatio="xMidYMid meet" href="${refData}"/><text x="${w * .085}" y="${h * .98}" font-family="Arial,sans-serif" font-size="${w * .014}" fill="#6f8291">DEMO LAYOUT ${variant} · NOT AI GENERATED · NOT REVIEWED</text></svg>`;
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zip(entries) {
  const files = [], central = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), crc = crc32(data), header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(n.length, 26);
    files.push(header, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += header.length + n.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}
