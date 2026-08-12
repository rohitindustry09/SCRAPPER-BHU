/* Shared API + formatting helpers used by every page. */

const BhunesAPI = (() => {
  async function health() {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('Health check failed');
    return res.json();
  }

  async function search(sku, { noCache = false, site } = {}) {
    const params = new URLSearchParams();
    if (noCache) params.set('noCache', '1');
    if (site) params.set('site', site);
    const qs = params.toString();
    const res = await fetch(`/api/search/${encodeURIComponent(sku)}${qs ? `?${qs}` : ''}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Search failed');
    return data;
  }

  async function batch({ skus, concurrency, delayMs, noCache, site }) {
    const res = await fetch('/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus, concurrency, delayMs, noCache, site }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Batch check failed');
    return data;
  }

  /**
   * Runs a batch by hitting the single-SKU endpoint once per SKU from a
   * client-side worker pool, invoking `onResult` the instant each one
   * lands so the UI can render results live instead of waiting for a
   * whole chunk (or the whole run) to come back.
   *
   * Total work is identical to POST /api/batch — that endpoint also
   * runs one searchBySku per SKU internally — but driving the pool
   * from the browser buys two things a batched request can't: results
   * stream in one at a time, and a dropped/failed request costs
   * exactly one SKU instead of the 20-60 that a chunk would take with
   * it. (The older chunked path existed to keep any single HTTP
   * request short enough not to get reset by an idle proxy; per-SKU
   * requests are shorter still, so that concern is covered too.)
   */
  async function batchStreamed(skus, options = {}, { concurrency = 3, delayMs = 350, onResult } = {}) {
    const { noCache = false, site } = options;
    const results = new Array(skus.length);
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
      while (true) {
        const i = nextIndex++;
        if (i >= skus.length) return;
        const sku = skus[i];

        let result;
        try {
          const data = await search(sku, { noCache, site });
          result = {
            sku,
            count: data.count,
            source: data.source,
            timingMs: data.timingMs,
            products: data.products,
            error: null,
          };
        } catch (err) {
          result = {
            sku,
            count: 0,
            products: [],
            source: null,
            timingMs: 0,
            error: err.message || 'Search failed',
          };
        }

        results[i] = result;
        completed += 1;
        if (onResult) onResult(result, completed, skus.length);

        // Only the HTML fallback layer is actually rate-limited by
        // Shopify — same reasoning as the server's runBatch, so cache
        // and GraphQL hits don't pay this delay.
        if (delayMs > 0 && result.source === 'html' && completed < skus.length) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    const workerCount = Math.max(1, Math.min(concurrency, skus.length));
    await Promise.all(Array.from({ length: workerCount }, worker));

    const found = results.filter((r) => r.count > 0).length;
    const notFound = results.filter((r) => r.count === 0 && !r.error).length;
    const errored = results.filter((r) => r.error).length;

    return { results, summary: { total: results.length, found, notFound, errored } };
  }

  async function batchCsv({ skus, noCache, site }) {
    const res = await fetch('/api/batch/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus, noCache, site }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'CSV export failed');
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    return { blob, filename: match ? match[1] : 'bhunes-stock.csv' };
  }

  async function defaultSkus() {
    const res = await fetch('/api/default-skus');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to load default list');
    return data;
  }

  async function storeProductsPage(storeUrl, { cursor = null, limit = 250 } = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const params = new URLSearchParams({ url: storeUrl, limit: String(limit) });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/store-products?${params.toString()}`, { signal: controller.signal });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Store catalog fetch failed');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Walks an entire storefront's catalog page by page, reporting
   * progress as it goes. `cursor` is opaque — just pass back whatever
   * the previous page returned as `nextCursor`; the server encodes
   * which layer (GraphQL vs. REST) it came from so the whole crawl
   * consistently uses one source, decided by page 1's result.
   * maxPages is a hard safety ceiling (default 250/page, so the
   * default caps out at 250k products) — without it a malformed or
   * endlessly paginating response could loop forever.
   *
   * Page size is Shopify's own 250 cap. The server enriches every
   * variant on the page with its exact stock quantity (same cascade
   * as Single Lookup/Batch Check, including the live cart probe last
   * resort) — measured at ~50s for a full 250-product page, which is
   * fine. Smaller pages would mean less work lost if one page's
   * request drops mid-flight, but the server no longer crashes on a
   * failed enrichment either way (it falls back to in-stock/out-of-
   * stock for that page and keeps going), so 250 is the better
   * trade-off: fewer total page round-trips for the same crawl.
   */
  async function crawlStore(storeUrl, { onProgress, maxPages = 1000, pageSize = 250 } = {}) {
    const variants = [];
    let cursor = null;
    let totalProducts = 0;
    let pages = 0;
    let baseUrl = storeUrl;
    let source = null;

    // Generous per-page ceiling: covers worst case of every product on
    // the page needing the full 3-attempt enrichment cascade.
    const timeoutMs = 30000 + pageSize * 8000;

    while (pages < maxPages) {
      const pageData = await storeProductsPage(storeUrl, { cursor, limit: pageSize }, timeoutMs);
      baseUrl = pageData.baseUrl || baseUrl;
      source = pageData.source || source;
      const pageVariants = pageData.variants.map((v) => ({ ...v, source: pageData.source }));
      variants.push(...pageVariants);
      totalProducts += pageData.productCount;
      pages += 1;
      if (onProgress) onProgress({ pages, totalProducts, skusFound: variants.length, baseUrl, source });

      if (!pageData.hasMore) break;
      cursor = pageData.nextCursor;
    }

    return { baseUrl, totalProducts, variants, pages, source };
  }

  return { health, search, batch, batchStreamed, batchCsv, defaultSkus, storeProductsPage, crawlStore };
})();

function bhunesSearchUrl(sku) {
  const params = new URLSearchParams({ 'options[prefix]': 'last', q: sku });
  return `https://bhunes.com/search?${params.toString()}`;
}

const BhunesFmt = (() => {
  function stamp(p) {
    if (typeof p.stockQuantity === 'number') {
      const cls = p.lowStockWarning ? 'stamp-low' : 'stamp-in';
      return `<span class="stamp ${cls}">${p.stockQuantity} left</span>`;
    }
    if (p.inStock === true) return `<span class="stamp stamp-in">In stock</span>`;
    if (p.inStock === false) return `<span class="stamp stamp-out">Out of stock</span>`;
    return `<span class="stamp stamp-unknown">Unknown</span>`;
  }

  function price(p) {
    if (p.price == null) return '<span class="text-faint">&mdash;</span>';
    let html = `Rs. ${p.price.toLocaleString('en-IN')}`;
    if (p.compareAtPrice && p.compareAtPrice > p.price) {
      html += `<span class="price-strike">Rs. ${p.compareAtPrice.toLocaleString('en-IN')}</span>`;
    }
    return html;
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function relativeTime(ts) {
    const diffMs = Date.now() - ts;
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return `${days}d ago`;
  }

  return { stamp, price, escapeHtml, relativeTime, searchUrl: bhunesSearchUrl };
})();

/* Builds the same CSV shape as the server's /api/batch/csv, but from
   results already held in memory — so viewing/exporting a finished
   run never has to re-hit the network (and re-scrape bhunes.com). */
const BhunesCsv = (() => {
  const COLUMNS = [
    'SKU', 'MatchCount', 'MatchIndex', 'ProductTitle', 'Price', 'CompareAtPrice',
    'StockStatus', 'StockQuantity', 'LowStockWarning', 'ProductURL', 'Source',
    'Unverified', 'Status', 'Error', 'Description',
  ];

  function escape(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  function stockStatusLabel(p) {
    if (p.inStock === true) return 'In Stock';
    if (p.inStock === false) return 'Out of Stock';
    return '';
  }

  function buildRows(results) {
    const rows = [COLUMNS];
    for (const r of results) {
      if (r.error) {
        rows.push([r.sku, 0, '', '', '', '', '', '', '', bhunesSearchUrl(r.sku), '', '', 'ERROR', r.error, '']);
        continue;
      }
      if (r.count === 0) {
        rows.push([r.sku, 0, '', '', '', '', '', '', '', bhunesSearchUrl(r.sku), r.source || '', '', 'NOT FOUND', '', '']);
        continue;
      }
      r.products.forEach((p, idx) => {
        rows.push([
          r.sku, r.count, idx + 1, p.title, p.price ?? '', p.compareAtPrice ?? '',
          stockStatusLabel(p), p.stockQuantity ?? '', p.lowStockWarning ? 'YES' : '',
          p.url, r.source || '', p.unverified ? 'YES' : '', 'FOUND', '', p.description ?? '',
        ]);
      });
    }
    return rows;
  }

  function toCsvString(results) {
    return buildRows(results).map((row) => row.map(escape).join(',')).join('\n');
  }

  function download(results, filename) {
    const blob = new Blob([toCsvString(results)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  return { buildRows, toCsvString, download };
})();

/* Small localStorage-backed history log, shared shape across task pages. */
const BhunesHistory = (() => {
  const KEY = 'bhunes.history.v1';
  const MAX = 200;

  function all() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      return [];
    }
  }

  function add(entry) {
    const list = all();
    list.unshift({ ...entry, ts: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
    return list;
  }

  function byType(type) {
    return all().filter((e) => e.type === type);
  }

  function clear(type) {
    if (!type) {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify(all().filter((e) => e.type !== type)));
  }

  return { all, add, byType, clear };
})();

/* Full batch-run payloads (SKUs + every result row), keyed by run id.
   Kept separate from BhunesHistory (which stays small/lightweight)
   because a 794-SKU run's full detail can be a few hundred KB — this
   store only keeps the last few runs so it can't blow the ~5MB
   localStorage quota. */
const BhunesRuns = (() => {
  const KEY = 'bhunes.batchRuns.v1';
  const MAX = 6;

  function all() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      return [];
    }
  }

  function save(run) {
    const list = [run, ...all().filter((r) => r.id !== run.id)].slice(0, MAX);
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      // Quota exceeded on a very large run — fall back to keeping just this one.
      try { localStorage.setItem(KEY, JSON.stringify([run])); } catch { /* give up silently */ }
    }
    return run;
  }

  function get(id) {
    return all().find((r) => r.id === id) || null;
  }

  function latest() {
    return all()[0] || null;
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  return { all, save, get, latest, clear };
})();

/* One-shot handoff of a SKU list between pages — e.g. Scrape Store's
   fast listing-only crawl finds SKUs but never runs the expensive
   enrichment cascade on them; "Check Exact Quantities" hands the
   currently visible SKUs to Batch Check, which does run it, but only
   for the SKUs someone actually asked about instead of the whole
   catalog. Consumed (removed) on read so a stale handoff can't
   silently reappear on a later, unrelated visit to the target page. */
const BhunesHandoff = (() => {
  const KEY = 'bhunes.handoff.v1';

  function send(payload) {
    localStorage.setItem(KEY, JSON.stringify(payload));
  }

  function take() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      localStorage.removeItem(KEY);
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return { send, take };
})();
