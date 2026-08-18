/**
 * Generate the extension icons.
 *
 * Kept as code rather than committed binaries alone so the mark can be tweaked
 * without a design tool: `npm run icons` rewrites every size.
 * No dependencies — PNG encoding is zlib plus a CRC table.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const SIZES = [16, 32, 48, 128];
const OUT = new URL('../assets/icons/', import.meta.url);

const INK = [15, 23, 42];        // slate-900 backdrop
const SHIELD = [96, 165, 250];   // blue-400
const SHIELD_DARK = [37, 99, 235];
const EYE = [248, 250, 252];     // slate-50

/** Shield membership for normalised coordinates in [-1, 1]. */
function inShield(x, y) {
  if (y < -0.78 || y > 0.9) return false;
  const half = y <= 0.1 ? 0.62 : 0.62 * (1 - ((y - 0.1) / 0.8) ** 1.6);
  if (Math.abs(x) > half) return false;
  // Round the shoulders so the mark does not read as a plain pentagon.
  if (y < -0.5) {
    const t = (-0.5 - y) / 0.28;
    return Math.abs(x) <= half * Math.sqrt(Math.max(0, 1 - t * t)) + 0.12;
  }
  return true;
}

function inRoundedSquare(x, y, radius = 0.42) {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const limit = 1;
  if (ax <= limit - radius || ay <= limit - radius) return ax <= limit && ay <= limit;
  const dx = ax - (limit - radius);
  const dy = ay - (limit - radius);
  return dx * dx + dy * dy <= radius * radius;
}

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const samples = 3; // supersample so small sizes stay legible
  for (let py = 0; py < size; py += 1) {
    for (let pxi = 0; pxi < size; pxi += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = ((pxi + (sx + 0.5) / samples) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / samples) / size) * 2 - 1;
          const [cr, cg, cb, ca] = sample(x, y);
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = samples * samples;
      const o = (py * size + pxi) * 4;
      px[o] = Math.round(r / n);
      px[o + 1] = Math.round(g / n);
      px[o + 2] = Math.round(b / n);
      px[o + 3] = Math.round(a / n);
    }
  }
  return px;
}

/** Colour at one normalised point: rounded square, shield, then the eye. */
function sample(x, y) {
  if (!inRoundedSquare(x, y)) return [0, 0, 0, 0];
  const sx = x / 0.82;
  const sy = (y + 0.05) / 0.82;

  if (inShield(sx, sy)) {
    // Eye: an open pupil in the middle of the shield — visibility, not a lock.
    const ex = sx / 0.42;
    const ey = (sy + 0.08) / 0.24;
    const inEye = ex * ex + ey * ey <= 1;
    const inPupil = sx * sx + (sy + 0.08) ** 2 <= 0.019;
    if (inPupil) return [...SHIELD_DARK, 255];
    if (inEye) return [...EYE, 255];
    const shade = sy < -0.1 ? SHIELD : SHIELD_DARK;
    return [...shade, 255];
  }
  return [...INK, 255];
}

/* ------------------------------------------------------------ PNG encoding */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, size, render(size));
  writeFileSync(new URL(`icon${size}.png`, OUT), png);
  console.log(`assets/icons/icon${size}.png (${png.length} bytes)`);
}
