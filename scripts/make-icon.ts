// Generates .claude-plugin/icon.png (512×512): the hub (local) linked to three remote agents — ladvin's star topology.
// No dependencies: signed-distance shapes, anti-aliased, written as a PNG with zlib.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 512;
type RGB = [number, number, number];
const BG: RGB = [26, 27, 38];
const LINK: RGB = [122, 162, 247];
const HUB: RGB = [247, 118, 142];
const NODE: RGB = [158, 206, 106];

const c = S / 2;
const sats = [-90, 30, 150].map((deg) => {
  const r = (deg * Math.PI) / 180;
  return [c + Math.cos(r) * 165, c + Math.sin(r) * 165] as const;
});

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};
// coverage of a shape with signed distance d (negative inside), 1px anti-aliasing
const cov = (d: number) => Math.max(0, Math.min(1, 0.5 - d));
const roundRect = (x: number, y: number, half: number, r: number) => {
  const qx = Math.abs(x - c) - (half - r);
  const qy = Math.abs(y - c) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

const px = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  px[y * (S * 4 + 1)] = 0; // PNG filter: none
  for (let x = 0; x < S; x++) {
    const sx = x + 0.5;
    const sy = y + 0.5;
    let col: RGB = [0, 0, 0];
    const blend = (rgb: RGB, a: number) => {
      col = [0, 1, 2].map((i) => col[i]! * (1 - a) + rgb[i]! * a) as RGB;
    };
    const bgA = cov(roundRect(sx, sy, 250, 96));
    blend(BG, 1);
    for (const [ax, ay] of sats) blend(LINK, cov(segDist(sx, sy, c, c, ax, ay) - 9));
    for (const [ax, ay] of sats) blend(NODE, cov(Math.hypot(sx - ax, sy - ay) - 46));
    blend(HUB, cov(Math.hypot(sx - c, sy - c) - 70));
    const o = y * (S * 4 + 1) + 1 + x * 4;
    px[o] = Math.round(col[0]);
    px[o + 1] = Math.round(col[1]);
    px[o + 2] = Math.round(col[2]);
    px[o + 3] = Math.round(bgA * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let v = n;
  for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
  return v >>> 0;
});
const crc32 = (b: Buffer) => {
  let v = 0xffffffff;
  for (const x of b) v = crcTable[(v ^ x) & 0xff]! ^ (v >>> 8);
  return (v ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(px, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = process.argv[2] ?? ".claude-plugin/icon.png";
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
