// Copies the ffmpeg.wasm runtime into versioned public URLs and refuses to
// ship assets that do not match the reviewed SHA-256 hashes. The nested worker
// and ESM core are self-hosted together so the browser does not depend on the
// bundler rewriting @ffmpeg/ffmpeg's worker type.
//
// Bumping either @ffmpeg package intentionally: install the new version, run
// `node scripts/prepare-ffmpeg-assets.mjs --print-hashes`, review the package
// diff (not just the hashes), then update EXPECTED_HASHES below and the matching
// version constants in src/workers/decoder.worker.ts.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const vendorRoot = path.join(root, "public", "vendor", "ffmpeg");

const packages = [
  {
    name: "@ffmpeg/core",
    packageDir: path.join(root, "node_modules", "@ffmpeg", "core"),
    sourceSubdir: path.join("dist", "esm"),
    targetPackage: "core",
    assets: ["ffmpeg-core.js", "ffmpeg-core.wasm"],
  },
  {
    name: "@ffmpeg/ffmpeg",
    packageDir: path.join(root, "node_modules", "@ffmpeg", "ffmpeg"),
    sourceSubdir: path.join("dist", "esm"),
    targetPackage: "ffmpeg",
    assets: ["worker.js", "const.js", "errors.js"],
  },
];

const EXPECTED_HASHES = {
  "@ffmpeg/core": {
    "0.12.9": {
      "ffmpeg-core.js": "67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3",
      "ffmpeg-core.wasm": "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7",
    },
  },
  "@ffmpeg/ffmpeg": {
    "0.12.15": {
      "worker.js": "feff0ac937ea225e997e1fae997a74f8b8d572423a526da59eb56624b1f3cde7",
      "const.js": "9e3bc9dd84781c81daf459e2c46eeec815edac35089832681d9a9a0f383060d0",
      "errors.js": "619310d7ef5fe5fefa0a31927db862b7c291713cfef4d71753fa8aafd18f4db6",
    },
  },
};

const printHashesOnly = process.argv.includes("--print-hashes");
const preparedPackages = [];

for (const packageConfig of packages) {
  const packageJson = JSON.parse(
    await readFile(path.join(packageConfig.packageDir, "package.json"), "utf8"),
  );
  const version = packageJson.version;
  const sourceDir = path.join(packageConfig.packageDir, packageConfig.sourceSubdir);
  const actualHashes = {};

  for (const asset of packageConfig.assets) {
    const bytes = await readFile(path.join(sourceDir, asset));
    actualHashes[asset] = createHash("sha256").update(bytes).digest("hex");
  }

  preparedPackages.push({ ...packageConfig, version, sourceDir, actualHashes });
}

if (printHashesOnly) {
  for (const packageConfig of preparedPackages) {
    console.log(`${packageConfig.name} ${packageConfig.version}`);
    for (const asset of packageConfig.assets) {
      console.log(`  "${asset}": "${packageConfig.actualHashes[asset]}",`);
    }
  }
  process.exit(0);
}

for (const packageConfig of preparedPackages) {
  const expected = EXPECTED_HASHES[packageConfig.name]?.[packageConfig.version];
  if (!expected) {
    console.error(
      [
        `Integrity check failed: ${packageConfig.name} ${packageConfig.version} has no pinned hashes.`,
        "If this version bump is intentional, review the new package contents, then",
        "run `node scripts/prepare-ffmpeg-assets.mjs --print-hashes` and add the",
        "entry to EXPECTED_HASHES in this script. Current hashes:",
        ...packageConfig.assets.map(
          (asset) => `  ${asset}: ${packageConfig.actualHashes[asset]}`,
        ),
      ].join("\n"),
    );
    process.exit(1);
  }

  for (const asset of packageConfig.assets) {
    if (packageConfig.actualHashes[asset] !== expected[asset]) {
      console.error(
        [
          `Integrity check failed: ${asset} from ${packageConfig.name} ${packageConfig.version} does not match its pinned hash.`,
          `  expected: ${expected[asset]}`,
          `  actual:   ${packageConfig.actualHashes[asset]}`,
          "The installed package differs from the reviewed one. Do not ship it without investigating.",
        ].join("\n"),
      );
      process.exit(1);
    }
  }
}

for (const packageConfig of preparedPackages) {
  const targetDir = path.join(
    vendorRoot,
    packageConfig.targetPackage,
    packageConfig.version,
  );
  await mkdir(targetDir, { recursive: true });
  for (const asset of packageConfig.assets) {
    await copyFile(path.join(packageConfig.sourceDir, asset), path.join(targetDir, asset));
  }
}

// Remove the pre-versioning output names. Versioned directories from older
// reviewed releases may remain because their URLs are immutable by design.
await Promise.all([
  rm(path.join(vendorRoot, "ffmpeg-core.js"), { force: true }),
  rm(path.join(vendorRoot, "ffmpeg-core.wasm"), { force: true }),
]);

console.log(
  `Prepared versioned ffmpeg assets in ${vendorRoot} (${preparedPackages
    .map((packageConfig) => `${packageConfig.name} ${packageConfig.version}`)
    .join(", ")}; integrity verified)`,
);
