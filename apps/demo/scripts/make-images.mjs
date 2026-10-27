// Draws the site's icons and its social preview picture into public/:
// favicon-32.png and apple-touch-icon.png from favicon.svg, and og.png
// (1200×630; the name is SITE.name in src/site.ts). Run from apps/demo after changing the look: node scripts/make-images.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
const arimo = dirname(require.resolve('@expo-google-fonts/arimo/package.json'));
GlobalFonts.registerFromPath(join(arimo, '400Regular', 'Arimo_400Regular.ttf'), 'Arimo');
GlobalFonts.registerFromPath(join(arimo, '700Bold', 'Arimo_700Bold.ttf'), 'Arimo Bold');

const icon = await loadImage(readFileSync('public/favicon.svg'));
for (const [file, size] of [
  ['public/favicon-32.png', 32],
  ['public/apple-touch-icon.png', 180],
]) {
  const canvas = createCanvas(size, size);
  canvas.getContext('2d').drawImage(icon, 0, 0, size, size);
  writeFileSync(file, canvas.toBuffer('image/png'));
}

// The preview: the start page's words on its soft canvas, with the tools as pills.
const W = 1200;
const H = 630;
const og = createCanvas(W, H);
const ctx = og.getContext('2d');
ctx.fillStyle = '#f2f2f0';
ctx.fillRect(0, 0, W, H);
const glow = ctx.createRadialGradient(W * 0.82, H * 0.75, 0, W * 0.82, H * 0.75, W * 0.5);
glow.addColorStop(0, 'rgba(139, 125, 255, 0.18)');
glow.addColorStop(1, 'rgba(139, 125, 255, 0)');
ctx.fillStyle = glow;
ctx.fillRect(0, 0, W, H);

ctx.drawImage(icon, 80, 72, 72, 72);
ctx.fillStyle = '#1b1b1d';
ctx.font = '30px "Arimo Bold"';
ctx.fillText('LovelyDoc', 172, 119);

ctx.font = '68px "Arimo Bold"';
ctx.fillText('Edit any PDF,', 80, 268);
ctx.fillText('right in your browser.', 80, 350);
ctx.fillStyle = '#5b5b58';
ctx.font = '30px "Arimo"';
ctx.fillText('Free. No sign-up. Your files never leave your device.', 80, 420);

const pills = ['Edit text', 'Edit scans', 'Sign', 'Fill forms', 'Compress', 'Merge'];
let x = 80;
ctx.font = '24px "Arimo"';
for (const pill of pills) {
  const w = ctx.measureText(pill).width + 44;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(x, 486, w, 54, 27);
  ctx.fill();
  ctx.fillStyle = '#1b1b1d';
  ctx.fillText(pill, x + 22, 521);
  x += w + 12;
}
writeFileSync('public/og.png', og.toBuffer('image/png'));
console.log('wrote favicon-32.png, apple-touch-icon.png and og.png');
