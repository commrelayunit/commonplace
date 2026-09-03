# Commonplace

A local-first, private reading-list POC: a warm shelf for links, local PDFs, text, notes, optional tags, and a saved place. It deliberately contains no accounts, sharing, club features, highlights, export, cloud services, or deployment configuration.

## Run locally

Requires Node 22.5+ (this POC uses Node's built-in `node:sqlite` module).

```sh
npm start
# open http://localhost:4173
```

`npm run dev` restarts the server while editing. `npm run check` syntax-checks the local server and browser script.

All data lives in `data/commonplace.sqlite`, created empty on first start. The SQLite schema is tracked in `db/schema.sql`; it contains items, tags/item-tags, notes, and per-item reading progress. Earlier template records are removed automatically; existing non-template items are preserved.

## POC flows

- Add either a public URL or a local PDF through **add to shelf**. URL titles use page metadata when a short, safe local fetch succeeds, then fall back to hostname/path. PDF titles use embedded metadata when present, otherwise the filename.
- Open an item on its own `/read/:id` route. PDFs hand off to the browser's normal full-page PDF reader, directly from SQLite.
- Text and pasted content render in the reading surface; local PDFs are served directly from SQLite.
- Add notes in the margin. Scroll position and progress are written to SQLite locally.

This is intentionally a compact POC, not a hardened archival reader. URL ingestion stores a private pointer rather than third-party page content. Browser-native PDF reading does not expose a reliable local progress hook, so PDF position is not currently recorded.
