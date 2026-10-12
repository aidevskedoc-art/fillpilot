// Draws the extension icons (icon-16/32/48/128.png): the FillPilot bolt on
// the brand gradient — the same drawing as src/panel/Logo.tsx. Run it only
// when the mark changes; the PNGs are committed.
//
//   node icons/make-icons.cjs         (needs @napi-rs/canvas — the backend has it:
//                                      set NODE_PATH=..\backend\node_modules first)
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

// The bolt in a 24 × 24 box: M13 2 4.5 13.5H11l-1 8.5 9.5-12.5H13z
const BOLT = [[13, 2], [4.5, 13.5], [11, 13.5], [10, 22], [19.5, 9.5], [13, 9.5]];

function draw(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * 0.24;

  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#8b5cff');
  gradient.addColorStop(0.52, '#3d7bff');
  gradient.addColorStop(1, '#19e0ff');
  ctx.fillStyle = gradient;
  ctx.fill();

  // The bolt, centred, at about two thirds of the icon.
  const scale = (size * 0.7) / 24;
  const offset = (size - 24 * scale) / 2;
  ctx.beginPath();
  BOLT.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](offset + x * scale, offset + y * scale));
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  return canvas.toBuffer('image/png');
}

for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(__dirname, `icon-${size}.png`), draw(size));
  console.log(`icon-${size}.png`);
}
