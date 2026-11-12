#!/usr/bin/env node
// Decides which CI jobs a change needs, so a docs-only or one-package change does
// not run every suite. .github/workflows/ci.yml runs it first; run it locally to
// see what CI would do:
//
//   node scripts/ci/changes.mjs --base origin/main             # this branch
//   node scripts/ci/changes.mjs --base <sha> --head <sha>      # any range
//
// Rules, in order:
// - .github/, scripts/ci/ and build-relevant root files (lockfile, manifests,
//   turbo.json, .nvmrc, tool config) run everything.
// - A file inside a workspace package marks that package changed.
// - Any other file (epics/, docs/, .agents/, root Markdown, ...) marks the agent
//   checks, and also every package whose sources quote its path: tests import
//   copy decks and contracts from epics/, so those still run.
// - Changed packages widen to their workspace dependents.
// Prints key=value lines and appends them to $GITHUB_OUTPUT when that is set.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FULL_DIRS = ['.github/', 'scripts/ci/'];
// Root files that are not build inputs. Other root files run everything.
const OTHER_ROOT_FILES = new Set(['opencode.json', 'skills-lock.json', '.gitignore', 'LICENSE']);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// Root package.json scripts that only the agent checks use. A root manifest diff
// confined to these is an agent change, not a reason to run everything.
const AGENT_SCRIPT = /^(agents:|factory|check:changed$|test:file$)/;

const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts }).trim();
const lines = text => (text ? text.split('\n') : []);

