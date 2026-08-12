/**
 * bhunes-sku-scraper — Express API
 * -----------------------------------------------------------
 * Thin HTTP wrapper around scraper.js so the exact same scraping
 * logic (cache -> Storefront GraphQL -> predictive search -> HTML
 * fallback) can be called from your website instead of the CLI.
 *
 * scraper.js itself is untouched — this file only requires it and
 * exposes it over HTTP.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/search/:sku          -> single SKU lookup
 *   POST /api/batch                -> multiple SKUs at once
 *   POST /api/batch/csv            -> multiple SKUs, returns a CSV file
 *   GET  /api/store-products       -> one page of a store's full catalog
 *
 * Env vars:
 *   PORT                 - default 3000
 *   ALLOWED_ORIGINS       - comma-separated list of origins allowed to
 *                            call this API (CORS). Defaults to "*".
 *   BHUNES_STOREFRONT_TOKEN, BHUNES_CACHE_TTL_MS - same as scraper.js
 *
 * Run:
 *   npm install
 *   npm start
 *   # or: PORT=4000 node server.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const {
  searchBySku,
  buildSearchUrl,
  fetchCatalogPage,
} = require('./scraper');

const PORT = process.env.PORT || 3000;
const MAX_SKUS_PER_REQUEST = Number(process.env.MAX_SKUS_PER_REQUEST) || 1000;
const MAX_CATALOG_PAGE_LIMIT = 250; // Shopify's own cap on /products.json

// Every route below already wraps its scraper.js calls in try/catch so a
// failed lookup turns into an error response, not a crash. This is the
// backstop for anything that slips past that anyway — a timer callback,
// a promise that got away from an await chain, a bug not yet found. As
// of Node 15+, an unhandled promise rejection kills the whole process by
// default, which means one bad request (out of potentially thousands
// during a long store-scrape run) would take the server down for every
// other user too. Logging and continuing is far safer for a
// long-running HTTP server than letting that happen.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server kept running):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept running):', err);
});

// The .txt file used when the UI's "Use default list" button is clicked.
// Point this at a different file with DEFAULT_SKU_FILE=/path/to/file.txt
const DEFAULT_SKU_FILE = path.isAbsolute(process.env.DEFAULT_SKU_FILE || '')
  ? process.env.DEFAULT_SKU_FILE
  : path.join(__dirname, process.env.DEFAULT_SKU_FILE || 'my-skus.txt');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
  })
);
app.use(express.json({ limit: '2mb' }));

// Serve the frontend (public/index.html) at "/"
app.use(express.static(path.join(__dirname, 'public')));

// Simple request log
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

// ------------------------------------------------------------------
// Default SKU list - powers the "Use default list" button in the UI
//   GET /api/default-skus
// ------------------------------------------------------------------

app.get('/api/default-skus', (req, res) => {
  if (!fs.existsSync(DEFAULT_SKU_FILE)) {
    return res.status(404).json({
      ok: false,
      error: `Default SKU file not found: ${path.basename(DEFAULT_SKU_FILE)}`,
    });
  }

  try {
    const raw = fs.readFileSync(DEFAULT_SKU_FILE, 'utf8');
    const skus = [...new Set(
      raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    )];

    res.json({ ok: true, filename: path.basename(DEFAULT_SKU_FILE), count: skus.length, skus });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------------------------------------------------------------
// Health check
// ------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'bhunes-sku-scraper', time: new Date().toISOString() });
});

// ------------------------------------------------------------------
// Single SKU lookup
//   GET /api/search/BHU438A
//   GET /api/search/BHU438A?verbose=1&noCache=1&skipHtml=1
// ------------------------------------------------------------------

app.get('/api/search/:sku', async (req, res) => {
  const { sku } = req.params;

  if (!sku || !sku.trim()) {
    return res.status(400).json({ ok: false, error: 'SKU is required' });
  }

  const verbose = ['1', 'true'].includes(String(req.query.verbose).toLowerCase());
  const noCache = ['1', 'true'].includes(String(req.query.noCache).toLowerCase());
  const skipHtmlLayer = ['1', 'true'].includes(String(req.query.skipHtml).toLowerCase());
  const site = req.query.site ? String(req.query.site) : undefined;

  try {
    const data = await searchBySku(sku, {
      useCache: !noCache,
      verbose,
      skipHtmlLayer,
      baseUrl: site,
    });

    res.json({
      ok: true,
      query: data.query,
      count: data.count,
      source: data.source,
      timingMs: data.timingMs,
      products: data.products,
      searchedUrl: data.count === 0 ? buildSearchUrl(sku, site) : undefined,
    });
  } catch (err) {
    console.error(`Search failed for "${sku}":`, err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ------------------------------------------------------------------
// Batch lookup (JSON)
//   POST /api/batch
//   body: { "skus": ["BHU438A", "BHU557A"], "concurrency": 3, "delayMs": 350 }
// ------------------------------------------------------------------

async function runBatch(skus, options = {}) {
  const {
    useCache = true,
    verbose = false,
    skipHtmlLayer = false,
    delayMs = 350,
    concurrency = 3,
    baseUrl,
  } = options;

  const results = new Array(skus.length);
  let nextIndex = 0;
  let completed = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= skus.length) return;
      const sku = skus[i];

      let result;
      try {
        const r = await searchBySku(sku, { useCache, verbose, skipHtmlLayer, baseUrl });
        result = { sku, ...r, error: null };
      } catch (err) {
        result = { sku, count: 0, products: [], source: null, timingMs: 0, error: err.message };
      }

      results[i] = result;
      completed++;

      // Shopify only rate-limits the plain HTML search page (429s with
      // a Retry-After header) — the Storefront GraphQL API and the
      // predictive-search JSON endpoint aren't subject to that, per
      // scraper.js's own layering rationale. Throttling *every* result
      // regardless of source was taxing every fast GraphQL/cache hit
      // with the same delay meant to protect against the one slow,
      // rate-limited layer — a large chunk of a batch run's wall time
      // for a typical run where most SKUs resolve via GraphQL.
      if (delayMs > 0 && result.source === 'html' && completed < skus.length) {
        await sleep(delayMs);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, skus.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

function dedupeSkus(list) {
  const seen = new Map();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toUpperCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return [...seen.values()];
}

app.post('/api/batch', async (req, res) => {
  const { skus, concurrency, delayMs, noCache, verbose, skipHtml, site } = req.body || {};

  if (!Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ ok: false, error: '"skus" must be a non-empty array of strings' });
  }
  if (skus.length > MAX_SKUS_PER_REQUEST) {
    return res.status(400).json({ ok: false, error: `Max ${MAX_SKUS_PER_REQUEST} SKUs per request` });
  }

  const cleanSkus = dedupeSkus(skus);

  try {
    const results = await runBatch(cleanSkus, {
      useCache: !noCache,
      verbose: Boolean(verbose),
      skipHtmlLayer: Boolean(skipHtml),
      delayMs: Number.isFinite(Number(delayMs)) ? Number(delayMs) : 350,
      concurrency: Number.isFinite(Number(concurrency)) ? Number(concurrency) : 3,
      baseUrl: site || undefined,
    });

    const found = results.filter((r) => r.count > 0).length;
    const notFound = results.filter((r) => r.count === 0 && !r.error).length;
    const errored = results.filter((r) => r.error).length;

    res.json({
      ok: true,
      summary: { total: results.length, found, notFound, errored },
      results,
    });
  } catch (err) {
    console.error('Batch search failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------------------------------------------------------------
// Batch lookup (CSV download)
//   POST /api/batch/csv
//   body: same as /api/batch
// ------------------------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function stockStatusLabel(p) {
  if (p.inStock === true) return 'In Stock';
  if (p.inStock === false) return 'Out of Stock';
  return '';
}

function buildCsvRows(results, baseUrl) {
  const columns = [
    'SKU',
    'MatchCount',
    'MatchIndex',
    'ProductTitle',
    'Price',
    'CompareAtPrice',
    'StockStatus',
    'StockQuantity',
    'LowStockWarning',
    'ProductURL',
    'Source',
    'Unverified',
    'Status',
    'Error',
    'Description',
  ];

  const rows = [columns];

  for (const r of results) {
    if (r.error) {
      rows.push([r.sku, 0, '', '', '', '', '', '', '', buildSearchUrl(r.sku, baseUrl), '', '', 'ERROR', r.error, '']);
      continue;
    }

    if (r.count === 0) {
      rows.push([r.sku, 0, '', '', '', '', '', '', '', buildSearchUrl(r.sku, baseUrl), r.source || '', '', 'NOT FOUND', '', '']);
      continue;
    }

    r.products.forEach((p, idx) => {
      rows.push([
        r.sku,
        r.count,
        idx + 1,
        p.title,
        p.price ?? '',
        p.compareAtPrice ?? '',
        stockStatusLabel(p),
        p.stockQuantity ?? '',
        p.lowStockWarning ? 'YES' : '',
        p.url,
        r.source || '',
        p.unverified ? 'YES' : '',
        'FOUND',
        '',
        p.description ?? '',
      ]);
    });
  }

  return rows;
}

app.post('/api/batch/csv', async (req, res) => {
  const { skus, concurrency, delayMs, noCache, verbose, skipHtml, site } = req.body || {};

  if (!Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ ok: false, error: '"skus" must be a non-empty array of strings' });
  }
  if (skus.length > MAX_SKUS_PER_REQUEST) {
    return res.status(400).json({ ok: false, error: `Max ${MAX_SKUS_PER_REQUEST} SKUs per request` });
  }

  const cleanSkus = dedupeSkus(skus);

  try {
    const results = await runBatch(cleanSkus, {
      useCache: !noCache,
      verbose: Boolean(verbose),
      skipHtmlLayer: Boolean(skipHtml),
      delayMs: Number.isFinite(Number(delayMs)) ? Number(delayMs) : 350,
      concurrency: Number.isFinite(Number(concurrency)) ? Number(concurrency) : 3,
      baseUrl: site || undefined,
    });

    const rows = buildCsvRows(results, site || undefined);
    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');

    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bhunes-stock-${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Batch CSV export failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------------------------------------------------------------
// Store-wide catalog scrape
//   GET /api/store-products?url=https://bhunes.com&limit=250
//   GET /api/store-products?url=https://bhunes.com&cursor=gql:2026-01:abc123&limit=250
//
// The client drives pagination itself (same pattern as the batch UI's
// chunked requests): it calls this once per page, passing the previous
// response's nextCursor back in verbatim, until hasMore is false.
// `cursor` is opaque to the client — it encodes which layer produced
// it (Storefront GraphQL, which has exact stock counts, or the public
// REST listing, which doesn't) so a whole crawl consistently uses
// whichever layer its first page landed on. Keeping this endpoint
// single-page and stateless means one dropped request only costs a
// retry of that page, not the whole catalog walk.
// ------------------------------------------------------------------

app.get('/api/store-products', async (req, res) => {
  const { url, cursor, limit } = req.query;

  if (!url || !String(url).trim()) {
    return res.status(400).json({ ok: false, error: '"url" query parameter is required' });
  }

  try {
    const result = await fetchCatalogPage(String(url), {
      cursor: cursor || null,
      limit: Math.min(Number(limit) || MAX_CATALOG_PAGE_LIMIT, MAX_CATALOG_PAGE_LIMIT),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`Store catalog fetch failed for "${url}":`, err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ------------------------------------------------------------------
// 404 + error handling
// ------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`bhunes-sku-scraper API listening on port ${PORT}`);
  console.log(`  GET  http://localhost:${PORT}/api/health`);
  console.log(`  GET  http://localhost:${PORT}/api/search/:sku`);
  console.log(`  POST http://localhost:${PORT}/api/batch`);
  console.log(`  POST http://localhost:${PORT}/api/batch/csv`);
  console.log(`  GET  http://localhost:${PORT}/api/store-products`);
});

module.exports = app;
