# Product Scraper

A web dashboard for extracting products from any e-commerce site and downloading them as JSON.

**Live app:** https://product-scraper-production-c8f8.up.railway.app

## What it does

Paste one or more category/listing URLs, configure options, hit **Start Scraping**, and download the results as a JSON file. Supports both plain HTTP fetching and full Playwright browser mode for JS-heavy sites.

Product detection pipeline (first match wins):
1. Embedded JSON (`__NEXT_DATA__`, `__PRELOADED_STATE__`, `window.__STATE__`, etc.)
2. JSON-LD (`<script type="application/ld+json">`)
3. Microdata (`itemtype="schema.org/Product"`)
4. Heuristic HTML (common product-card / product-tile class patterns)
5. Open Graph tags (single-product PDP fallback)

## Files

| File | Purpose |
|------|---------|
| `scraper-server.mjs` | HTTP server + web dashboard UI (runs on port 4321 locally, or `$PORT` on Railway) |
| `scrape.mjs` | Core scraping logic, spawned as a child process per job |
| `package.json` | Dependencies (`playwright`) and `start` script |
| `Dockerfile` | Uses the official Playwright image so Chromium has all system libs on Railway |

## Running locally

```bash
node scraper-server.mjs
# open http://localhost:4321
```

Optional flags:
```bash
node scraper-server.mjs --port 8080
```

One-time Playwright setup (for browser mode):
```bash
npm install
npx playwright install chromium
```

## CLI usage (scrape.mjs directly)

```bash
node scrape.mjs --urls "https://www.example.com/category"
node scrape.mjs --urls "https://www.asda.com/groceries/bakery/bread" --browser
node scrape.mjs --urls "https://site.com/cat/a,https://site.com/cat/b" --limit 50
node scrape.mjs --config nto --out catalog.json
```

| Flag | Default | Description |
|------|---------|-------------|
| `--urls` | — | Comma-separated category URLs |
| `--config` | — | Named preset (`nto`) |
| `--out` | `products.json` | Output file path |
| `--limit` | `20` | Max products per URL |
| `--browser` | off | Use Playwright/Chromium (needed for ASDA, AllSaints, Tesco, etc.) |
| `--no-pdp` | off | Skip individual product page enrichment (faster) |
| `--delay` | `300` | Delay between requests in ms |

## Presets

| Preset | URLs | Browser required |
|--------|------|-----------------|
| `asda` | 21 ASDA grocery categories | Yes |
| `nto` | 10 NTO SFCC storefront categories | No |

## Deployment (Railway)

The app is deployed on [Railway](https://railway.app) from the `sachssp1/product-scraper` GitHub repo.

- Railway auto-deploys on every push to `main`
- The `Dockerfile` uses `mcr.microsoft.com/playwright:latest` so Chromium works out of the box
- `PORT` env var is injected by Railway automatically

> Note: sites with advanced bot protection (Selfridges, ASOS, John Lewis) cannot be scraped by any automated tool, even with Playwright.