// Workspace packages at `rev`: Map of directory ("apps/api/") to { name, deps }.
export function readWorkspace(rev, show = path => git(['show', `${rev}:${path}`])) {
  const yaml = show('pnpm-workspace.yaml');
  const parents = [...yaml.matchAll(/^\s*-\s*["']?([\w.-]+)\/\*["']?\s*$/gm)].map(m => m[1]);
  const packages = new Map();
  for (const parent of parents) {
    const manifests = lines(git(['ls-tree', '-r', '--name-only', rev, '--', `${parent}/`]))
      .filter(path => /^[^/]+\/[^/]+\/package\.json$/.test(path));
    for (const manifest of manifests) {
      const pkg = JSON.parse(show(manifest));
      const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      const deps = Object.keys(all).filter(name => String(all[name]).startsWith('workspace:'));
      packages.set(manifest.slice(0, -'package.json'.length), { name: pkg.name, deps });
    }
  }
  return packages;
}

export function packageOf(file, packages) {
  for (const [dir, pkg] of packages) if (file.startsWith(dir)) return pkg.name;
  return null;
}

// True when two root package.json texts differ only in agent-only scripts.
export function onlyAgentScriptsDiffer(before, after) {
  const strip = text => {
    const pkg = JSON.parse(text);
    const scripts = Object.entries(pkg.scripts ?? {}).filter(([name]) => !AGENT_SCRIPT.test(name));
    return JSON.stringify({ ...pkg, scripts: Object.fromEntries(scripts) });
  };
  try {
    return strip(before) === strip(after);
  } catch {
    return false;
  }
}

// Sorts changed files into: full run, changed packages, other files, and
// Markdown inside a package (docs that count only if that package quotes them).
export function classify(files, packages, { agentOnlyManifest = false } = {}) {
  const changed = new Set();
  const other = [];
  const packageDocs = new Map(); // package dir -> [basename]
  let full = false;
  for (const file of files) {
    if (FULL_DIRS.some(dir => file.startsWith(dir))) full = true;
    else if (!file.includes('/')) {
      if (file.endsWith('.md') || OTHER_ROOT_FILES.has(file)) other.push(file);
      // Agent scripts only: no package can depend on that, so it is not searched.
      else if (file === 'package.json' && agentOnlyManifest) other.push(null);
      else full = true;
    } else {
      const dir = [...packages.keys()].find(d => file.startsWith(d));
      if (!dir) other.push(file);
      else if (file.endsWith('.md')) {
        packageDocs.set(dir, [...(packageDocs.get(dir) ?? []), file.slice(file.lastIndexOf('/') + 1)]);
      } else changed.add(packages.get(dir).name);
    }
  }
  return { full, changed, other, packageDocs };
}

// Packages whose non-Markdown sources at `rev` quote one of `paths` the way code
// does: right after a quote, backtick or "/" ("../../epics/..."), so a comment
// that merely names a doc does not count.
export const referencePattern = path =>
  `['"\`/]${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;

export function referencingPackages(paths, packages, rev, dirs = [...packages.keys()]) {
  const found = new Set();
  paths = [...new Set(paths.filter(Boolean))];
  if (!paths.length || !dirs.length) return found;
  for (let i = 0; i < paths.length; i += 200) {
    const patterns = paths.slice(i, i + 200).flatMap(path => ['-e', referencePattern(path)]);
    let out = '';
    try {
      out = git(['grep', '-l', '-E', ...patterns, rev, '--', ...dirs, ':(exclude)*.md']);
    } catch (error) {
      if (error.status !== 1) throw error; // 1 means no match
    }
    for (const hit of lines(out)) {
      const name = packageOf(hit.slice(rev.length + 1), packages);
      if (name) found.add(name);
    }
  }
  return found;
}

export function withDependents(changed, packages) {
  const dependents = new Map();
  for (const { name, deps } of packages.values()) {
    for (const dep of deps) dependents.set(dep, [...(dependents.get(dep) ?? []), name]);
  }
  const out = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    for (const name of dependents.get(queue.pop()) ?? []) {
      if (!out.has(name)) out.add(name), queue.push(name);
    }
  }
  return out;
}

// What changed between base and head: { mode: full | scoped | none, ... }.
export function decide({ event = '', base = '', head = 'HEAD', full = false }) {
  head = git(['rev-parse', head]);
  if (full || event === 'workflow_dispatch') return { mode: 'full', reason: 'requested', head };
  if (event === 'schedule') {
    const recent = git(['log', '-1', '--since=25 hours ago', '--format=%H', head]);
    return recent
      ? { mode: 'full', reason: 'nightly full run', head }
      : { mode: 'none', reason: 'nightly: no commits in the last 25 hours', head };
  }
  let mergeBase;
  if (/^0*$/.test(base)) mergeBase = EMPTY_TREE; // new branch: no previous commit
  else {
    try {
      mergeBase = git(['merge-base', base, head], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return { mode: 'full', reason: `cannot compare with ${base}`, head };
    }
  }
  if (mergeBase === EMPTY_TREE) return { mode: 'full', reason: 'no base commit', head };
  // --no-renames lists a moved file's old path too, so a test still quoting it runs.
  const files = lines(git(['diff', '--name-only', '--no-renames', mergeBase, head]));
  if (!files.length) return { mode: 'none', reason: 'no changed files', head, base: mergeBase, files };
  const packages = readWorkspace(head);
  const show = rev => {
    try {
      return git(['show', `${rev}:package.json`], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  const agentOnlyManifest = files.includes('package.json') && onlyAgentScriptsDiffer(show(mergeBase), show(head));
  const { full: wide, changed, other, packageDocs } = classify(files, packages, { agentOnlyManifest });
  if (wide) return { mode: 'full', reason: 'build or CI configuration changed', head, base: mergeBase, files };
  for (const name of referencingPackages(other, packages, head)) changed.add(name);
  // A package's own Markdown counts when its code quotes the file name, as a
  // relative import ("./copy.md?raw") or a join(root, 'docs/api-contract.md').
  for (const [dir, names] of packageDocs) {
    for (const name of referencingPackages(names, packages, head, [dir])) changed.add(name);
  }
  return {
    mode: 'scoped',
    reason: 'scoped to the diff',
    head,
    base: mergeBase,
    files,
    changed,
    affected: withDependents(changed, packages),
    other: other.length > 0,
  };
}

// ---- eve: which jobs run --------------------------------------------------

const API = '@eve/api';
const filters = names => names.map(name => `--filter=${name}`).join(' ');

export function jobs(d) {
  if (d.mode === 'none') {
    return { checks: false, nonapi_tests: false, api: false, e2e: false, agents: false, turbo_filter: '', test_filter: '' };
  }
  if (d.mode === 'full') {
    return { checks: true, nonapi_tests: true, api: true, e2e: true, agents: true, turbo_filter: '', test_filter: `--filter=!${API}` };
  }
  const names = [...d.affected].sort();
  const nonApi = names.filter(name => name !== API);
  return {
    checks: names.length > 0,
    nonapi_tests: nonApi.length > 0,
    // Integration tests and the node:22 image smoke: the api or what it depends on.
    api: d.affected.has(API),
    // Playwright drives the real api and web, so any package change runs it.
    e2e: names.length > 0,
    agents: d.other,
    turbo_filter: filters(names),
    test_filter: filters(nonApi),
  };
}

function parseArgs(argv) {
  const args = { event: process.env.CI_EVENT ?? '', base: process.env.CI_BASE ?? '', head: process.env.CI_HEAD || 'HEAD', full: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--head') args.head = argv[++i];
    else if (argv[i] === '--event') args.event = argv[++i];
    else if (argv[i] === '--full') args.full = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const d = decide(parseArgs(process.argv.slice(2)));
  const out = { mode: d.mode, base: d.base ?? '', head: d.head, ...jobs(d) };
  const text = Object.entries(out).map(([key, value]) => `${key}=${value}`).join('\n');
  console.log(`${d.reason}${d.files ? ` (${d.files.length} files)` : ''}`);
  if (d.changed) console.log(`changed packages: ${[...d.changed].sort().join(', ') || 'none'}`);
  console.log(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${text}\n`);
}
