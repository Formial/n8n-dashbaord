import { deflateSync } from 'node:zlib';
import { crc32 } from '../lib.mjs';
export function png(width = 32, height = 32) {
  function chunk(type, data) { const t = Buffer.from(type), len = Buffer.alloc(4), checksum = Buffer.alloc(4); len.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([t,data]))); return Buffer.concat([len,t,data,checksum]); }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height,190); for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
export const checks = ['product_fidelity','brand_consistency','text_accuracy','required_items_present','claims_accurate','composition_clean','no_visible_artifacts'];
export function review(score = 96) { return { score, pass: true, issues: [], ...Object.fromEntries(checks.map(k => [k,true])) }; }
