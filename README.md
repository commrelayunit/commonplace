# Commonplace

A local-first, private reading-list POC: a warm shelf for links, local PDFs, text, notes, optional tags, and a saved place. It deliberately contains no accounts, sharing, club features, highlights, export, cloud services, or deployment configuration.

## Run locally

Requires Node 22.5+ (this POC uses Node's built-in `node:sqlite` module).

```sh
npm start
# open http://localhost:4173
```

`npm run dev` restarts the server while editing. `npm run check` syntax-checks the local server and browser script.

All data lives in `data/commonplace.sqlite`, created and seeded on first start. Remove that file to reset the POC. The SQLite schema is tracked in `db/schema.sql`; it contains items, tags/item-tags, notes, and per-item reading progress.

## POC flows

- Add either a public URL or a local PDF through **add to shelf**. URL titles use page metadata when a short, safe local fetch succeeds, then fall back to hostname/path. PDF titles use embedded metadata when present, otherwise the filename.
- Open an item on its own `/read/:id` full-screen reading route.
- Text and pasted content render in the reading surface; local PDFs render directly from SQLite through the local server.
- Add notes in the margin. Scroll position and progress are written to SQLite locally.

This is intentionally a compact POC, not a hardened archival reader. URL ingestion stores a private pointer rather than third-party page content, and PDF progress is currently retained when leaving the dedicated reader (not within the browser's PDF viewer).
