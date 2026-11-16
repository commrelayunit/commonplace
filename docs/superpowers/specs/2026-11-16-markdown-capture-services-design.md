# Design: a consistent dev-dependency overlay + a real PDF-to-Markdown service

## Intent and why

Commonplace already prefers a self-hosted Firecrawl endpoint for URL capture
(`FIRECRAWL_BASE_URL`) and already writes a consistent `content.md` +
original artifact for every item, so reading progress is meaningful either
way. Two things are still thin:

- There is no actual Firecrawl instance to point at locally. Production will
  eventually run Firecrawl on its own VM and just set the URL, but there is
  nothing for local development today.
- PDF conversion only handles *uploaded* files, through a weak built-in
  PDF.js text-layer extractor. A higher-fidelity path exists only as a manual,
  unwired shell script (`scripts/marker-convert.sh`) that a human has to run
  by hand, and there is no path at all for "here's a URL to a PDF."

The goal is consistent, good-quality Markdown for everything that lands on
the shelf, captured the same way regardless of whether it arrived as a URL,
an upload, or a PDF URL, so reading progress tracking stays meaningful.

## Goals

- One consistent shape for every capture dependency (Firecrawl, the PDF
  service, and anything added later): Commonplace only ever talks to a URL
  from `.env`, and every local dependency is started the same way, through
  one dev-only compose overlay — not "one lives in our compose, the other is
  a side script."
- A one-command way to run Firecrawl locally for development, without
  changing how production will point at a separate Firecrawl VM.
- A real local PDF-to-Markdown service (HTTP API, wrapping Marker) that both
  uploaded PDFs and PDF-via-URL route through, used as the primary converter.
- Keep the existing `content.md` (+ `assets/`) + original-artifact contract
  unchanged, so the reader and reading-progress code don't need to change.
- The existing "prefer a good service, fall back to a bounded local parser"
  shape (already used for Firecrawl → Readability) is reused for PDFs too.

## Non-goals

- Deploying or managing Firecrawl in production — still bring-your-own
  instance via `FIRECRAWL_BASE_URL`, unchanged.
- Vendoring Firecrawl's (AGPL-3.0) source into this repo.
- OCR quality tuning, GPU acceleration, request queueing/batching, or
  multi-tenant auth on the PDF service — one local user, synchronous
  request/response is enough.
- Changing the existing HTML/article capture path beyond detecting that a
  given URL is actually a PDF before running it.

## Anti-goals

(Things that would make this a failure even if it technically runs.)

- Silently falling back to the weak PDF.js extractor when the Marker service
  is reachable but failing/slow — failures should surface, not quietly
  regress quality.
- A PDF-via-URL path that bypasses the existing SSRF protections
  (`safeRemoteUrl` / `boundedFetch`) — any fetch of a user-supplied URL must
  go through the same private-address/timeout/size checks HTML capture
  already uses.
- Baking Firecrawl's own stack into `compose.yaml` — the file that actually
  ships to production — that reopens a boundary the project already
  decided against (see README: "it deliberately contains ... no hosted
  capture APIs" / "Neither mode deploys or configures Firecrawl").
- Two different mental models for "a local dependency" (one service wired
  into our own compose, another started by a bespoke shell script) —
  defeats the point of this redesign, which is a single, predictable way
  to bring up every dev dependency.

## Constraints

- `server.mjs` is the only code allowed to fetch arbitrary user-supplied
  URLs (it already has the SSRF-safe primitives); the new PDF service must
  never be asked to fetch a URL itself.
- Marker needs Python 3.10+, PyTorch, and downloads/caches several GB of
  models on first run — needs a named volume so the cache survives
  container restarts, and the Node→service call needs a generous timeout
  (conversions are not instant on CPU).
- Firecrawl's self-hosted stack is five services (api, playwright-service,
  redis, rabbitmq, postgres) built from a full checked-out source tree, and
  is AGPL-3.0 — not something to copy into this repo's compose.yaml.
- The Compose spec's top-level `include:` directive can pull another
  compose file's services into the current project at `docker compose`
  time without copying its contents in — this is what lets a cloned,
  gitignored Firecrawl checkout join Commonplace's dev overlay as "just
  another dependency" instead of a separately-run stack.

## Approaches considered

### Shape of the local-dependency setup, overall

- **A. Embed every dependency directly in `compose.yaml`**, gated by
  profiles. Rejected — pulls Firecrawl's 5-service AGPL-3.0 stack (built
  from a full source checkout) into the same file that ships to
  production; a profile flag isn't a strong enough wall for that.
- **B. Mix and match**: the PDF service lives in `compose.yaml` behind a
  profile, Firecrawl is brought up by a separate shell script running its
  own `docker compose up` in a different directory. This was the original
  plan. Rejected on reflection — two different mechanisms for "a local
  dependency" is exactly the inconsistency this redesign is meant to
  remove, even though each piece works.
- **C. One dev-only compose overlay (`compose.dev.yaml`) lists every local
  dependency — our own `pdf-markdown` service plus Firecrawl's stack
  pulled in via Compose's `include:` directive from a cloned, gitignored
  checkout.** — **Picked.** `compose.yaml` stays exactly what ships to
  production (just `commonplace`, reading URLs from `.env`); one command,
  `docker compose -f compose.yaml -f compose.dev.yaml up`, brings up every
  dev dependency the same way. A tiny bootstrap step clones the pinned
  Firecrawl tag if it isn't present yet, then `include:` does the rest —
  Firecrawl's source still never enters this repo.

### PDF-to-Markdown

- **A. Shell out to a third-party Marker Docker image/wrapper** (community
  images like `marker-api`). Rejected — unofficial, inconsistently
  maintained, and their HTTP contracts vary release to release.
