import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('package, report and MCP server versions stay aligned', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const team = await readFile(new URL('src/team.mjs', root), 'utf8');
  const mcp = await readFile(new URL('src/team-mcp.mjs', root), 'utf8');
  const escaped = pkg.version.replaceAll('.', '\\.');

  assert.equal(pkg.version, '0.3.7');
  assert.match(team, new RegExp(`version: '${escaped}'`));
  assert.match(mcp, new RegExp(`version: '${escaped}'`));
});

test('repository hygiene excludes local reports, credentials and generated runs', async () => {
  const ignore = await readFile(new URL('.gitignore', root), 'utf8');
  for (const entry of ['runs/', 'backups/', 'node_modules/', '.env*', '*.local.json']) {
    assert.ok(ignore.split(/\r?\n/).includes(entry), `${entry} must stay ignored`);
  }

  await access(new URL('SECURITY.md', root));
  await access(new URL('scripts/bootstrap-wsl.sh', root));
});

test('public package is independent from its original project', async () => {
  const paths = ['package.json', 'qa.config.json', 'README.md', 'SECURITY.md',
    'src/cli.mjs', 'src/core.mjs', 'src/team.mjs', 'src/team-mcp.mjs', 'src/live-runtime.mjs', 'src/dashboard.mjs'];
  const text = (await Promise.all(paths.map(path => readFile(new URL(path, root), 'utf8')))).join('\n');
  assert.doesNotMatch(text, /ivmera/i);
});
