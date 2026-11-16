# Markdown capture services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Commonplace a real local PDF-to-Markdown service (wrapping Marker) that both uploaded PDFs and PDF-via-URL route through, and a consistent dev-only Docker Compose overlay that brings up every local capture dependency (that PDF service, plus a locally-run Firecrawl) the same way, without touching the production `compose.yaml`.

**Architecture:** A new FastAPI microservice (`services/pdf-markdown/`) wraps the `marker-pdf` Python package behind one `POST /convert` endpoint. `server.mjs` calls it the same way it already calls self-hosted Firecrawl — prefer the service, fall back to the existing bounded local parser only when the service is unreachable, never when it merely fails. A new `compose.dev.yaml` overlay defines the PDF service directly and pulls in a separately-cloned Firecrawl checkout via Compose's `include:` directive; `compose.yaml` itself never changes. URL intake gains a cheap `.pdf`-extension sniff so a PDF link is routed to the PDF service instead of Firecrawl.

**Tech Stack:** Node 22 (`server.mjs`, built-in `node:test`), Python 3.11 + FastAPI + `marker-pdf` (new), Docker Compose v2 `include:`.

**Spec:** `docs/superpowers/specs/2026-11-16-markdown-capture-services-design.md`

## Global Constraints

- `server.mjs` is the only code that ever fetches a user-supplied URL; the PDF service never fetches anything itself — it only ever receives bytes Node already fetched or an upload already contains.
- `compose.yaml` stays production-only (just the `commonplace` service reading dependency URLs from `.env`). No profiles, no dependency services added to it.
- Firecrawl's source is never vendored into this repo — only referenced via a gitignored external checkout plus Compose `include:`.
- "Unreachable" (silent fallback to the PDF.js extractor) means `PDF_SERVICE_BASE_URL` is unset, or the request fails to connect (`ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN`). Anything else — an HTTP error status, a timeout, an empty/malformed response — is "failing": it surfaces as a capture error and must never silently degrade.
- A PDF fetched via URL uses `UPLOAD_MAX_BYTES` (25MB default) as its byte cap, not `CAPTURE_MAX_BYTES` (8MB, sized for HTML pages).
- Self-hosted Firecrawl's plain `formats: ['markdown']` scrape needs no OpenAI/LLM API key — only its `extract`/JSON formats do, which Commonplace doesn't use.
- A PDF's title always comes from the existing `inferPdfTitle()` (filename / PDF `/Title` metadata), never from whatever heading Marker's markdown body happens to start with.

## Review Focus

- A PDF service response that is HTTP 200 but carries empty/missing `markdown` must surface as a capture failure, not a silent fallback (Task 5).
- A PDF service response whose `images` map includes a path-traversal filename (e.g. `../../evil.png`) must be written only inside the item's own `assets/` directory, never escape it (Task 5).
- A PDF service call that times out (slow conversion exceeding `PDF_SERVICE_TIMEOUT_MS`) must be treated as "failing" (surfaced), not "unreachable" (silently falls back) (Task 5).
- A `TypeError` that is not a recognized connection refusal (e.g. a malformed `PDF_SERVICE_BASE_URL`) must not be misclassified as "unreachable" (Task 5).
- A URL whose query string merely mentions `.pdf` but whose path does not end in `.pdf` must not be misclassified as a PDF link (Task 6).

---

### Task 1: PDF-markdown service skeleton (`/health`)

**Files:**
- Create: `services/pdf-markdown/app.py`
- Create: `services/pdf-markdown/requirements.txt`
- Test: `services/pdf-markdown/tests/test_app.py`

**Interfaces:**
- Produces: a FastAPI instance `app` in `services/pdf-markdown/app.py`; `GET /health` → `200 {"status": "ok"}`.

- [ ] **Step 1: Write `requirements.txt`**

```
fastapi
uvicorn[standard]
python-multipart
httpx
pytest
marker-pdf
pillow
```

- [ ] **Step 2: Install dependencies**

