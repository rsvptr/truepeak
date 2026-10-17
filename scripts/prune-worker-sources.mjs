#!/usr/bin/env node
// Turbopack emits every `new Worker(new URL("./x.worker.ts", import.meta.url))`
// call twice: once as the correctly bundled worker chunk, and once as the raw
// source file copied verbatim into the static media folder, served under
// immutable caching with nothing referencing it at runtime.
// Delete the raw copies after every build, then
// assert the real bundled worker chunks are still there so a pruning bug
// cannot silently strip the app's own workers.
//
// Static assets land in one of two layouts. A plain `next build` writes
// .next/static/{chunks,media}. On Vercel, Next 16.3's deployment adapter turns
// on `supportsImmutableAssets`, which moves content-hashed assets to
// .next/static/immutable/{chunks,media}. Both are checked here.
//
// The Vercel adapter also copies every static file into .next/output/ during
// `next build` (its onBuildComplete hook), before this postbuild script runs,
// and records the immutable ones in .next/output/immutable.json. Files are
// deliberately not deleted from that copy, so the deployed output stays
// consistent with that manifest; on Vercel the unreferenced raw sources are
// therefore deployed, which costs storage but exposes nothing that is not
// already in the public repository.

import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const staticRoots = [
  path.join(root, ".next", "static"),
  path.join(root, ".next", "static", "immutable"),
];

async function listFiles(dir) {
  try {
    return await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

// Matches the two shapes Turbopack emits: "<name>.worker.<hash>.ts" for the
// app's own workers, and "worker.<hash>.js" for @ffmpeg/ffmpeg's nested worker.
const isRawWorkerSource = (name) => /^.+\.worker\..+\.ts$/.test(name) || /^worker\..+\.js$/.test(name);

let removed = 0;
for (const staticRoot of staticRoots) {
  const mediaDir = path.join(staticRoot, "media");
  for (const name of (await listFiles(mediaDir)).filter(isRawWorkerSource)) {
    const file = path.join(mediaDir, name);
    await rm(file);
    removed += 1;
    console.log(`prune-worker-sources: removed ${relative(file)}`);
  }

  const leftoverTs = (await listFiles(mediaDir)).filter((name) => name.endsWith(".ts"));
  if (leftoverTs.length > 0) {
    console.error(
      `prune-worker-sources: .ts file(s) still under ${relative(mediaDir)}: ${leftoverTs.join(", ")}`,
    );
    process.exit(1);
  }
}

// Sanity check: the pruning above only touches the media folders, so the
// bundled worker chunks and their per-worker Turbopack runtime copies must be
// untouched. Chunk names are content-hashed and change every build, so there
// is no fixed filename to check for; match on the "turbopack-" prefix instead,
// which covers the single "turbopack-worker-*" bootstrap loader plus each
// worker's own ~10.5 KB runtime copy (one per new Worker() call site, so at
// least 3 for this app's decoder/analyzer/session-import workers, on top of
// the app's own runtime chunk). Count across both layouts.
const workerChunks = [];
for (const staticRoot of staticRoots) {
  const chunksDir = path.join(staticRoot, "chunks");
  for (const name of (await listFiles(chunksDir)).filter((name) => /^turbopack-/.test(name))) {
    workerChunks.push(relative(path.join(chunksDir, name)));
  }
}
if (workerChunks.length < 3) {
  console.error(
    `prune-worker-sources: expected at least 3 turbopack-worker-*.js or worker chunk files under .next/static/chunks or .next/static/immutable/chunks, found ${workerChunks.length}${workerChunks.length ? `: ${workerChunks.join(", ")}` : ""}`,
  );
  process.exit(1);
}

console.log(
  `prune-worker-sources: removed ${removed} raw worker source file(s); ${workerChunks.length} worker chunk file(s) intact.`,
);
