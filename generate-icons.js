// Run once: node generate-icons.js
// Creates icons/icon16.png, icon48.png, icon128.png
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length);
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([lb, tb, data, cb]);
}

function makePNG(size, drawFn) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size, 0);
  for (let y = 0; y < size; y++) {
    raw[(stride + 1) * y] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const [r, g, b] = drawFn(x, y, size);
      const o = (stride + 1) * y + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Draw a folder icon with a YouTube-red accent
function drawIcon(x, y, size) {
  const s = size;
  const cx = x / s, cy = y / s;

  // Background: dark gray
  let r = 30, g = 30, b = 30;

  // Folder body: red rectangle covering lower 60%, centered
  const bodyX1 = 0.1, bodyX2 = 0.9, bodyY1 = 0.35, bodyY2 = 0.82;
  // Folder tab: smaller rect on top-left
  const tabX1 = 0.1, tabX2 = 0.45, tabY1 = 0.22, tabY2 = 0.37;

  const inBody = cx >= bodyX1 && cx <= bodyX2 && cy >= bodyY1 && cy <= bodyY2;
  const inTab  = cx >= tabX1  && cx <= tabX2  && cy >= tabY1  && cy <= tabY2;

  if (inBody || inTab) { r = 255; g = 0; b = 0; }

  // Play triangle inside folder body (white)
  if (inBody) {
    const tx = (cx - bodyX1) / (bodyX2 - bodyX1);
    const ty = (cy - bodyY1) / (bodyY2 - bodyY1);
    // Triangle: apex at (0.65, 0.2), base at (0.35, 0.1) and (0.35, 0.9)
    if (tx >= 0.3 && tx <= 0.75 && ty >= 0.1 && ty <= 0.9) {
      const slope = (0.9 - 0.1) / (0.75 - 0.35);
      const topEdge    = 0.5 - (tx - 0.35) * slope * 0.5;
      const bottomEdge = 0.5 + (tx - 0.35) * slope * 0.5;
      if (tx >= 0.35 && ty >= topEdge && ty <= bottomEdge) { r = 255; g = 255; b = 255; }
    }
  }

  return [r, g, b];
}

const dir = path.join(__dirname, 'icons');
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), makePNG(size, drawIcon));
  console.log(`icons/icon${size}.png`);
}
console.log('Done.');
