// Copies the ffmpeg.wasm runtime into public/vendor/ffmpeg — and refuses to
// ship assets that don't match the pinned SHA-256 hashes. The wasm binary is
// the largest piece of third-party code this app serves, so a compromised or
// silently-substituted @ffmpeg/core package must fail the build loudly rather
// than reach users.
//
// Bumping @ffmpeg/core intentionally: install the new version, run
// `node scripts/prepare-ffmpeg-assets.mjs --print-hashes`, review the diff of
// the package (not just the hashes), then update EXPECTED_HASHES below.
import { createHash } from "node:crypto";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const packageDir = path.join(root, "node_modules", "@ffmpeg", "core");
const sourceDir = path.join(packageDir, "dist", "umd");
const targetDir = path.join(root, "public", "vendor", "ffmpeg");

const assets = ["ffmpeg-core.js", "ffmpeg-core.wasm"];

const EXPECTED_HASHES = {
  "0.12.9": {
    "ffmpeg-core.js": "b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21",
    "ffmpeg-core.wasm": "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7",
  },
  // 0.12.10 ships byte-identical UMD assets to 0.12.9 (verified by hashing a
  // fresh `npm pack @ffmpeg/core@0.12.10` — packaging-only release).
  "0.12.10": {
    "ffmpeg-core.js": "b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21",
    "ffmpeg-core.wasm": "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7",
  },
};

const printHashesOnly = process.argv.includes("--print-hashes");

const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
const version = packageJson.version;

const actualHashes = {};
for (const asset of assets) {
  const bytes = await readFile(path.join(sourceDir, asset));
  actualHashes[asset] = createHash("sha256").update(bytes).digest("hex");
}

if (printHashesOnly) {
  console.log(`@ffmpeg/core ${version}`);
  for (const asset of assets) {
    console.log(`  "${asset}": "${actualHashes[asset]}",`);
  }
  process.exit(0);
}

const expected = EXPECTED_HASHES[version];
if (!expected) {
  console.error(
    [
      `Integrity check failed: @ffmpeg/core ${version} has no pinned hashes.`,
      "If this version bump is intentional, review the new package contents, then",
      "run `node scripts/prepare-ffmpeg-assets.mjs --print-hashes` and add the",
      "entry to EXPECTED_HASHES in this script. Current hashes:",
      ...assets.map((asset) => `  ${asset}: ${actualHashes[asset]}`),
    ].join("\n"),
  );
  process.exit(1);
}

for (const asset of assets) {
  if (actualHashes[asset] !== expected[asset]) {
    console.error(
      [
        `Integrity check failed: ${asset} from @ffmpeg/core ${version} does not match its pinned hash.`,
        `  expected: ${expected[asset]}`,
        `  actual:   ${actualHashes[asset]}`,
        "The installed package differs from the reviewed one. Do not ship it without investigating.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

await mkdir(targetDir, { recursive: true });
for (const asset of assets) {
  await copyFile(path.join(sourceDir, asset), path.join(targetDir, asset));
}

console.log(`Prepared ffmpeg assets in ${targetDir} (integrity verified for @ffmpeg/core ${version})`);
