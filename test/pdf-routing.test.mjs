import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.COMMONPLACE_DATA_DIR = await mkdtemp(join(tmpdir(), 'commonplace-unit-'));
const { isConnectionError, looksLikePdfUrl, pdfFileNameFromUrl } = await import('../server.mjs');

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
