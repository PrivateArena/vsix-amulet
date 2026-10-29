/**
 * Prove the packaged artifact, not the build folder.
 *
 *   node test/package-vsix.mjs
 *
 * Unpacks the newest dist/*.vsix the way the extension manager would, checks what is inside, then
 * re-runs the integration suites against the files VS Code would actually load. A bundle that works
 * in dist/ but not in the package — a stripped file, a stray dependency, an unvendorable .wasm — is
 * exactly the failure this exists to catch.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpackedSizeLimitMB = 20;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

function newestVsix() {
  const dist = path.join(root, "dist");
  const candidates = existsSync(dist)
    ? readdirSync(dist)
        .filter(name => name.endsWith(".vsix"))
        .map(name => path.join(dist, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (!candidates.length) {
    console.error("no .vsix found in dist/ — run `npm run vsix` first");
    process.exit(1);
  }
  return candidates[0];
}

/** A .vsix is a zip; unpack it with whatever the platform provides. */
function unpack(vsix, into) {
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status !== 0) {
      console.error(`${command} failed: ${result.stderr || result.stdout || "unknown error"}`);
      process.exit(1);
    }
  };
  if (process.platform === "win32") {
    const zip = path.join(into, "..", "package.zip");
    run("powershell", ["-NoProfile", "-Command", `Copy-Item '${vsix}' '${zip}'; Expand-Archive '${zip}' '${into}'`]);
  } else {
    run("unzip", ["-o", "-q", vsix, "-d", into]);
  }
}

function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out;
}

const vsix = newestVsix();
const sandbox = mkdtempSync(path.join(tmpdir(), "amulet-vsix-"));
console.log(`vsix: ${path.relative(root, vsix)} (${(statSync(vsix).size / 1024 / 1024).toFixed(2)} MB)`);

try {
  const packageDir = path.join(sandbox, "extension");
  unpack(vsix, sandbox);

  const files = walk(sandbox);
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

  check(
    "the extension host entry point shipped",
    existsSync(path.join(packageDir, manifest.main.replace(/^\.\//, ""))),
    manifest.main,
  );
  check("the agent worker shipped", existsSync(path.join(packageDir, "dist/worker.mjs")));
  check("the webview bundle and styles shipped", existsSync(path.join(packageDir, "dist/webview.js")) && existsSync(path.join(packageDir, "dist/webview.css")));
  check("the activity bar icon shipped", existsSync(path.join(packageDir, manifest.icon.replace(/^\.\//, ""))), manifest.icon);
  // vsce normalises these names: LICENSE becomes LICENSE.txt, README.md becomes readme.md.
  const shipped = files.map(name => name.toLowerCase());
  const hasAny = (...names) => names.some(name => shipped.includes(`extension/${name}`.toLowerCase()));
  check(
    "the license and third-party notices shipped",
    hasAny("LICENSE", "LICENSE.txt", "LICENSE.md") && hasAny("THIRD-PARTY-NOTICES.txt"),
    files.filter(name => /licen|notice|readme/i.test(name)).map(name => path.basename(name)).join(", "),
  );
  check("a readme shipped", hasAny("README.md", "readme.md"));

  const leaked = files.filter(
    name => !name.startsWith("extension/node_modules/") && (/^extension\/(src|test)\//.test(name) || name.endsWith(".ts")),
  );
  check("no sources or suites in the package", leaked.length === 0, leaked.slice(0, 3).join(", "));
  check("no source maps in the package", !files.some(name => name.endsWith(".map")), files.filter(n => n.endsWith(".map")).slice(0, 3).join(", "));

  const strayModules = [
    ...new Set(
      files
        .filter(name => name.startsWith("extension/node_modules/"))
        .map(name => name.split("/").slice(1, 3).join("/")),
    ),
  ];
  check(
    "only the runtime-external package is vendored",
    strayModules.every(name => name.includes("photon") || name.includes("silvia")),
    strayModules.join(", ") || "none",
  );

  const unpackedMB = files.reduce((sum, name) => sum + statSync(path.join(sandbox, name)).size, 0) / 1024 / 1024;
  check(`unpacked size under ${unpackedSizeLimitMB} MB`, unpackedMB < unpackedSizeLimitMB, `${unpackedMB.toFixed(1)} MB, ${files.length} files`);

  // Now the real question: does the agent start from these files?
  const env = { ...process.env, AMULET_WORKER: path.join(packageDir, "dist/worker.mjs"), AMULET_DIST: path.join(packageDir, "dist") };
  for (const suite of ["test/smoke-worker.mjs", "test/host-activate.cjs"]) {
    console.log(`\n$ ${suite} (against the unpacked package)`);
    const result = spawnSync(process.execPath, [path.join(root, suite)], { cwd: root, stdio: "inherit", env });
    check(`${suite} passes against the package`, result.status === 0, `exit ${result.status}`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nPACKAGE OK");
}
