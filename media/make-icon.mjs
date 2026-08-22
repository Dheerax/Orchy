/**
 * Resize media/logo.png into the 128×128 media/icon.png the Marketplace wants.
 *
 *   node media/make-icon.mjs
 *
 * Adding an image toolchain to a project with no other binary assets is a poor
 * trade for one file, so this decodes the PNG, box-filters it down and encodes
 * the result — about a hundred lines against a dependency tree.
 *
 * The source is a 1254px RGBA image with a transparent background. The
 * Marketplace composites icons on whatever it likes, so transparency is flattened
 * onto the same near-black the extension's own panels use.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const SIZE = 128;
const BG = [13, 17, 23]; // the panel background, so the mark sits on its own ground

const src = new URL('./logo.png', import.meta.url);
const raw = readFileSync(src);

/* ---------- decode ---------- */

function chunks(buf) {
  const out = [];
  let at = 8; // skip the signature
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    out.push({ type, data: buf.subarray(at + 8, at + 8 + len) });
    at += len + 12;
  }
  return out;
}

const parts = chunks(raw);
const ihdr = parts.find((c) => c.type === 'IHDR').data;
const width = ihdr.readUInt32BE(0);
const height = ihdr.readUInt32BE(4);
const depth = ihdr[8];
const colour = ihdr[9];
if (depth !== 8 || colour !== 6) {
  throw new Error(`expected 8-bit RGBA, got depth ${depth} colour type ${colour}`);
}

const idat = inflateSync(
  Buffer.concat(parts.filter((c) => c.type === 'IDAT').map((c) => c.data))
);

// Undo the per-row filters. Every PNG encoder uses them and none of them are
// optional, so this is the whole of "reading a PNG".
const CH = 4;
const stride = width * CH;
const pixels = Buffer.alloc(height * stride);
for (let y = 0; y < height; y++) {
  const filter = idat[y * (stride + 1)];
  const row = idat.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  const out = pixels.subarray(y * stride, (y + 1) * stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= CH ? out[x - CH] : 0;
    const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
    const c = x >= CH && y > 0 ? pixels[(y - 1) * stride + x - CH] : 0;
    let value = row[x];
    if (filter === 1) value += a;
    else if (filter === 2) value += b;
    else if (filter === 3) value += (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[x] = value & 0xff;
  }
}

/* ---------- resize, flattening onto the panel background ---------- */

const out = Buffer.alloc(SIZE * (SIZE * 3 + 1));
const box = width / SIZE;
for (let y = 0; y < SIZE; y++) {
  out[y * (SIZE * 3 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    const y0 = Math.floor(y * box), y1 = Math.min(height, Math.ceil((y + 1) * box));
    const x0 = Math.floor(x * box), x1 = Math.min(width, Math.ceil((x + 1) * box));
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const i = sy * stride + sx * CH;
        const alpha = pixels[i + 3] / 255;
        // Composite here rather than after averaging: blending a transparent
        // pixel's colour in at full weight is what gives resized logos their
        // grey halo.
        r += pixels[i] * alpha + BG[0] * (1 - alpha);
        g += pixels[i + 1] * alpha + BG[1] * (1 - alpha);
        b += pixels[i + 2] * alpha + BG[2] * (1 - alpha);
        n++;
      }
    }
    const o = y * (SIZE * 3 + 1) + 1 + x * 3;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
  }
}

/* ---------- encode ---------- */

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;
header[9] = 2; // truecolour, no alpha — the background is baked in
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(out, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(new URL('./icon.png', import.meta.url), png);
console.log(`icon.png — ${SIZE}x${SIZE} from ${width}x${height}, ${png.length} bytes`);