Run: `cd services/pdf-markdown && pip install -r requirements.txt`
Expected: exits 0 (this pulls PyTorch and Marker's models support and will take a while and several GB — expected per the spec's constraints).

- [ ] **Step 3: Write the failing test**

```python
# services/pdf-markdown/tests/test_app.py
from fastapi.testclient import TestClient
from app import app

def test_health_returns_ok():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd services/pdf-markdown && python -m pytest tests/test_app.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'app'` or import error)

- [ ] **Step 5: Implement the FastAPI skeleton in `services/pdf-markdown/app.py`**

```python
from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd services/pdf-markdown && python -m pytest tests/test_app.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add services/pdf-markdown/app.py services/pdf-markdown/requirements.txt services/pdf-markdown/tests/test_app.py
git commit -m "feat: scaffold the pdf-markdown service with a health check"
```

---

### Task 2: `/convert` endpoint wrapping Marker

**Files:**
- Modify: `services/pdf-markdown/app.py`
- Modify: `services/pdf-markdown/tests/test_app.py`

**Interfaces:**
- Consumes: `app` (Task 1).
- Produces: `encode_image(image) -> str` (base64-encoded PNG); `convert_pdf_bytes(data: bytes) -> dict` with keys `"markdown": str` and `"images": dict[str, str]`; `POST /convert` (multipart field `file`) → `200 {"markdown": ..., "images": ...}` | `400` (not a PDF) | `502` (conversion failed). This is the exact contract `server.mjs`'s `pdfServiceConvert` (Task 5) calls.

- [ ] **Step 1: Write the failing tests**

```python
# services/pdf-markdown/tests/test_app.py (append)
import base64
import io

from PIL import Image

from app import encode_image

PDF_BYTES = b"%PDF-1.4\n%fake-but-well-formed-enough-for-tests"


def test_convert_rejects_non_pdf_content():
    client = TestClient(app)
    response = client.post("/convert", files={"file": ("notes.txt", b"hello", "text/plain")})
    assert response.status_code == 400


def test_convert_returns_markdown_and_images(monkeypatch):
    fixture = {"markdown": "# Fixture\n\nHello.", "images": {"fig1.png": "aGVsbG8="}}
    monkeypatch.setattr("app.convert_pdf_bytes", lambda data: fixture)
    client = TestClient(app)
    response = client.post("/convert", files={"file": ("doc.pdf", PDF_BYTES, "application/pdf")})
    assert response.status_code == 200
    assert response.json() == fixture


def test_convert_surfaces_conversion_failures(monkeypatch):
    def boom(data):
        raise RuntimeError("marker blew up")

    monkeypatch.setattr("app.convert_pdf_bytes", boom)
    client = TestClient(app)
    response = client.post("/convert", files={"file": ("doc.pdf", PDF_BYTES, "application/pdf")})
    assert response.status_code == 502


def test_encode_image_returns_base64_png():
    image = Image.new("RGB", (1, 1))
    encoded = encode_image(image)
    decoded = base64.b64decode(encoded)
    assert decoded.startswith(b"\x89PNG")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/pdf-markdown && python -m pytest tests/test_app.py -v`
