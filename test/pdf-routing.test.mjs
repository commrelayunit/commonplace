import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.COMMONPLACE_DATA_DIR = await mkdtemp(join(tmpdir(), 'commonplace-unit-'));
const { isConnectionError } = await import('../server.mjs');

test('isConnectionError recognizes a refused connection but not an HTTP failure or a bad URL', () => {
  const refused = new TypeError('fetch failed');
  refused.cause = { code: 'ECONNREFUSED' };
  assert.equal(isConnectionError(refused), true);
  assert.equal(isConnectionError(new Error('PDF service returned 500.')), false);
  assert.equal(isConnectionError(new TypeError('Invalid URL')), false);
});
