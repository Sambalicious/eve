#!/usr/bin/env node
// Runs the checks affected by this branch's diff, not the whole repo.
// CI still owns the full suites; this is the pre-handoff gate agents can afford.
//
//   pnpm check:changed
//   pnpm check:changed --base main
//   pnpm check:changed --tasks typecheck,lint
//   pnpm check:changed --list
//
// A file whose change can affect every package (root manifest, lockfile,
// workspace config, shared TypeScript config) runs the unfiltered command
// instead of pretending the diff is local.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_SECONDS = 900;

// Changing one of these can invalidate every package's cache or dependency graph.
const GLOBAL_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.base.json",
  ".nvmrc",
]);
const GLOBAL_PATTERNS = [/(^|\/)eslint\.config\.[cm]?[jt]s$/, /^tsconfig[^/]*\.json$/];

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const tasks = (flag("--tasks") ?? "typecheck,lint,test")
  .split(",")
  .map((task) => task.trim())
  .filter(Boolean);
const timeoutSeconds = Number(flag("--timeout") ?? DEFAULT_TIMEOUT_SECONDS);
const listOnly = args.includes("--list");

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();

function resolveBase() {
  const requested = flag("--base");
  if (requested) {
    try {
      const sha = git("rev-parse", "--verify", "--quiet", `${requested}^{commit}`);
      return { ref: requested, sha };
    } catch {
      fail(`base "${requested}" is not a commit in this repo.`);
    }
  }
  for (const candidate of ["origin/main", "main"]) {
    try {
      const sha = git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
      return { ref: candidate, sha };
    } catch {
      // Try the next candidate.
    }
  }
  console.warn("check:changed: no origin/main or main ref; running every package.");
  return null;
}

function fail(message) {
  console.error(`check:changed: ${message}`);
  process.exit(2);
}

const base = resolveBase();
let mergeBase = null;
if (base) {
  try {
    mergeBase = git("merge-base", "HEAD", base.sha);
  } catch {
    console.warn(`check:changed: HEAD shares no history with ${base.ref}; running every package.`);
  }
}
// Without a shared base the diff cannot be trusted to describe the change.
const forceAll = !mergeBase;

const changed = mergeBase
  ? git("diff", "--name-only", "--diff-filter=ACMRTUXB", mergeBase)
      .split("\n")
      .filter(Boolean)
  : [];
const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
const touched = [...changed, ...untracked];

if (touched.length === 0) {
  console.log(`check:changed: nothing changed against ${base?.ref ?? "HEAD"}.`);
  process.exit(0);
}

const isGlobal = (file) =>
  GLOBAL_FILES.has(file) || GLOBAL_PATTERNS.some((pattern) => pattern.test(file));
const globalTrigger = touched.find(isGlobal);

// Untracked files are invisible to turbo's git filter, so map them to their
// owning workspace package and include that package plus its dependents.
// A root-level file belongs to no package and is reported instead of skipped.
function ownerOf(file) {
  let dir = dirname(join(ROOT, file));
  while (dir === ROOT || dir.startsWith(ROOT + "/") || dir.startsWith(ROOT + "\\")) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name && dir !== ROOT) return relative(ROOT, dir);
        return null;
      } catch {
        return null;
      }
    }
    if (dir === ROOT) return null;
    dir = dirname(dir);
  }
  return null;
}

const ownerDirs = new Set();
for (const file of untracked) {
  const owner = ownerOf(file);
  if (owner) ownerDirs.add(owner);
}

const filters = [];
if (globalTrigger || forceAll) {
  if (globalTrigger) console.log(`check:changed: ${globalTrigger} can affect every package.`);
} else {
  filters.push(`...[${mergeBase}]`);
  for (const dir of ownerDirs) filters.push(`./${dir}...`);
}

const unowned = touched.filter(
  (file) =>
    !globalTrigger &&
    !isGlobal(file) &&
    !ownerOf(file) &&
    /\.(?:[cm]?[jt]sx?|json|sql|sh|py|rs|go|css|svelte|vue)$/.test(file),
);

console.log(
  [
    `  base        ${base ? `${base.ref}${mergeBase ? ` (${mergeBase.slice(0, 10)})` : ""}` : "none"}`,
    `  changed     ${changed.length} tracked, ${untracked.length} untracked`,
    `  tasks       ${tasks.join(", ")}`,
    `  filters     ${filters.length ? filters.join(" ") : "(all packages)"}`,
  ].join("\n"),
);
if (unowned.length) {
  console.log(`  unowned     ${unowned.length} file(s) outside every package; no package checks`);
}
if (listOnly) {
  for (const file of touched.slice(0, 40)) console.log(`  ${file}`);
  if (touched.length > 40) console.log("  ...");
  process.exit(0);
}

function run(command, commandArgs) {
  return new Promise((settle) => {
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      settle(code);
    };
    const child = spawn(process.platform === "win32" ? `${command}.cmd` : command, commandArgs, {
      cwd: ROOT,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const timer = Number.isFinite(timeoutSeconds)
      ? setTimeout(() => {
          timedOut = true;
          console.error(`\ncheck:changed: timed out after ${timeoutSeconds}s; killing the run.`);
          signal(child, "SIGTERM");
          setTimeout(() => signal(child, "SIGKILL"), 5000).unref();
        }, timeoutSeconds * 1000)
      : undefined;

    function signal(proc, name) {
      try {
        if (process.platform === "win32") proc.kill(name);
        else process.kill(-proc.pid, name);
      } catch {
        // Already gone.
      }
    }

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      fail(`could not start ${command}: ${error.message}`);
    });
    child.on("exit", (code, name) => {
      if (timer) clearTimeout(timer);
      if (timedOut) finish(124);
      else if (name) {
        console.error(`check:changed: ${command} exited on ${name}.`);
        finish(1);
      } else finish(code ?? 1);
    });
  });
}

const turboArgs = [
  "exec",
  "turbo",
  "run",
  ...tasks,
  ...filters.map((filter) => `--filter=${filter}`),
  "--output-logs=errors-only",
];

const turboStatus = await run("pnpm", turboArgs);
process.exit(turboStatus);
