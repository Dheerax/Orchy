/**
 * Draw media/icon.png from the same glyph as orchy.svg.
 *
 * The Marketplace wants a 128×128 PNG and will not take an SVG, and adding an
 * image toolchain to a project that has no other binary assets is a poor trade.
 * This is a few dozen lines of arithmetic: supersample at 4×, box-filter down,
 * and hand the result to zlib.
 *
 *   node media/make-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SIZE = 128;
const SS = 4; // supersample factor — the whole of the anti-aliasing
const N = SIZE * SS;
const UNIT = N / 24; // the glyph is drawn on a 24-unit grid, like the SVG

const BG = [13, 17, 23];
const FG = [188, 140, 255];

const px = new Uint8Array(N * N * 3);
for (let i = 0; i < N * N; i++) {
  px[i * 3] = BG[0];
  px[i * 3 + 1] = BG[1];
  px[i * 3 + 2] = BG[2];
}

const paint = (x, y) => {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  const i = (y * N + x) * 3;
  px[i] = FG[0];
  px[i + 1] = FG[1];
  px[i + 2] = FG[2];
};

/** A filled disc, in glyph units. */
function disc(cx, cy, r) {
  const x0 = (cx - r) * UNIT, x1 = (cx + r) * UNIT;
  const y0 = (cy - r) * UNIT, y1 = (cy + r) * UNIT;
  const rr = (r * UNIT) ** 2;
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const dx = x + 0.5 - cx * UNIT;
      const dy = y + 0.5 - cy * UNIT;
      if (dx * dx + dy * dy <= rr) paint(x, y);
    }
  }
}

/** A round-capped segment, in glyph units. */
function line(ax, ay, bx, by, width) {
  const x0 = ax * UNIT, y0 = ay * UNIT, x1 = bx * UNIT, y1 = by * UNIT;
  const half = (width * UNIT) / 2;
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2;
  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    const cx = (x0 + (x1 - x0) * t) / UNIT;
    const cy = (y0 + (y1 - y0) * t) / UNIT;
    disc(cx, cy, half / UNIT);
  }
}

// One agent above, three below: the shape the whole tool is about.
line(12, 7.1, 12, 10.3, 1.5);
line(4.5, 10.3, 19.5, 10.3, 1.5);
line(4.5, 10.3, 4.5, 15.2, 1.5);
line(12, 10.3, 12, 15.2, 1.5);
line(19.5, 10.3, 19.5, 15.2, 1.5);
disc(12, 4.5, 2.6);
disc(4.5, 18, 2.6);
disc(12, 18, 2.6);
disc(19.5, 18, 2.6);

// Box-filter down. Averaging SS² samples is what turns the hard edges above
// into something that does not look like 1998.
const out = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let y = 0; y < SIZE; y++) {
  out[y * (SIZE * 3 + 1)] = 0; // PNG filter type: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 3;
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
    }
    const n = SS * SS;
    const o = y * (SIZE * 3 + 1) + 1 + x * 3;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
  }
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(out, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = new URL('./icon.png', import.meta.url);
writeFileSync(target, png);
console.log(
  `icon.png — ${SIZE}x${SIZE}, ${png.length} bytes, sha ${createHash('sha256')
    .update(png)
    .digest('hex')
    .slice(0, 12)}`
);