Expected: FAIL (`encode_image`/`convert_pdf_bytes` don't exist, `/convert` is 404)

- [ ] **Step 3: Implement `encode_image(image) -> str` in `app.py`**

Serialize the PIL image to PNG bytes in memory (`io.BytesIO`), base64-encode, return as `str`.

- [ ] **Step 4: Implement `convert_pdf_bytes(data: bytes) -> dict` in `app.py`**

Write `data` to a `tempfile.NamedTemporaryFile(suffix=".pdf")`, run it through Marker's `PdfConverter(artifact_dict=get_models())` (a module-level `get_models()` helper that lazily calls `marker.models.create_model_dict()` once and caches it in a global), unpack the result with `marker.output.text_from_rendered` to get `(markdown, metadata, images)`, delete the temp file in a `finally`, and return `{"markdown": markdown, "images": {name: encode_image(img) for name, img in images.items()}}`.

- [ ] **Step 5: Implement `POST /convert` in `app.py`**

```python
from fastapi import File, HTTPException, UploadFile


@app.post("/convert")
async def convert(file: UploadFile = File(...)):
    is_pdf = file.content_type == "application/pdf" or (file.filename or "").lower().endswith(".pdf")
    if not is_pdf:
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")
    data = await file.read()
    try:
        return convert_pdf_bytes(data)
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Conversion failed: {error}") from error
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd services/pdf-markdown && python -m pytest tests/test_app.py -v`
Expected: PASS (4 new tests + the Task 1 health test)

- [ ] **Step 7: Commit**

```bash
git add services/pdf-markdown/app.py services/pdf-markdown/tests/test_app.py
git commit -m "feat: wrap Marker behind a POST /convert endpoint"
```

---

### Task 3: Dockerfile + `compose.dev.yaml` (pdf-markdown service)

**Files:**
- Create: `services/pdf-markdown/Dockerfile`
- Create: `compose.dev.yaml`

**Interfaces:**
- Consumes: `services/pdf-markdown/app.py` + `requirements.txt` (Tasks 1–2).
- Produces: a `pdf-markdown` Compose service, reachable from the host at `http://localhost:${PDF_SERVICE_PORT:-8008}` once `docker compose -f compose.yaml -f compose.dev.yaml up -d` is run — this is what `.env`'s `PDF_SERVICE_BASE_URL` points at in dev (Task 5 consumes that env var, not this file directly).

- [ ] **Step 1: Write `services/pdf-markdown/Dockerfile`**

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
ENV HF_HOME=/root/.cache/huggingface
EXPOSE 8008
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8008"]
```

Note: `HF_HOME` is Marker/Surya's current model-cache location; verify against `marker-pdf`'s own docs at implementation time if the cache ends up elsewhere, and adjust both this `ENV` and the volume mount in the next step to match.

- [ ] **Step 2: Write `compose.dev.yaml`**

```yaml
services:
  pdf-markdown:
    build: ./services/pdf-markdown
    ports:
      - "${PDF_SERVICE_PORT:-8008}:8008"
    volumes:
      - pdf-markdown-models:/root/.cache/huggingface
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8008/health')"]
      interval: 30s
      timeout: 5s
      retries: 5

volumes:
  pdf-markdown-models:
```

- [ ] **Step 3: Verify the overlay parses**

Run: `docker compose -f compose.yaml -f compose.dev.yaml config --quiet`
Expected: exits 0 with no output

- [ ] **Step 4: Commit**

```bash
git add services/pdf-markdown/Dockerfile compose.dev.yaml
git commit -m "feat: add a Dockerfile and dev compose overlay for pdf-markdown"
```

---

### Task 4: Firecrawl dev bootstrap + `include:` wiring

**Files:**
- Create: `scripts/dev-bootstrap.sh`
- Modify: `compose.dev.yaml` (from Task 3)
- Modify: `.gitignore`
- Modify: `package.json`
- Test: `test/dev-bootstrap.test.mjs`

**Interfaces:**
- Produces: `scripts/dev-bootstrap.sh`, reading `FIRECRAWL_REPO_URL` (default `https://github.com/mendableai/firecrawl.git`), `FIRECRAWL_REPO_TAG` (default `v2.11.162`), `FIRECRAWL_CHECKOUT_DIR` (default `.dev/firecrawl`) from the environment; clones the pinned tag into `FIRECRAWL_CHECKOUT_DIR` if `$FIRECRAWL_CHECKOUT_DIR/.git` doesn't already exist, otherwise prints a line matching `/already present/` and exits 0; always prints a line matching `/FIRECRAWL_BASE_URL/` with the values to add to `.env`. `compose.dev.yaml`'s `include:` reads the same `FIRECRAWL_CHECKOUT_DIR` variable, so running the script and then `docker compose -f compose.yaml -f compose.dev.yaml up` is the whole dev workflow.

- [ ] **Step 1: Write the failing test**

```js
// test/dev-bootstrap.test.mjs
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
```

- [ ] **Step 2: Update the test script to discover this new file**

Modify `package.json`'s `"test"` script from `"node --test test/server.test.mjs"` to `"node --test test/"`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL (`scripts/dev-bootstrap.sh` doesn't exist yet)

