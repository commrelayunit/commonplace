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
- URL capture prefers the configured self-hosted Firecrawl `/v1/scrape` endpoint and otherwise uses a bounded local HTML + Mozilla Readability fallback (safe DNS resolution, public HTTP(S) only, 8-second timeout, 25 MB response cap — the same combined HTML/PDF probe fetch is used either way, since the URL's actual content can't be known until after it's fetched). Set `CAPTURE_BROWSER_FALLBACK=true` only when Playwright is installed and browser-rendered pages are needed. It never calls Firecrawl Cloud. Asset collection is reserved for the adapter/next pass, so the current fallback does not download arbitrary tracker images.
- PDF conversion goes through the optional `services/pdf-markdown` service when `PDF_SERVICE_BASE_URL` is set. It is a small FastAPI wrapper around locally run Marker that accepts a PDF at `POST /convert` and returns Markdown (plus any extracted images), so complex layouts convert well. Marker's models are downloaded once and cached in the `pdf-markdown-cache` volume; no cloud OCR or API key is involved. If the service is unset or unreachable, capture falls back to PDF.js for a lightweight local text-layer extraction. The original PDF is retained either way. A URL whose path ends in `.pdf` is always routed to this PDF path instead of Firecrawl, verified by checking the fetched bytes start with the PDF magic number rather than trusting the extension alone. A PDF served at a URL that does *not* end in `.pdf` (some `arxiv.org` or DOI-redirect links, for example) is only caught by this path when Firecrawl is unconfigured or fails — with `FIRECRAWL_BASE_URL` set, such a URL still goes to Firecrawl like any other link, a deliberate trade-off that avoids fetching every URL twice and avoids a real-network test dependency when Firecrawl is enabled.
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

### Local dev dependencies

`compose.yaml` on its own is the production stack: only Commonplace. To develop against the PDF service and a self-hosted Firecrawl, layer the dev overlay on top of it. This is a two-step workflow (the overlay includes Firecrawl's compose file, which needs Docker Compose 2.20+):

```sh
scripts/dev-bootstrap.sh    # once: clones Firecrawl at a pinned tag into .dev/firecrawl
docker compose -f compose.yaml -f compose.dev.yaml up -d
```

`compose.dev.yaml` builds `services/pdf-markdown` and publishes it on `PDF_SERVICE_PORT` (default 8008). The bootstrap script prints the `FIRECRAWL_BASE_URL` and `PDF_SERVICE_BASE_URL` lines to add to `.env`, but those `localhost` values are only correct for `npm start` on the host. When Commonplace runs in the container alongside the overlay, use the Compose service name on the shared network instead, such as `http://pdf-markdown:8008`.

Do not use `compose.dev.yaml` in production. Production runs `docker compose up -d --build` with `compose.yaml` alone, which does not start Firecrawl or the PDF service. In that case, set `FIRECRAWL_BASE_URL` and `PDF_SERVICE_BASE_URL` to wherever those services actually run, or leave `PDF_SERVICE_BASE_URL` blank to use the PDF.js fallback.
