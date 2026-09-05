// Minimal ESM hooks so the validators can run the app's TypeScript modules
// directly under Node without the Next/Tailwind toolchain. In addition to
// mapping the "@/..." path alias, TSX is transpiled for render smoke tests.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

const srcRoot = path.resolve(process.cwd(), "src");
const aliasExtensions = [".ts", ".tsx", ".js", ".jsx"];
const dynamicStubUrl = `data:text/javascript,${encodeURIComponent(`
export default function dynamic(loader) {
  function DynamicStub() { return null; }
  DynamicStub.preload = () => loader();
  return DynamicStub;
}
`)}`;

/** @param {string} specifier */
function resolveAliasPath(specifier) {
  const directPath = path.resolve(srcRoot, specifier.slice(2));
  const candidates = path.extname(directPath)
    ? [directPath]
    : [
        ...aliasExtensions.map((extension) => `${directPath}${extension}`),
        ...aliasExtensions.map((extension) => path.join(directPath, `index${extension}`)),
      ];

  return candidates.find((candidate) => existsSync(candidate)) ?? `${directPath}.ts`;
}

/**
 * @param {string} specifier
 * @param {import("node:module").ResolveHookContext} context
 * @param {(specifier: string, context: import("node:module").ResolveHookContext) => import("node:module").ResolveFnOutput | Promise<import("node:module").ResolveFnOutput>} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/dynamic" && process.env.TRUEPEAK_RENDER_SMOKE === "1") {
    return { url: dynamicStubUrl, shortCircuit: true };
  }

  if (specifier.startsWith("@/")) {
    return {
      url: pathToFileURL(resolveAliasPath(specifier)).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

/**
 * @param {string} url
 * @param {import("node:module").LoadHookContext} context
 * @param {(url: string, context: import("node:module").LoadHookContext) => import("node:module").LoadFnOutput | Promise<import("node:module").LoadFnOutput>} nextLoad
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx")) {
    const source = await readFile(new URL(url), "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      },
      fileName: new URL(url).pathname,
      reportDiagnostics: true,
    });
    const errors = (transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      throw new Error(
        `Unable to transpile ${url}: ${errors
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
          .join("; ")}`,
      );
    }

    return {
      format: "module",
      source: transpiled.outputText,
      shortCircuit: true,
    };
  }

  return nextLoad(url, context);
}