- [ ] **Step 4: Implement `scripts/dev-bootstrap.sh`**

```sh
#!/usr/bin/env sh
set -eu

REPO_URL=${FIRECRAWL_REPO_URL:-https://github.com/mendableai/firecrawl.git}
REPO_TAG=${FIRECRAWL_REPO_TAG:-v2.11.162}
CHECKOUT_DIR=${FIRECRAWL_CHECKOUT_DIR:-.dev/firecrawl}

if [ -d "$CHECKOUT_DIR/.git" ]; then
  echo "Firecrawl checkout already present at $CHECKOUT_DIR"
else
  git clone --branch "$REPO_TAG" --depth 1 "$REPO_URL" "$CHECKOUT_DIR"
fi

echo
echo "Add to .env:"
echo "FIRECRAWL_BASE_URL=http://localhost:3002"
echo "PDF_SERVICE_BASE_URL=http://localhost:${PDF_SERVICE_PORT:-8008}"
```

Make it executable: `chmod +x scripts/dev-bootstrap.sh`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Add the `include:` directive to `compose.dev.yaml`**

```yaml
include:
  - path: ${FIRECRAWL_CHECKOUT_DIR:-.dev/firecrawl}/docker-compose.yaml

services:
  pdf-markdown:
    # ...unchanged from Task 3
```

- [ ] **Step 7: Add the checkout directory to `.gitignore`**

Append `.dev/` to `.gitignore`.

- [ ] **Step 8: Verify the full dev overlay resolves once bootstrapped**

Run:
```bash
WORK=$(mktemp -d)
git init --bare "$WORK/fixture.git"
git clone "$WORK/fixture.git" "$WORK/seed"
printf 'services:\n  api:\n    image: scratch\n' > "$WORK/seed/docker-compose.yaml"
git -C "$WORK/seed" add docker-compose.yaml
git -C "$WORK/seed" -c user.email=t@t.co -c user.name=t commit -m seed
git -C "$WORK/seed" tag v0.0.0-test
git -C "$WORK/seed" push origin HEAD:refs/heads/main --tags
FIRECRAWL_REPO_URL="$WORK/fixture.git" FIRECRAWL_REPO_TAG=v0.0.0-test FIRECRAWL_CHECKOUT_DIR="$WORK/checkout" scripts/dev-bootstrap.sh
FIRECRAWL_CHECKOUT_DIR="$WORK/checkout" docker compose -f compose.yaml -f compose.dev.yaml config --quiet
rm -rf "$WORK"
```
Expected: the `docker compose ... config --quiet` line exits 0 with no output

- [ ] **Step 9: Commit**

```bash
git add scripts/dev-bootstrap.sh compose.dev.yaml .gitignore package.json test/dev-bootstrap.test.mjs
git commit -m "feat: bootstrap a local Firecrawl checkout into the dev compose overlay"
```

---

### Task 5: `server.mjs` — PDF service integration

**Files:**
- Modify: `server.mjs` (config block at lines 14–22; `capturePdf` at line 105)
- Modify: `test/server.test.mjs`
- Create: `test/pdf-routing.test.mjs`

**Interfaces:**
- Consumes: existing `config`, `itemDir(id)`, `writeFile`, `pdfToMarkdown(data, title)`, `inferPdfTitle(fileName, data)` (all pre-existing in `server.mjs`); the PDF service's `POST /convert` contract from Task 2 (`{markdown: string, images: Record<string,string>}`).
- Produces: `config.pdfServiceBaseUrl: URL | null`, `config.pdfServiceTimeoutMs: number`; `pdfServiceConvert(data: Buffer): Promise<{markdown: string, images: Record<string,string>}>`; `isConnectionError(error: unknown): boolean` (exported); `writeImages(dir: string, images: Record<string,string>): Promise<void>`; `capturePdf(fileName, data, id)` now returns `{title, dir, contentPath, originalPath, markdown, parser, contentType, originalMime, kind: 'pdf'}` where `parser` is `'pdf-markdown-service'` or `'pdfjs-text-layer'`. Task 6 calls this same `capturePdf` for PDF-via-URL.

