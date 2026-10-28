import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import playwright from '../playwright.config.js';

const source = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
const document = parseDocument(source, { version: '1.2', uniqueKeys: true });
assert.deepEqual(document.errors, [], 'Pages workflow must be valid YAML');
const workflow = document.toJS();
const build = workflow.jobs['test-and-package'];
const deploy = workflow.jobs.deploy;
const packaging = build.steps.find(step => step.id === 'package');
const httpsCheck = deploy.steps.find(step => step.env?.PAGE_URL);
const publishCondition = "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sphere-pages-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function listFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(join(directory, entry.name), path) : [path];
  }).sort();
}

test('Pages tests run on main pushes and PRs; only main can deploy', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.on.pull_request.branches, ['main']);
  assert.equal(deploy.needs, 'test-and-package');
  assert.equal(deploy.if, publishCondition);
  assert.equal(build.steps.find(step => step.uses?.startsWith('actions/upload-pages-artifact@')).if, publishCondition);
  assert.equal(deploy.environment.name, 'github-pages');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('Pages build has no deployment credentials and official actions are SHA-pinned', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(build.permissions, undefined);
  assert.deepEqual(deploy.permissions, { pages: 'write', 'id-token': 'write' });
  const allowed = new Set(['checkout', 'setup-node', 'configure-pages', 'upload-pages-artifact', 'deploy-pages']);
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (!step.uses) continue;
    const match = step.uses.match(/^actions\/([a-z-]+)@[a-f0-9]{40}$/);
    assert.ok(match && allowed.has(match[1]), `Unpinned or unexpected action: ${step.uses}`);
  }
  const checkout = build.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(!source.includes('secrets.'), 'Pages must not need a manually stored token');
  assert.ok(!deploy.steps.some(step => step.uses?.startsWith('actions/checkout@')));
  assert.equal(deploy.steps.filter(step => step.run).length, 1, 'Privileged job only executes the fixed HTTPS check');
});

test('Pages installs locked dependencies and Chromium before the canonical gate', () => {
  assert.equal(build.env.CI, 'true');
  assert.equal(build.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], '24');
  const install = build.steps.findIndex(step => step.run === 'npm ci --ignore-scripts');
  const browser = build.steps.findIndex(step => step.run === './node_modules/.bin/playwright install --with-deps chromium');
  const gate = build.steps.findIndex(step => step.run === './scripts/test.sh');
  const pack = build.steps.indexOf(packaging);
  assert.ok(install >= 0 && install < browser && browser < gate && gate < pack);
  assert.notEqual(playwright.use.ignoreHTTPSErrors, true);
  assert.ok(!playwright.use.launchOptions.args.some(argument => argument.includes('ignore-certificate-errors')));
});

test('Pages packaging publishes only explicitly allowed files', t => {
  const root = temporaryDirectory(t);
  const publicFiles = [
    'index.html', 'styles.css', 'app.js', 'projection-engine.js',
    'view-state.js', 'texture-worker.js', 'projections.json', 'LICENSE',
    'assets/preview.gif',
  ];
  const privateFiles = [
    '.env', '.git/config', '.idea/workspace.xml', 'README.md',
    'package.json', 'package-lock.json', 'node_modules/private.txt',
    'test-results/private.txt', 'tests/private.txt', 'assets/private.txt',
  ];
  for (const path of [...publicFiles, ...privateFiles]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `fixture: ${path}`);
  }
  const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', packaging.run], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(listFiles(join(root, '_site')), [...publicFiles, '.nojekyll'].sort());
  for (const path of publicFiles) assert.equal(readFileSync(join(root, '_site', path), 'utf8'), `fixture: ${path}`);
  assert.equal(build.steps.find(step => step.uses?.startsWith('actions/upload-pages-artifact@')).with.path, '_site');
});

test('post-deployment check requires HTTPS and validates TLS without insecure flags', t => {
  const root = temporaryDirectory(t);
  const bin = join(root, 'bin');
  const argumentsFile = join(root, 'curl-arguments');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CURL_ARGUMENTS_FILE"\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CURL_ARGUMENTS_FILE: argumentsFile, PAGE_URL: 'https://example.github.io/sphere_idea/' };
  const args = ['--noprofile', '--norc', '-euo', 'pipefail', '-c', httpsCheck.run];
  const secure = spawnSync('bash', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(secure.status, 0, secure.stderr);
  const flags = readFileSync(argumentsFile, 'utf8').trim().split('\n');
  assert.equal(flags[flags.indexOf('--proto') + 1], '=https');
  assert.equal(flags[flags.indexOf('--proto-redir') + 1], '=https');
  assert.ok(flags.includes('--fail') && flags.includes('--tlsv1.2'));
  assert.ok(!flags.includes('-k') && !flags.includes('--insecure'));
  assert.equal(flags.at(-1), env.PAGE_URL);
  rmSync(argumentsFile);
  const insecure = spawnSync('bash', args, { cwd: root, env: { ...env, PAGE_URL: 'http://example.github.io/' }, encoding: 'utf8' });
  assert.notEqual(insecure.status, 0);
  assert.ok(!listFiles(root).includes('curl-arguments'), 'HTTP must be rejected before curl executes');
});
