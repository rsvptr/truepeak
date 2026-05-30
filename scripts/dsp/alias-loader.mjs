// Minimal ESM resolve hook so we can run the app's TypeScript audio modules
// directly under Node (native type-stripping) without the Next/Tailwind toolchain.
// Maps the project's "@/..." path alias onto ./src/... and lets bare relative
// imports keep working. Used only by scripts/dsp/validate-dsp.mjs.
import { pathToFileURL } from "node:url";
import path from "node:path";

const srcRoot = pathToFileURL(path.resolve(process.cwd(), "src") + path.sep).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const mapped = new URL(specifier.slice(2) + ".ts", srcRoot).href;
    return { url: mapped, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
