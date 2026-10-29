/**
 * Build: three bundles, because the product has three execution contexts.
 *
 *   extension.cjs  CommonJS, `vscode` external        (extension host, Electron Node)
 *   worker.mjs     ESM, deps left external         (plain Node 22, runs the Pi SDK; it is ESM-only)
 *   webview.js     ESM for the browser               (no Node, no deps)
 *
 * The worker keeps its dependencies external: the Pi SDK is ESM-only, ships native prebuilds,
 * wasm and a CLI entry that must stay resolvable next to node_modules.
 */
import { build, context } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify");

const shared = { bundle: true, minify, sourcemap: !minify, logLevel: "info", target: "es2023" };

const targets = [
  {
    ...shared,
    entryPoints: ["src/host/extension.ts"],
    outfile: "dist/extension.cjs",
    format: "cjs",
    platform: "node",
    external: ["vscode"],
  },
  {
    ...shared,
    entryPoints: ["src/worker/main.ts"],
    outfile: "dist/worker.mjs",
    format: "esm",
    platform: "node",
    packages: "external",
  },
  {
    ...shared,
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    format: "esm",
    platform: "browser",
  },
];

for (const target of targets) {
  if (watch) await context(target);
  else await build(target);
}

await mkdir("dist", { recursive: true });
await copyFile("src/webview/webview.css", "dist/webview.css");

if (!watch) console.log("built dist/extension.cjs, dist/worker.mjs, dist/webview.js, dist/webview.css");
