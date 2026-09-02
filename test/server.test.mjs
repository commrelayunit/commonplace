import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const port = 4187;
const root = process.cwd();
const dataDir = await mkdtemp(join(tmpdir(), 'commonplace-test-'));
let server;

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/items`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Commonplace test server did not start');
}

before(async () => {
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), COMMONPLACE_DATA_DIR: dataDir }, stdio: 'ignore' });
  await waitForServer();
});
after(async () => { server.kill(); await rm(dataDir, { recursive: true, force: true }); });

test('creates an item, persists tags, notes, and reading progress', async () => {
  const create = await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'A local test reading', kind: 'text', body: 'A private page.', tags: ['testing', 'local'] }) });
  assert.equal(create.status, 201);
  const item = await create.json();
  assert.equal(item.title, 'A local test reading');
  assert.deepEqual(item.tags.sort(), ['local', 'testing']);

  const note = await fetch(`http://127.0.0.1:${port}/api/items/${item.id}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'A durable marginal note.' }) });
  assert.equal(note.status, 201);

  const progress = await fetch(`http://127.0.0.1:${port}/api/items/${item.id}/progress`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ percent: 47, scrollY: 321 }) });
  assert.equal(progress.status, 200);
  assert.equal((await progress.json()).progress, 47);

  const reader = await fetch(`http://127.0.0.1:${port}/api/items/${item.id}`);
  const saved = await reader.json();
  assert.equal(saved.scroll_y, 321);
  assert.equal(saved.notes[0].body, 'A durable marginal note.');
});
