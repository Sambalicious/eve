import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { classify, decide, jobs, onlyAgentScriptsDiffer, withDependents } from './changes.mjs';

const PACKAGES = new Map([
  ['apps/api/', { name: '@eve/api', deps: ['@eve/contracts'] }],
  ['apps/web/', { name: '@eve/web', deps: ['@eve/contracts'] }],
  ['apps/e2e/', { name: '@eve/e2e', deps: [] }],
  ['packages/contracts/', { name: '@eve/contracts', deps: [] }],
]);

test('build and CI configuration run everything', () => {
  for (const file of ['pnpm-lock.yaml', 'turbo.json', '.nvmrc', 'package.json', '.github/workflows/ci.yml', 'scripts/ci/api-image-smoke.sh']) {
    assert.equal(classify([file], PACKAGES).full, true, file);
  }
});

test('docs and agent files are other files, not packages', () => {
  const result = classify(['AGENTS.md', 'epics/active/EPIC-1/prd.md', '.agents/qa.md', 'opencode.json'], PACKAGES);
  assert.equal(result.full, false);
  assert.equal(result.changed.size, 0);
  assert.equal(result.other.length, 4);
});

test('a root manifest change confined to agent scripts is not a full run', () => {
  const before = JSON.stringify({ name: 'eve', scripts: { test: 'turbo run test', 'agents:test': 'a' } });
  const agentOnly = JSON.stringify({ name: 'eve', scripts: { test: 'turbo run test', 'agents:test': 'b', 'agents:new': 'c' } });
  const testChange = JSON.stringify({ name: 'eve', scripts: { test: 'turbo run test --x', 'agents:test': 'a' } });
  assert.equal(onlyAgentScriptsDiffer(before, agentOnly), true);
  assert.equal(onlyAgentScriptsDiffer(before, testChange), false);
  assert.equal(classify(['package.json'], PACKAGES, { agentOnlyManifest: true }).full, false);
});

test('a contracts change widens to its dependents', () => {
  assert.deepEqual([...withDependents(new Set(['@eve/contracts']), PACKAGES)].sort(), ['@eve/api', '@eve/contracts', '@eve/web']);
});

test('a web-only change skips api integration and the image smoke', () => {
  const plan = jobs({ mode: 'scoped', affected: new Set(['@eve/web']), other: false });
  assert.equal(plan.api, false);
  assert.equal(plan.e2e, true);
  assert.equal(plan.test_filter, '--filter=@eve/web');
  assert.equal(plan.agents, false);
});

test('an api-only change has no non-api unit tests to run', () => {
  const plan = jobs({ mode: 'scoped', affected: new Set(['@eve/api']), other: false });
  assert.equal(plan.api, true);
  assert.equal(plan.nonapi_tests, false);
});

// End to end against a throwaway repository.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'ci-changes-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 't');
  write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
  write('package.json', '{"name":"root","scripts":{"test":"turbo run test"}}');
  write('apps/api/package.json', '{"name":"@eve/api","dependencies":{"@eve/contracts":"workspace:*"}}');
  write('apps/api/test/contract.spec.ts', 'readFileSync("../../epics/active/E1/api-contract.md")\n');
  write('apps/web/package.json', '{"name":"@eve/web","dependencies":{"@eve/contracts":"workspace:*"}}');
  write('apps/web/src/a.ts', '// see epics/active/E1/prd.md for the background\n');
  write('packages/contracts/package.json', '{"name":"@eve/contracts"}');
  write('epics/active/E1/api-contract.md', 'v1');
  write('epics/active/E1/prd.md', 'v1');
  run('add', '-A');
  run('commit', '-qm', 'base');
  const commit = message => {
    run('add', '-A');
    run('commit', '-qm', message);
    return run('rev-parse', 'HEAD');
  };
  return { root, run, write, commit, rm: () => rmSync(root, { recursive: true, force: true }) };
}