- [ ] **Step 1: Add config and a module-entrypoint guard**

In the `config` object (server.mjs:14-22), add:
```js
pdfServiceBaseUrl: optionalUrl(process.env.PDF_SERVICE_BASE_URL),
pdfServiceTimeoutMs: boundedInteger(process.env.PDF_SERVICE_TIMEOUT_MS, 60_000, 1_000, 300_000),
```
At the bottom of the file, guard the existing `server.listen(...)` call so importing `server.mjs` as a module (for unit tests) doesn't bind a port, while running it directly (`node server.mjs`, and the existing child-process-spawned integration tests) is unaffected:
```js
import { pathToFileURL } from 'node:url';
// ...
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  server.listen(process.env.PORT || 4173, () => console.log(`Commonplace listening on http://localhost:${process.env.PORT || 4173}`));
}
```

- [ ] **Step 2: Write the failing unit test for `isConnectionError`**

```js
// test/pdf-routing.test.mjs
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/pdf-routing.test.mjs`
Expected: FAIL (`isConnectionError` is not exported)

- [ ] **Step 4: Implement `isConnectionError`, `pdfServiceConvert`, and `writeImages` in `server.mjs`**

```js
function isConnectionError(error) { return error instanceof TypeError && ['ECONNREFUSED','ENOTFOUND','EAI_AGAIN'].includes(error.cause?.code); }

async function pdfServiceConvert(data) {
  const endpoint = new URL('/convert', config.pdfServiceBaseUrl);
  const form = new FormData();
  form.append('file', new Blob([data], { type: 'application/pdf' }), 'document.pdf');
  const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(config.pdfServiceTimeoutMs), body: form });
  if (!response.ok) throw Error(`PDF service returned ${response.status}.`);
  const result = await response.json();
  if (typeof result.markdown !== 'string' || !result.markdown.trim()) throw Error('PDF service returned no Markdown.');
  return result;
}

async function writeImages(dir, images) {
  for (const [name, encoded] of Object.entries(images || {})) {
    await writeFile(join(dir, 'assets', basename(name)), Buffer.from(encoded, 'base64'));
  }
}
```
Add `export { isConnectionError };` at the end of the file (alongside the entrypoint guard from Step 1).

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/pdf-routing.test.mjs`
Expected: PASS

- [ ] **Step 6: Rewrite `capturePdf` to prefer the PDF service**

```js
async function capturePdf(fileName, data, id) {
  const title = inferPdfTitle(fileName, data);
  const dir = await itemDir(id);
  const original = join(dir, 'original.pdf');
  const contentPath = join(dir, 'content.md');
  await writeFile(original, data);
  let markdown, parser, images = {};
  if (config.pdfServiceBaseUrl) {
    try {
      const result = await pdfServiceConvert(data);
      markdown = result.markdown; images = result.images || {}; parser = 'pdf-markdown-service';
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      console.warn(`PDF service unreachable: ${error.message}`);
    }
  }
  if (!markdown) { markdown = await pdfToMarkdown(data, title); parser = 'pdfjs-text-layer'; }
  await writeFile(contentPath, markdown);
  await writeImages(dir, images);
  return { title, dir, contentPath, originalPath: original, markdown, parser, contentType: 'application/pdf', originalMime: 'application/pdf', kind: 'pdf' };
}
```

- [ ] **Step 7: Write the failing integration tests**

In `test/server.test.mjs`'s `before()`, add a programmable mock PDF-markdown server and two more spawned Commonplace instances:

```js
const pdfServicePort = 4192;
const pdfOkPort = 4193;
const pdfUnreachablePort = 4195;
let pdfMarkdown, pdfOk, pdfUnreachable;
const pdfOkDataDir = await mkdtemp(join(tmpdir(), 'commonplace-test-'));
const pdfUnreachableDataDir = await mkdtemp(join(tmpdir(), 'commonplace-test-'));

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
```

