#!/usr/bin/env node
// One-off generator for the manifest's maskable icon.
// Android's maskable mask crops to a circle/squircle
// and insets the icon, so a maskable variant needs the logo scaled down
// inside a solid "safe zone" background rather than filling the full square
// like the plain icon does. Run manually; the output is committed.

import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const SIZE = 512;
const LOGO_SCALE = 0.66;
const BACKGROUND = { r: 0x07, g: 0x14, b: 0x12, alpha: 1 };

const logoSize = Math.round(SIZE * LOGO_SCALE);

const logo = await sharp(path.join(root, "public", "logo.png"))
  .resize(logoSize, logoSize, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .toBuffer();

const outPath = path.join(root, "public", "icon-maskable.png");

await sharp({
  create: {
    width: SIZE,
    height: SIZE,
    channels: 4,
    background: BACKGROUND,
  },
})
  .composite([{ input: logo, gravity: "center" }])
  .png()
  .toFile(outPath);

console.log(
  `make-maskable-icon: wrote public/icon-maskable.png (${SIZE}x${SIZE}, logo at ${Math.round(LOGO_SCALE * 100)}% on #071412)`,
);
