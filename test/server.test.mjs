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

test('creates a PDF item, persists tags, notes, and reading progress', async () => {
  const fileData = Buffer.from('%PDF-1.4\n1 0 obj << /Title (A local test reading) >>\nendobj').toString('base64');
  const create = await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'test.pdf', fileMime: 'application/pdf', fileData, tags: ['testing', 'local'] }) });
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

test('infers a URL title and has a deterministic URL-path fallback', async () => {
  const metadata = await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceUrl: 'https://example.com/' }) });
  assert.equal(metadata.status, 201);
  assert.equal((await metadata.json()).title, 'Example Domain');

  const fallback = await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceUrl: 'https://example.invalid/reading/a-quiet-thing' }) });
  assert.equal(fallback.status, 201);
  assert.equal((await fallback.json()).title, 'example.invalid — a quiet thing');
});

test('infers a PDF title from metadata and falls back to its filename', async () => {
  const metadataPdf = Buffer.from('%PDF-1.4\n1 0 obj << /Title (A PDF Kept Locally) >>\nendobj').toString('base64');
  const metadata = await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'ignored.pdf', fileMime: 'application/pdf', fileData: metadataPdf }) });
  assert.equal(metadata.status, 201);
  assert.equal((await metadata.json()).title, 'A PDF Kept Locally');

  const filenamePdf = Buffer.from('%PDF-1.4\nno title here').toString('base64');
  const fallback = await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'reading_notes-final.pdf', fileMime: 'application/pdf', fileData: filenamePdf }) });
  assert.equal(fallback.status, 201);
  assert.equal((await fallback.json()).title, 'reading notes final');
});