- **B. Write a small FastAPI service of our own around the official
  `marker-pdf` Python package** (`PdfConverter` + `create_model_dict()`),
  in a Dockerfile we own. — **Picked.** Matches the engine/packaging you
  chose while keeping the HTTP contract under our control: one
  `POST /convert` taking a PDF file, returning
  `{ markdown, images: {filename: base64} }`.
- **Should the PDF service fetch URLs itself, or should Node fetch and hand
  it bytes?** — **Picked: Node always fetches** (reusing the existing
  `safeRemoteUrl`/`boundedFetch` SSRF-safe path) and POSTs the bytes to the
  PDF service exactly like an upload. The service only ever sees local
  bytes: one code path for "uploaded PDF" and "PDF via URL" alike, and no
  new SSRF surface in Python.

## What's being built

1. **`compose.yaml`** stays production-only: just the `commonplace`
   service, reading every dependency URL from `.env`. No profiles, no
   dependency services added here — this is the file that ships.
2. **`services/pdf-markdown/`** — new FastAPI app + Dockerfile wrapping
   `marker-pdf`. `POST /convert` accepts a multipart `file`, returns JSON
   `{ markdown, images }`. Defined only in `compose.dev.yaml` (below), with
   a named volume for Marker's model cache.
3. **`compose.dev.yaml`** — the dev-only overlay. Defines the `pdf-markdown`
   service directly, and uses the Compose `include:` directive to pull in
   a Firecrawl checkout's own `docker-compose.yaml` (path supplied via a
   variable, e.g. `${FIRECRAWL_CHECKOUT_DIR}`, defaulting to a gitignored
   sibling directory). Run as
   `docker compose -f compose.yaml -f compose.dev.yaml up -d`.
4. **`scripts/dev-bootstrap.sh`** — the one setup step before that command
   works the first time: clones `mendableai/firecrawl` at a pinned tag into
   the gitignored sibling directory if it isn't already there. (No
   `docker compose up` in this script anymore — that's `compose.dev.yaml`'s
   job now, via `include:`.) Prints the `FIRECRAWL_BASE_URL` /
   `PDF_SERVICE_BASE_URL` to put in `.env`.
5. **`server.mjs` capture flow:**
   - New `PDF_SERVICE_BASE_URL` / `PDF_SERVICE_TIMEOUT_MS` config, same
     pattern as the existing Firecrawl config.
   - `capturePdf()` tries the PDF service first (POST the bytes, write the
     returned markdown + decoded images into `assets/`), falling back to
     the existing PDF.js text-layer extraction when the service is unset or
     unreachable — the same "prefer the service, bounded local fallback"
     shape Firecrawl/Readability already uses.
   - URL intake gains PDF detection: after the existing `safeRemoteUrl`
     check, a bounded fetch inspects content-type/magic bytes; if it's a
     PDF, the bytes are routed through the same `capturePdf()` path instead
     of the HTML/Firecrawl path.
   - `scripts/marker-convert.sh` (the old manual CLI adapter) is removed —
     superseded by the service.
6. **`.env.example` / `README.md`** updated for the new vars/files and the
   removed manual script, keeping the existing "Commonplace never deploys
   Firecrawl itself in production" language intact — `compose.dev.yaml` is
   explicitly dev-only tooling, never part of the deployed image.
7. **Tests:** extend `test/server.test.mjs` to cover PDF-via-URL
   detection/routing and the PDF-service-down fallback, with the PDF
   service mocked — no real Marker/network calls in CI.

## Resolved during review

- **Unreachable vs. failing, precisely.** "Unreachable" (silently falls back
  to PDF.js, matching the Firecrawl/Readability pattern) means
  `PDF_SERVICE_BASE_URL` is unset, or the request fails to connect at all
  (connection refused / DNS failure). Any other outcome — an HTTP error
  status, a timeout, or a malformed response — counts as "failing," is not
  swallowed, and surfaces as a capture error on the item instead of
  silently degrading to the weak extractor.
- **Byte cap for a PDF fetched via URL.** Reuses `UPLOAD_MAX_BYTES` (today's
  25MB default for uploaded PDFs), not `CAPTURE_MAX_BYTES` (8MB, sized for
  HTML pages) — a PDF via URL is the same artifact type as an uploaded PDF,
  so it gets the same ceiling.
- **Firecrawl API keys.** Confirmed: self-hosted Firecrawl's plain
  `formats: ['markdown']` scrape (what Commonplace already calls) needs no
  OpenAI/LLM key — that's only required for the JSON/`extract` format and
  summaries, which Commonplace doesn't use. The dev overlay stays a true
  no-cloud-dependency setup.
- **Title for a Marker-converted PDF.** Keeps using the existing
  `inferPdfTitle()` (filename / PDF `/Title` metadata), independent of
  whatever heading Marker's markdown body starts with — same as today,
  avoids a duplicated heading in the reader.

## Left to the builder

- Exact FastAPI route/error-handling code, image-naming scheme, and Marker
  conversion options (forced OCR, language hints).
- Exact content-type/magic-byte sniffing logic for detecting a PDF URL.
- Dockerfile base image choice (CPU-only PyTorch) and the named volume
  name/mount path for the model cache.
- Request/connect timeout values for the PDF service call (should be
  generous — conversions are slow on CPU).
- Exact pinned Firecrawl tag/version, the gitignored checkout directory
  name/location, and the `${FIRECRAWL_CHECKOUT_DIR}`-style variable
  wiring for `include:` in `compose.dev.yaml`.
- Whether `scripts/dev-bootstrap.sh` also updates `.env` directly or just
  prints what to add.
