#!/usr/bin/env node
// Turbopack emits every `new Worker(new URL("./x.worker.ts", import.meta.url))`
// call twice: once as the correctly bundled worker chunk, and once as the raw
// source file copied verbatim into .next/static/media/, served under
// immutable caching with nothing referencing it at runtime.
// Delete the raw copies after every build, then
// assert the real bundled worker chunks are still there so a pruning bug
// cannot silently strip the app's own workers.

import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const mediaDir = path.join(root, ".next", "static", "media");
const chunksDir = path.join(root, ".next", "static", "chunks");

async function listFiles(dir) {
  try {
    return await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

const mediaFiles = await listFiles(mediaDir);
// Matches the two shapes Turbopack emits: "<name>.worker.<hash>.ts" for the
// app's own workers, and "worker.<hash>.js" for @ffmpeg/ffmpeg's nested worker.
const toDelete = mediaFiles.filter(
  (name) => /^.+\.worker\..+\.ts$/.test(name) || /^worker\..+\.js$/.test(name),
);

for (const name of toDelete) {
  await rm(path.join(mediaDir, name));
  console.log(`prune-worker-sources: removed .next/static/media/${name}`);
}

const remainingMedia = await listFiles(mediaDir);
const leftoverTs = remainingMedia.filter((name) => name.endsWith(".ts"));
if (leftoverTs.length > 0) {
  console.error(
    `prune-worker-sources: .ts file(s) still under .next/static/media: ${leftoverTs.join(", ")}`,
  );
  process.exit(1);
}

// Sanity check: the pruning above only touches static/media, so the bundled
// worker chunks and their per-worker Turbopack runtime copies under
// static/chunks must be untouched. Chunk names are content-hashed and change
// every build, so there is no fixed filename to check for; match on the
// "turbopack-" prefix instead, which covers the single "turbopack-worker-*"
// bootstrap loader plus each worker's own ~10.5 KB runtime copy (one per
// new Worker() call site, so at least 3 for this app's decoder/analyzer/
// session-import workers, on top of the app's own runtime chunk).
const chunkFiles = await listFiles(chunksDir);
const workerChunks = chunkFiles.filter((name) => /^turbopack-/.test(name));
if (workerChunks.length < 3) {
  console.error(
    `prune-worker-sources: expected at least 3 turbopack-worker-*.js or worker chunk files under .next/static/chunks, found ${workerChunks.length}${workerChunks.length ? `: ${workerChunks.join(", ")}` : ""}`,
  );
  process.exit(1);
}

console.log(
  `prune-worker-sources: removed ${toDelete.length} raw worker source file(s); ${workerChunks.length} worker chunk file(s) intact.`,
);
