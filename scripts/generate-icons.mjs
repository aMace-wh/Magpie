// Renders the PNG app icons from public/favicon.svg. Run with `npm run icons`.
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
const inner = svg.replace(/^[\s\S]*?<\/defs>/, '').replace(/<\/svg>\s*$/, '').replace(/<rect[^>]*\/>/, '');
const defs = svg.match(/<defs>[\s\S]*?<\/defs>/)[0];

// Full-bleed square; `scale` shrinks the artwork into the maskable safe zone.
const square = (scale) => {
  const offset = (512 * (1 - scale)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}<rect width="512" height="512" fill="#16141f"/><g transform="translate(${offset} ${offset}) scale(${scale})">${inner}</g></svg>`;
};

const out = (name) => new URL(`../public/${name}`, import.meta.url).pathname;
const render = (src, size, name) => sharp(Buffer.from(src)).resize(size, size).png().toFile(out(name));

await Promise.all([
  render(svg, 192, 'pwa-192.png'),
  render(svg, 512, 'pwa-512.png'),
  render(square(0.8), 512, 'maskable-512.png'),
  render(square(0.9), 180, 'apple-touch-icon.png'),
]);
console.log('Icons written to public/');
