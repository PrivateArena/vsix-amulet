/**
 * Build: three bundles, because the product has three execution contexts.
 *
 *   extension.cjs  CommonJS, `vscode` external        (extension host, Electron Node)
 *   worker.mjs     ESM, everything vendored          (plain Node 22, runs the Pi SDK; it is ESM-only)
 *   webview.js     ESM for the browser               (no Node, no deps)
 *
 * The worker bundles the Pi SDK and its whole dependency graph, so a .vsix ships one file instead
 * of a node_modules tree. The exception is `@silvia-odwyer/photon-node`: it is loaded dynamically
 * and needs its .wasm beside it, so it stays external and ships as a real package (the payload
 * does the same with its `pi-sdk-assets` folder).
 */
import { build, context } from "esbuild";
import { copyFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Packages that cannot be inlined: they resolve files relative to their own directory at runtime. */
const RUNTIME_EXTERNAL = ["@silvia-odwyer/photon-node"];

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
    keepNames: true,
    // Vendored CommonJS (cross-spawn and friends) calls require() for node builtins. In ESM output
    // esbuild routes those through a shim that prefers a `require` binding in scope, so give it one.
    banner: {
      js: [
        "import { createRequire as __amuletCreateRequire } from \"node:module\";",
        "const require = __amuletCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    // `vscode` is not used here, but a stray import would otherwise fail silently at build time.
    external: ["vscode", ...RUNTIME_EXTERNAL],
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

/**
 * A minified build emits no source maps, so the ones a previous dev build left behind would ship as
 * dead weight in the .vsix - and a stale dist/worker.cjs from an older iteration would look current.
 */
if (!watch) {
  const keep = minify ? new Set(["extension.cjs", "worker.mjs", "webview.js", "webview.css"]) : null;
  for (const entry of await readdir("dist")) {
    if (keep && !keep.has(entry)) await unlink(join("dist", entry));
  }
}

console.log(`built dist/extension.cjs, dist/worker.mjs, dist/webview.js, dist/webview.css${minify ? " (minified)" : ""}`);
