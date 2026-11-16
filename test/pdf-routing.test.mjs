import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

process.env.COMMONPLACE_DATA_DIR = await mkdtemp(join(tmpdir(), 'commonplace-unit-'));
const { isConnectionError, looksLikePdfUrl, pdfFileNameFromUrl, assertValidPdfServiceUrl, isPdfPayload } = await import('../server.mjs');

test('isConnectionError recognizes a refused connection but not an HTTP failure or a bad URL', () => {
  const refused = new TypeError('fetch failed');
  refused.cause = { code: 'ECONNREFUSED' };
  assert.equal(isConnectionError(refused), true);
  assert.equal(isConnectionError(new Error('PDF service returned 500.')), false);
  assert.equal(isConnectionError(new TypeError('Invalid URL')), false);
});

test('looksLikePdfUrl matches a .pdf path case-insensitively and ignores the query string', () => {
  assert.equal(looksLikePdfUrl(new URL('https://example.com/paper.PDF')), true);
  assert.equal(looksLikePdfUrl(new URL('https://example.com/article')), false);
  assert.equal(looksLikePdfUrl(new URL('https://example.com/page?file=report.pdf')), false);
});

test('pdfFileNameFromUrl derives a .pdf filename from the URL path', () => {
  assert.equal(pdfFileNameFromUrl(new URL('https://example.com/reports/q3.pdf')), 'q3.pdf');
  assert.equal(pdfFileNameFromUrl(new URL('https://example.com/download')), 'download.pdf');
  assert.equal(pdfFileNameFromUrl(new URL('https://example.com/')), 'reading.pdf');
});

test('assertValidPdfServiceUrl throws when the raw value is set but failed to parse, and is silent otherwise', () => {
  assert.throws(() => assertValidPdfServiceUrl('localhost:8008', null), /PDF_SERVICE_BASE_URL is set but not a valid http\(s\) URL\./);
  assert.doesNotThrow(() => assertValidPdfServiceUrl(undefined, null));
  assert.doesNotThrow(() => assertValidPdfServiceUrl('', null));
  assert.doesNotThrow(() => assertValidPdfServiceUrl('http://127.0.0.1:8008', new URL('http://127.0.0.1:8008')));
});

test('isPdfPayload trusts magic bytes or an application/pdf content-type, not a .pdf-looking URL alone', () => {
  const htmlLoginWall = Buffer.from('<html><body>Please sign in</body></html>');
  assert.equal(isPdfPayload('text/html', htmlLoginWall), false);
  assert.equal(isPdfPayload('application/pdf', htmlLoginWall), true);
  const realPdfBytes = Buffer.from('%PDF-1.4\n...');
  assert.equal(isPdfPayload('application/octet-stream', realPdfBytes), true);
  assert.equal(isPdfPayload('', realPdfBytes), true);
});

test('a malformed PDF_SERVICE_BASE_URL makes the server fail to start instead of silently degrading', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'commonplace-unit-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '0', COMMONPLACE_DATA_DIR: dataDir, PDF_SERVICE_BASE_URL: 'localhost:8008' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await new Promise(resolve => child.on('exit', (exitCode, signal) => resolve([exitCode, signal])));
  assert.notEqual(code, 0);
  assert.match(stderr, /PDF_SERVICE_BASE_URL is set but not a valid http\(s\) URL\./);
});
