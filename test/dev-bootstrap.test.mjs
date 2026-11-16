import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = process.cwd();

test('clones the pinned tag on first run and is a no-op on the second', async () => {
  const work = await mkdtemp(join(tmpdir(), 'commonplace-bootstrap-'));
  const fixtureRepo = join(work, 'fixture-firecrawl.git');
  await exec('git', ['init', '--bare', fixtureRepo]);
  const seed = join(work, 'seed');
  await exec('git', ['clone', fixtureRepo, seed]);
  await writeFile(join(seed, 'docker-compose.yaml'), 'services:\n  api:\n    image: scratch\n');
  await exec('git', ['-C', seed, 'add', 'docker-compose.yaml']);
  await exec('git', ['-C', seed, '-c', 'user.email=t@t.co', '-c', 'user.name=t', 'commit', '-m', 'seed']);
  await exec('git', ['-C', seed, 'tag', 'v0.0.0-test']);
  await exec('git', ['-C', seed, 'push', 'origin', 'HEAD:refs/heads/main', '--tags']);

  const checkoutDir = join(work, 'checkout');
  const env = { ...process.env, FIRECRAWL_REPO_URL: fixtureRepo, FIRECRAWL_REPO_TAG: 'v0.0.0-test', FIRECRAWL_CHECKOUT_DIR: checkoutDir };

  const first = await exec('sh', [join(root, 'scripts/dev-bootstrap.sh')], { env });
  assert.match(first.stdout, /FIRECRAWL_BASE_URL/);
  assert.equal(await readFile(join(checkoutDir, 'docker-compose.yaml'), 'utf8'), 'services:\n  api:\n    image: scratch\n');

  const second = await exec('sh', [join(root, 'scripts/dev-bootstrap.sh')], { env });
  assert.match(second.stdout, /already present/);
});
