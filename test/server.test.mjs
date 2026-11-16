import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const port = 4187;
const firecrawlPort = 4188;
const root = process.cwd();
const dataDir = await mkdtemp(join(tmpdir(), 'commonplace-test-'));
let server;
let firecrawl;

const pdfServicePort = 4192;
const pdfOkPort = 4193;
const pdfUnreachablePort = 4195;
let pdfMarkdown, pdfOk, pdfUnreachable;
const pdfOkDataDir = await mkdtemp(join(tmpdir(), 'commonplace-test-'));
const pdfUnreachableDataDir = await mkdtemp(join(tmpdir(), 'commonplace-test-'));

async function waitForServer(targetPort) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${targetPort}/api/items`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Commonplace test server did not start');
}

before(async () => {
  firecrawl = createServer(async (request, response) => {
    let payload = '';
    for await (const chunk of request) payload += chunk;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/scrape');
    assert.equal(JSON.parse(payload).url, 'https://example.com/');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { markdown: '# Fixture article\n\nA deterministic local capture.', html: '<article><h1>Fixture article</h1></article>', metadata: { title: 'Fixture article' } } }));
  });
  await new Promise(resolve => firecrawl.listen(firecrawlPort, '127.0.0.1', resolve));
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), COMMONPLACE_DATA_DIR: dataDir, FIRECRAWL_BASE_URL: `http://127.0.0.1:${firecrawlPort}` }, stdio: 'ignore' });
  await waitForServer(port);

  pdfMarkdown = createServer(async (request, response) => {
    let chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (body.includes('TRIGGER_500')) { response.writeHead(500); return response.end('boom'); }
    if (body.includes('TRIGGER_EMPTY')) { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ markdown: '', images: {} })); }
    if (body.includes('TRIGGER_SLOW')) await new Promise(resolve => setTimeout(resolve, 3000));
    if (body.includes('TRIGGER_TRAVERSAL')) { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ markdown: '# Traversal\n\nShould stay inside assets/.', images: { '../../evil.png': Buffer.from('fake').toString('base64') } })); }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ markdown: '# Fixture PDF\n\nConverted via the mocked PDF-markdown service.', images: { 'fig1.png': Buffer.from('fake-image-bytes').toString('base64') } }));
  });
  await new Promise(resolve => pdfMarkdown.listen(pdfServicePort, '127.0.0.1', resolve));
  pdfOk = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(pdfOkPort), COMMONPLACE_DATA_DIR: pdfOkDataDir, PDF_SERVICE_BASE_URL: `http://127.0.0.1:${pdfServicePort}`, PDF_SERVICE_TIMEOUT_MS: '1000' }, stdio: 'ignore' });
  pdfUnreachable = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(pdfUnreachablePort), COMMONPLACE_DATA_DIR: pdfUnreachableDataDir, PDF_SERVICE_BASE_URL: 'http://127.0.0.1:4196' }, stdio: 'ignore' });
  await waitForServer(pdfOkPort); await waitForServer(pdfUnreachablePort);
});
after(async () => {
  server.kill(); await new Promise(resolve => firecrawl.close(resolve)); await rm(dataDir, { recursive: true, force: true });
  pdfOk.kill(); pdfUnreachable.kill(); await new Promise(resolve => pdfMarkdown.close(resolve));
  await rm(pdfOkDataDir, { recursive: true, force: true }); await rm(pdfUnreachableDataDir, { recursive: true, force: true });
});

test('starts with an empty shelf rather than template entries', async () => {
  const items = await fetch(`http://127.0.0.1:${port}/api/items`);
  assert.deepEqual(await items.json(), []);
});

test('starts with an empty shelf rather than template entries', async () => {
  const items = await fetch(`http://127.0.0.1:${port}/api/items`);
  assert.deepEqual(await items.json(), []);
});

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
  assert.equal(saved.capture_status, 'ready');
  assert.match(await readFile(saved.content_path, 'utf8'), /A local test reading/);
  assert.ok((await stat(saved.original_path)).isFile());
});

test('captures a URL through a deterministic self-hosted Firecrawl fixture', async () => {
  const capture = await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceUrl: 'https://example.com/' }) });
  assert.equal(capture.status, 201);
  const item = await capture.json();
  assert.equal(item.title, 'Fixture article');
  assert.equal(item.parser_name, 'self-hosted-firecrawl');
  assert.match(await readFile(item.content_path, 'utf8'), /deterministic local capture/);
  assert.ok((await stat(item.original_path)).isFile());
});

test('rejects local-network capture targets before fetching them', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceUrl: 'http://127.0.0.1:4187/private' }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Local addresses|Private-network/);
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

test('converts an uploaded PDF through the mocked PDF-markdown service and stores returned assets', async () => {
  const fileData = Buffer.from('%PDF-1.4 plain upload').toString('base64');
  const create = await fetch(`http://127.0.0.1:${pdfOkPort}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'ok.pdf', fileMime: 'application/pdf', fileData }) });
  assert.equal(create.status, 201);
  const item = await create.json();
  assert.equal(item.parser_name, 'pdf-markdown-service');
  assert.match(await readFile(item.content_path, 'utf8'), /Converted via the mocked PDF-markdown service/);
  assert.ok((await stat(join(item.artifact_dir, 'assets', 'fig1.png'))).isFile());
});

test('falls back to the local extractor when the PDF service is unreachable', async () => {
  const fileData = Buffer.from('%PDF-1.4\n1 0 obj << /Title (Kept locally) >>\nendobj').toString('base64');
  const create = await fetch(`http://127.0.0.1:${pdfUnreachablePort}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'x.pdf', fileMime: 'application/pdf', fileData }) });
  assert.equal(create.status, 201);
  const item = await create.json();
  assert.equal(item.parser_name, 'pdfjs-text-layer');
  assert.equal(item.title, 'Kept locally');
});

test('surfaces a PDF-service HTTP failure instead of silently degrading', async () => {
  const fileData = Buffer.from('%PDF-1.4 TRIGGER_500').toString('base64');
  const create = await fetch(`http://127.0.0.1:${pdfOkPort}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'bad.pdf', fileMime: 'application/pdf', fileData }) });
  assert.equal(create.status, 400);
});

test('surfaces an empty-markdown PDF-service response as a failure', async () => {
  const fileData = Buffer.from('%PDF-1.4 TRIGGER_EMPTY').toString('base64');
  const create = await fetch(`http://127.0.0.1:${pdfOkPort}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'empty.pdf', fileMime: 'application/pdf', fileData }) });
  assert.equal(create.status, 400);
});

test('treats a slow PDF-service response as a failure, not a silent fallback', async () => {
  const fileData = Buffer.from('%PDF-1.4 TRIGGER_SLOW').toString('base64');
  const create = await fetch(`http://127.0.0.1:${pdfOkPort}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'slow.pdf', fileMime: 'application/pdf', fileData }) });
  assert.equal(create.status, 400);
});

test("sanitizes PDF-service image filenames to stay inside the item's assets directory", async () => {
  const fileData = Buffer.from('%PDF-1.4 TRIGGER_TRAVERSAL').toString('base64');
  const create = await fetch(`http://127.0.0.1:${pdfOkPort}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'trav.pdf', fileMime: 'application/pdf', fileData }) });
  assert.equal(create.status, 201);
  const item = await create.json();
  assert.ok((await stat(join(item.artifact_dir, 'assets', 'evil.png'))).isFile());
  await assert.rejects(stat(join(item.artifact_dir, '..', 'evil.png')));
});
