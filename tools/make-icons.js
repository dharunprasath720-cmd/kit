// Generates assets/tray.png (16x16), assets/tray@2x.png (32x32) and assets/icon.png (256x256)
// from a tiny hand-drawn cat face. Run with: npm run icons
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ART = [
  '................',
  '................',
  '..##........##..',
  '..#o#......#o#..',
  '..#oo######oo#..',
  '.#oooooooooooo#.',
  '.#oooooooooooo#.',
  '.#ookkoooookko#.',
  '.#ookkoooookko#.',
  '.#oolllppllloo#.',
  '.#oolllllllloo#.',
  '..#oooooooooo#..',
  '...##########...',
  '................',
  '................',
  '................'
];

const COLORS = {
  '#': [0x3b, 0x23, 0x14, 255],
  o: [0xf0, 0x98, 0x3a, 255],
  l: [0xff, 0xf0, 0xd4, 255],
  p: [0xff, 0x8f, 0xa3, 255],
  k: [0x2b, 0x1b, 0x10, 255],
  '.': [0, 0, 0, 0]
};

ART.forEach((row, i) => {
  if (row.length !== 16) throw new Error(`row ${i} has length ${row.length}`);
});

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const k = size / 16;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const c = COLORS[ART[Math.floor(y / k)][Math.floor(x / k)]];
      raw.set(c, y * stride + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'tray.png'), png(16));
fs.writeFileSync(path.join(out, 'tray@2x.png'), png(32));
fs.writeFileSync(path.join(out, 'icon.png'), png(256));
console.log('Wrote tray.png, tray@2x.png, icon.png to', out);
