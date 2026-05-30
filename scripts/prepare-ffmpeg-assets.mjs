import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sourceDir = path.join(root, "node_modules", "@ffmpeg", "core", "dist", "umd");
const targetDir = path.join(root, "public", "vendor", "ffmpeg");

const assets = ["ffmpeg-core.js", "ffmpeg-core.wasm"];

await mkdir(targetDir, { recursive: true });
for (const asset of assets) {
  await copyFile(path.join(sourceDir, asset), path.join(targetDir, asset));
}

console.log(`Prepared ffmpeg assets in ${targetDir}`);