function inRepo(r, fn) {
  const cwd = process.cwd();
  process.chdir(r.root);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
}

test('a doc that a test reads runs that package; a doc only named in a comment does not', () => {
  const r = repo();
  try {
    const base = r.run('rev-parse', 'HEAD');
    r.write('epics/active/E1/api-contract.md', 'v2');
    const head = r.commit('contract');
    const d = inRepo(r, () => decide({ base, head }));
    assert.equal(d.mode, 'scoped');
    assert.deepEqual([...d.affected], ['@eve/api']);

    r.write('epics/active/E1/prd.md', 'v2');
    const head2 = r.commit('prd');
    const d2 = inRepo(r, () => decide({ base: head, head: head2 }));
    assert.equal(d2.affected.size, 0);
    assert.equal(d2.other, true);
  } finally {
    r.rm();
  }
});

test('moving a file a test reads still runs that test', () => {
  const r = repo();
  try {
    const base = r.run('rev-parse', 'HEAD');
    mkdirSync(join(r.root, 'epics/completed'), { recursive: true });
    renameSync(join(r.root, 'epics/active/E1'), join(r.root, 'epics/completed/E1'));
    const head = r.commit('complete epic');
    const d = inRepo(r, () => decide({ base, head }));
    assert.ok(d.affected.has('@eve/api'));
  } finally {
    r.rm();
  }
});

test('the lockfile, an unknown base and a new branch run everything', () => {
  const r = repo();
  try {
    const base = r.run('rev-parse', 'HEAD');
    r.write('pnpm-lock.yaml', 'x');
    const head = r.commit('lock');
    assert.equal(inRepo(r, () => decide({ base, head })).mode, 'full');
    assert.equal(inRepo(r, () => decide({ base: 'deadbeef', head })).mode, 'full');
    assert.equal(inRepo(r, () => decide({ base: '0'.repeat(40), head })).mode, 'full');
  } finally {
    r.rm();
  }
});

test('nightly runs everything after a commit and nothing on a quiet day', () => {
  const recent = repo();
  try {
    assert.equal(inRepo(recent, () => decide({ event: 'schedule' })).mode, 'full');
  } finally {
    recent.rm();
  }
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = '2000-01-01T00:00:00Z';
  try {
    const quiet = repo();
    try {
      assert.equal(inRepo(quiet, () => decide({ event: 'schedule' })).mode, 'none');
    } finally {
      quiet.rm();
    }
  } finally {
    delete process.env.GIT_AUTHOR_DATE;
    delete process.env.GIT_COMMITTER_DATE;
  }
});

test('Markdown inside a package counts only when that package quotes it', () => {
  const r = repo();
  try {
    r.write('apps/api/docs/api-contract.md', 'v1');
    r.write('apps/api/docs/runbook.md', 'v1');
    r.write('apps/api/test/doc.spec.ts', "readFileSync(join(ROOT, 'docs/api-contract.md'))\n");
    const base = r.commit('docs');
    r.write('apps/api/docs/runbook.md', 'v2');
    const head = r.commit('runbook');
    assert.equal(inRepo(r, () => decide({ base, head })).affected.size, 0);
    r.write('apps/api/docs/api-contract.md', 'v2');
    const head2 = r.commit('contract');
    assert.deepEqual([...inRepo(r, () => decide({ base: head, head: head2 })).affected], ['@eve/api']);
  } finally {
    r.rm();
  }
});

test('a root manifest change to agent scripts alone selects no package', () => {
  const r = repo();
  try {
    r.write('apps/web/src/version.ts', "import pkg from '../../package.json'\n");
    const base = r.commit('reads manifest');
    r.write('package.json', '{"name":"root","scripts":{"test":"turbo run test","agents:x":"y"}}');
    const head = r.commit('agent script');
    const d = inRepo(r, () => decide({ base, head }));
    assert.equal(d.mode, 'scoped');
    assert.equal(d.affected.size, 0);
  } finally {
    r.rm();
  }
});
