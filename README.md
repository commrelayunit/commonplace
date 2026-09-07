# Commonplace

A local-first, private reading-list POC: a quiet shelf for URLs and PDFs, local Markdown, notes, optional tags, and a saved place. It deliberately contains no accounts, sharing, club features, highlights, export, or hosted capture APIs.

## Run locally

Requires Node 22.5+ (this POC uses Node's built-in `node:sqlite` module).

```sh
npm start
# open http://localhost:4173
```

`npm run dev` restarts the server while editing. `npm run check` syntax-checks the local server and browser script. Copy `.env.example` to `.env` to change bounded intake limits or enable an optional self-hosted Firecrawl endpoint.

All data lives in `data/commonplace.sqlite`, created empty on first start. The SQLite schema is tracked in `db/schema.sql`; it tracks items, capture provenance, artifact paths, tags/item-tags, notes, and per-item reading progress. Captured files live in `data/library/<item-id>/`; deleting `data/` resets the POC completely.

## POC flows

- Add either a public URL or a local PDF through **add to shelf**. URL capture writes `source.html` and cleaned `content.md`; PDF capture writes `original.pdf` and a Markdown text-layer conversion. The reader always reads the local Markdown copy, so progress is meaningful for both formats.
- A captured item is arranged as `library/<id>/content.md`, its original (`source.html` or `original.pdf`), and `assets/`. SQLite records parser name/version, content type, capture timestamp, and artifact paths.
- URL capture prefers the configured self-hosted Firecrawl `/v1/scrape` endpoint and otherwise uses a bounded local HTML + Mozilla Readability fallback (safe DNS resolution, public HTTP(S) only, 8-second timeout, 8 MB response cap). Set `CAPTURE_BROWSER_FALLBACK=true` only when Playwright is installed and browser-rendered pages are needed. It never calls Firecrawl Cloud. Asset collection is reserved for the adapter/next pass, so the current fallback does not download arbitrary tracker images.
- PDF conversion uses PDF.js for a lightweight local text-layer extraction, retaining the original either way. For complex layouts, the optional `scripts/marker-convert.sh INPUT.pdf OUTPUT_DIR` adapter invokes locally installed Marker and writes the same `content.md`/`assets/` contract; no cloud OCR, API key, or external model service is required.
- Add notes in the margin. Scroll position and progress are written to SQLite locally. Original PDFs remain accessible from the reader as a reference, but are not the canonical reading surface.

## Recovery and security

The content of a fetched page is untrusted and rendered as escaped local Markdown. The local URL path rejects loopback, private, link-local, CGNAT, and `.local` targets; it does not follow redirects and imposes time/size limits. Keep Firecrawl private, configure the equivalent outbound/private-address blocks in Firecrawl itself, and never point `FIRECRAWL_BASE_URL` at a hosted Firecrawl API.

## Containers and LXC

Docker keeps the data volume separate and binds to loopback by default:

```sh
cp .env.example .env
docker compose up -d --build
```

For a new host or LXC, the installer supports Docker (default) and a Node-only LXC install. Review the script before piping it into a shell:

```sh
curl -fsSL https://raw.githubusercontent.com/commrelayunit/commonplace/main/scripts/install.sh | sh
# or, inside an LXC with Node 22.5+ installed:
curl -fsSL https://raw.githubusercontent.com/commrelayunit/commonplace/main/scripts/install.sh | sh -s -- --mode lxc
```

The LXC path installs dependencies and prepares `data/`; run `npm start` under the container's service manager. Neither mode deploys or configures Firecrawl. Add its private URL to `.env` only after the instance has its own outbound SSRF controls.