(Generalize `waitForServer` to take a port parameter instead of the hardcoded `port` constant it uses today.) Extend the `after()` to kill/close these and remove their temp dirs. Then add:

```js
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
```

- [ ] **Step 8: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (`capturePdf` doesn't call the service yet)

- [ ] **Step 9: Confirm Step 6's `capturePdf` rewrite makes them pass**

Run: `npm test`
Expected: PASS (all tests in `test/server.test.mjs` and `test/pdf-routing.test.mjs`)

- [ ] **Step 10: Commit**

```bash
git add server.mjs test/server.test.mjs test/pdf-routing.test.mjs
git commit -m "feat: prefer the PDF-markdown service, fall back only when it's unreachable"
```

---

### Task 6: `server.mjs` — PDF-via-URL routing

**Files:**
- Modify: `server.mjs` (`boundedFetch` at line 56; `captureUrl` at lines 93–104; the `UPDATE items` statement in the POST handler)
- Modify: `test/server.test.mjs`
- Modify: `test/pdf-routing.test.mjs`

**Interfaces:**
- Consumes: `capturePdf(fileName, data, id)` (Task 5); existing `safeRemoteUrl`, `boundedFetch`, `firecrawlCapture`, `browserHtml`, `htmlToMarkdown`, `fallbackUrlTitle`.
- Produces: `looksLikePdfUrl(url: URL): boolean` and `pdfFileNameFromUrl(url: URL): string` (exported alongside `isConnectionError`); `boundedFetch(url, accept, maxBytes = config.captureMaxBytes)` (new third parameter, backward compatible); `captureUrl`'s returned object and the `items.kind` column are now correct for both article and PDF URLs.

- [ ] **Step 1: Write the failing unit tests**

```js
// test/pdf-routing.test.mjs (append)
const { looksLikePdfUrl, pdfFileNameFromUrl } = await import('../server.mjs');

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/pdf-routing.test.mjs`
Expected: FAIL (not exported/defined)

- [ ] **Step 3: Implement `looksLikePdfUrl` and `pdfFileNameFromUrl` in `server.mjs`, and export them**

```js
function looksLikePdfUrl(url) { return /\.pdf$/i.test(url.pathname); }
function pdfFileNameFromUrl(url) { const leaf = decodeURIComponent(basename(url.pathname) || '') || 'reading.pdf'; return /\.pdf$/i.test(leaf) ? leaf : `${leaf}.pdf`; }
```
Add both to the `export { ... }` statement from Task 5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pdf-routing.test.mjs`
Expected: PASS

- [ ] **Step 5: Add the `maxBytes` parameter to `boundedFetch`**

Change the signature at server.mjs:56 from `async function boundedFetch(url, accept)` to `async function boundedFetch(url, accept, maxBytes = config.captureMaxBytes)`, and replace both internal uses of `config.captureMaxBytes` with `maxBytes`.

- [ ] **Step 6: Rewrite `captureUrl`**

```js
async function captureUrl(sourceUrl, id) {
  const url=await safeRemoteUrl(sourceUrl);
  if (looksLikePdfUrl(url)) { const {data}=await boundedFetch(url,'application/pdf',config.uploadMaxBytes); return await capturePdf(pdfFileNameFromUrl(url),data,id); }
  let captured;
  if (config.firecrawlBaseUrl) { try { captured = await firecrawlCapture(url.href); } catch (error) { console.warn(`Self-hosted Firecrawl unavailable: ${error.message}`); } }
  if (!captured) {
    let html;
    try {
      const {response,data}=await boundedFetch(url,'text/html,application/pdf;q=0.9,application/xhtml+xml',config.uploadMaxBytes);
      const contentType=response.headers.get('content-type')||'';
      if (contentType.includes('application/pdf') || data.subarray(0,5).toString('latin1')==='%PDF-') return await capturePdf(pdfFileNameFromUrl(url),data,id);
      if (!contentType.includes('text/html')) throw Error('The URL did not return an HTML page.');
      html=data.toString('utf8');
    } catch (error) { html = await browserHtml(url); if (!html) throw error; }
    const local = htmlToMarkdown(html,url.href,fallbackUrlTitle(sourceUrl)); captured={title:local.title,markdown:local.markdown,html,contentType:'text/html',parser:'readability'};
  }
  const dir=await itemDir(id); const originalPath=join(dir, captured.html ? 'source.html' : 'source-url.txt');
  await writeFile(originalPath, captured.html || `${url.href}\n`); const contentPath=join(dir,'content.md'); await writeFile(contentPath,captured.markdown);
  return {title:captured.title,dir,contentPath,originalPath,markdown:captured.markdown,parser:captured.parser || 'self-hosted-firecrawl',contentType:captured.contentType,originalMime:captured.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', kind:'article'};
}
```

- [ ] **Step 7: Thread `kind` through the POST handler's UPDATE**

Change the `UPDATE items SET ...` statement in the `POST /api/items` handler to add `kind=?` (after `source_content_type=?`, before `updated_at=...`), and pass `captured.kind` in the matching position of the `.run(...)` call.

- [ ] **Step 8: Write the failing integration test**

In `test/server.test.mjs`, add a counter to the existing Firecrawl mock handler (`let firecrawlRequests = 0;`, incremented at the top of the handler), then:

```js
test('skips Firecrawl for a PDF-looking URL and fails closed without a reachable PDF host', async () => {
  const before = firecrawlRequests;
  const response = await fetch(`http://127.0.0.1:${port}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceUrl: 'https://example.com/does-not-exist.pdf' }) });
  assert.equal(response.status, 400);
  assert.equal(firecrawlRequests, before);
});
```

- [ ] **Step 9: Run tests to verify the new one fails and the rest still pass**

Run: `npm test`
Expected: the new test FAILs until Step 6 is in place; all pre-existing tests (including "captures a URL through a deterministic self-hosted Firecrawl fixture") still PASS unchanged, since `https://example.com/` doesn't end in `.pdf`

- [ ] **Step 10: Run full suite to verify everything passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add server.mjs test/server.test.mjs test/pdf-routing.test.mjs
git commit -m "feat: route PDF-looking URLs to the PDF service instead of Firecrawl"
```

---

### Task 7: Cleanup and docs

**Files:**
- Delete: `scripts/marker-convert.sh`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing new — this task only removes the superseded manual script and documents the env vars and dev workflow Tasks 1–6 introduced.

- [ ] **Step 1: Remove the superseded manual script**

```bash
git rm scripts/marker-convert.sh
```

- [ ] **Step 2: Add the new variables to `.env.example`**

```
# Local dev dependency overlay (compose.dev.yaml) — see scripts/dev-bootstrap.sh
FIRECRAWL_REPO_URL=https://github.com/mendableai/firecrawl.git
FIRECRAWL_REPO_TAG=v2.11.162
FIRECRAWL_CHECKOUT_DIR=.dev/firecrawl
PDF_SERVICE_PORT=8008

# PDF-to-Markdown service (services/pdf-markdown). Leave blank to use the
# lightweight built-in PDF.js text-layer fallback.
PDF_SERVICE_BASE_URL=
PDF_SERVICE_TIMEOUT_MS=60000
```

- [ ] **Step 3: Update `README.md`**

Replace the `scripts/marker-convert.sh` paragraph in the "POC flows" section with a description of the `services/pdf-markdown` service and PDF-via-URL support, and add a short "Local dev dependencies" section under "Containers and LXC" describing: `scripts/dev-bootstrap.sh` once, then `docker compose -f compose.yaml -f compose.dev.yaml up -d`; and that `compose.yaml` alone (no `-f compose.dev.yaml`) is what ships to production, pointing `FIRECRAWL_BASE_URL`/`PDF_SERVICE_BASE_URL` at wherever those services actually run.

- [ ] **Step 4: Run the full test suite one more time**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md
git commit -am "docs: describe the pdf-markdown service and the dev compose overlay"
```
