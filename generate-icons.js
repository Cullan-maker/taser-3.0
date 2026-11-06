import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function createCRC32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
}

const crcTable = createCRC32Table();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcPayload = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(crcPayload);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lenBuf, crcPayload, crcBuf]);
}

function generateTacticalPNG(size, maskable = false) {
  const width = size;
  const height = size;
  const rawBytes = Buffer.alloc((width * 4 + 1) * height);

  const cx = width / 2;
  const cy = height / 2;
  const radius = width * (maskable ? 0.38 : 0.44);

  let byteIdx = 0;
  for (let y = 0; y < height; y++) {
    rawBytes[byteIdx++] = 0; // Filter byte 0 (None)
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Tactical yellow: 241, 196, 15 (#f1c40f)
      // Dark gray/black: 10, 10, 10 (#0a0a0a)
      // High-voltage blue-yellow electric accent
      let r = 10, g = 10, b = 10, a = 255;

      // Outer bezel circle
      if (dist <= radius) {
        // Metallic edge
        if (dist >= radius - (size * 0.05)) {
          r = 241; g = 196; b = 15; a = 255;
        } else {
          // Inside tactical core
          r = 20; g = 20; b = 25; a = 255;
          
          // Draw lightning bolt shape:
          // Normalized coordinates (-1 to 1) inside radius
          const nx = dx / radius;
          const ny = dy / radius;

          // Lightning bolt test:
          const isBolt = (
            (ny >= -0.7 && ny < -0.1 && nx > (ny * -0.5 - 0.25) && nx < (ny * -0.5 + 0.25)) ||
            (ny >= -0.15 && ny <= 0.05 && nx > -0.45 && nx < 0.45) ||
            (ny > 0.0 && ny <= 0.75 && nx > ((ny - 0.75) * -0.6 - 0.2) && nx < ((ny - 0.75) * -0.6 + 0.25))
          );

          if (isBolt) {
            r = 241; g = 196; b = 15; // Yellow bolt
          } else if (dist < radius * 0.85 && dist > radius * 0.8) {
            r = 50; g = 50; b = 60; // Inner guide ring
          }
        }
      } else if (!maskable) {
        // Transparent outside for any-purpose icon
        a = 0;
      }

      rawBytes[byteIdx++] = r;
      rawBytes[byteIdx++] = g;
      rawBytes[byteIdx++] = b;
      rawBytes[byteIdx++] = a;
    }
  }

  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // Deflate
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // No interlace

  const ihdrChunk = makeChunk('IHDR', ihdr);
  const compressed = zlib.deflateSync(rawBytes, { level: 9 });
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.join(process.cwd(), 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), generateTacticalPNG(192, false));
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), generateTacticalPNG(512, false));
fs.writeFileSync(path.join(iconsDir, 'icon-maskable-512.png'), generateTacticalPNG(512, true));
fs.writeFileSync(path.join(iconsDir, 'apple-touch-icon.png'), generateTacticalPNG(180, false));

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="100" fill="#0a0a0a"/>
  <circle cx="256" cy="256" r="210" fill="#141419" stroke="#f1c40f" stroke-width="24"/>
  <circle cx="256" cy="256" r="170" fill="none" stroke="#2c3e50" stroke-width="6" stroke-dasharray="8 8"/>
  <path d="M280 80 L180 260 L270 260 L230 432 L350 230 L260 230 Z" fill="#f1c40f" filter="drop-shadow(0 0 16px rgba(241,196,15,0.7))"/>
  <circle cx="256" cy="115" r="12" fill="#2ecc71"/>
  <circle cx="256" cy="397" r="12" fill="#e74c3c"/>
</svg>`;
fs.writeFileSync(path.join(iconsDir, 'icon.svg'), svgContent);

console.log('Tactical PWA icons generated successfully in /icons');
