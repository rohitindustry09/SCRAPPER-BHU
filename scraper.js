/**
 * bhunes-sku-scraper
 * -----------------------------------------------------------
 * Searches https://bhunes.com by SKU (e.g. "BHU438A") and returns
 * the matching product(s) with a clean, canonical product page URL.
 *
 * Why this file has multiple lookup strategies:
 * ---------------------------------------------
 * Hitting the plain HTML `/search?q=...` page repeatedly gets you
 * rate-limited by Shopify's bot/traffic protection (HTTP 429 with a
 * Retry-After header, sometimes 60s+). That's a real limit set by
 * Shopify's servers — no amount of client-side retry tuning avoids
 * it, you just have to stop hammering that endpoint.
 *
 * So this scraper tries faster / less-restricted paths first, and
 * only falls back to full HTML scraping (with retry/backoff) as a
 * last resort:
 *
 *   1. Local cache          - instant, no network call at all.
 *   2. Storefront GraphQL API - Shopify's official public JSON API.
 *      Bhunes' own theme embeds a public Storefront API access
 *      token (used client-side for cart/product data), so this is
 *      a legitimate structured query, not scraping, and isn't
 *      subject to the same anti-bot throttling as the search page.
 *   3. Predictive Search JSON (/search/suggest.json) - the same
 *      lightweight endpoint the theme's own search-as-you-type box
 *      uses. Much smaller/faster than the full HTML search page.
 *   4. Full HTML search page scrape - the original approach, kept
 *      as a guaranteed-to-work fallback, with 429/5xx retry+backoff.
 *
 * NOTE: Because this sandbox's outbound network is restricted to
 * package registries, layers 2-4 could not be tested against the
 * *live* bhunes.com from here. Layer 4 was previously confirmed
 * working end-to-end from your machine. Run this with `--verbose`
 * to see which layer actually succeeds for you, and report back if
 * layers 2 or 3 fail so they can be adjusted.
 *
 * Usage:
 *   node scraper.js BHU438A
 *   node scraper.js BHU438A --json
 *   node scraper.js BHU438A --verbose      // show timing + which layer was used
 *   node scraper.js BHU438A --no-cache      // skip cache read (still writes cache)
 *   node scraper.js BHU438A --open
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const dns = require('dns').promises;
const net = require('net');

const BASE_URL = 'https://bhunes.com';

// Public Storefront API token embedded in the site's own theme HTML
// (visible in <script id="shopify-features">). Override via env var
// if it ever rotates.
const STOREFRONT_TOKEN =
  process.env.BHUNES_STOREFRONT_TOKEN || '802b5a20e8afa71bf2b2d3579fdeedf0';

// Storefront API versions to try, newest first, falling back to
// "unstable" (always accepted) if none of the dated ones are valid
// by the time you run this.
const GRAPHQL_VERSIONS_TO_TRY = [
  '2026-01',
  '2025-10',
  '2025-07',
  '2025-04',
  '2025-01',
  '2024-10',
  'unstable',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a request on 429/5xx with exponential backoff, honoring a
 * Retry-After header when the server sends one. The HTML search layer
 * already does this; the newer enrichment layers (product page scrape,
 * live cart probe) originally didn't, or only had a single fixed
 * retry — which meant that once a store started rate-limiting a
 * sustained run (a full store-scrape can fire thousands of enrichment
 * requests), every request after that point just silently failed and
 * fell back to no exact quantity, for the rest of the run. This gives
 * every one of those a real chance to recover once the store's
 * throttling window passes, instead of giving up after one try.
 */
async function requestWithBackoff(makeRequest, { retries = 5, baseDelayMs = 2000 } = {}) {
  let res;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await makeRequest();
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === retries) return res;
    const retryAfterHeader = res.headers?.['retry-after'];
    const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : null;
    const backoffMs = baseDelayMs * 2 ** attempt;
    const jitter = Math.floor(Math.random() * 400);
    await sleep((retryAfterMs || backoffMs) + jitter);
  }
  return res;
}

// ------------------------------------------------------------------
// Local cache (instant repeat lookups, no network call)
// ------------------------------------------------------------------

const CACHE_DIR = path.join(__dirname, '.cache');
// Default 24h — long enough that re-running a batch job shortly after
// (or resuming one) mostly hits cache instead of re-hitting the network.
// Product data doesn't change minute-to-minute, so this is safe. Override
// with BHUNES_CACHE_TTL_MS if you want fresher data more often.
const CACHE_TTL_MS = Number(process.env.BHUNES_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;

// Cache files are namespaced by store domain (not just SKU) so looking
// up the same SKU string against two different stores can't collide.
function domainSlug(baseUrl) {
  try {
    return new URL(baseUrl).hostname.replace(/[^a-z0-9.-]/gi, '_');
  } catch {
    return 'unknown';
  }
}

function cacheFilePath(sku, baseUrl = BASE_URL) {
  const skuSlug = sku.toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, `${domainSlug(baseUrl)}__${skuSlug}.json`);
}

function readCache(sku, baseUrl = BASE_URL) {
  try {
    const file = cacheFilePath(sku, baseUrl);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - raw.cachedAt > CACHE_TTL_MS) return null;
    return raw.products;
  } catch {
    return null;
  }
}

function writeCache(sku, products, baseUrl = BASE_URL) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      cacheFilePath(sku, baseUrl),
      JSON.stringify({ cachedAt: Date.now(), products })
    );
  } catch {
    // Non-fatal — caching is a nice-to-have, not a requirement.
  }
}

// ------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------

function buildSearchUrl(query, baseUrl = BASE_URL) {
  const params = new URLSearchParams({ 'options[prefix]': 'last', q: query });
  return `${baseUrl}/search?${params.toString()}`;
}

function cleanProductUrl(hrefOrUrl, baseUrl = BASE_URL) {
  const full = hrefOrUrl.startsWith('http') ? hrefOrUrl : `${baseUrl}${hrefOrUrl}`;
  const u = new URL(full);
  return `${u.origin}${u.pathname}`;
}

function parsePrice(text) {
  if (!text) return null;
  const noCommas = String(text).replace(/,/g, '');
  const match = noCommas.match(/\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Layers that don't expose a variant SKU directly (predictive search,
 * HTML scrape) can't verify an exact match the way the GraphQL layer
 * can. Both Shopify search backends do fuzzy/full-text matching, so a
 * query for "BHU438A" can return unrelated products that merely share
 * a prefix or partial token — without necessarily including the real
 * match at all.
 *
 * As a heuristic, Bhunes names its product images after the SKU
 * (e.g. "BHU438A-scaled.jpg"), and the SKU sometimes appears in the
 * product URL/handle too. We use that to keep only products we can
 * actually confirm, rather than trusting "search returned something"
 * as proof of a match. If nothing survives this filter, the caller
 * should treat it as no match (and let the next layer take over)
 * rather than showing possibly-wrong products.
 */
function filterByConfirmedSku(products, sku, log) {
  const target = sku.toUpperCase();
  const confirmed = products.filter((p) => {
    if (p.sku && p.sku.toUpperCase() === target) return true;
    if (p.image && p.image.toUpperCase().includes(target)) return true;
    if (p.url && p.url.toUpperCase().includes(target)) return true;
    return false;
  });

  if (confirmed.length < products.length) {
    log(
      `Filtered out ${products.length - confirmed.length} unconfirmed ` +
        `result(s) that didn't verifiably match SKU "${sku}"`
    );
  }

  return confirmed;
}

// ------------------------------------------------------------------
// Layer 2: Storefront GraphQL API (fast, official, not scraping)
// ------------------------------------------------------------------

// `quantityAvailable` only resolves if the merchant has enabled
// "Show inventory quantities" for the Storefront API (Shopify admin
// > Settings > Apps and sales channels, or it may require the
// storefront token to carry the unauthenticated_read_product_inventory
// scope). If the store hasn't exposed it, Shopify returns a top-level
// GraphQL error for that field — we detect that and automatically
// retry the same request with a version of the query that omits it,
// falling back to just the in-stock/out-of-stock boolean.
const PRODUCTS_BY_SKU_QUERY_WITH_INVENTORY = `
  query ProductsBySku($query: String!) {
    products(first: 25, query: $query) {
      edges {
        node {
          title
          description
          handle
          onlineStoreUrl
          featuredImage { url }
          images(first: 8) { edges { node { url } } }
          variants(first: 25) {
            edges {
              node {
                sku
                availableForSale
                quantityAvailable
                price { amount currencyCode }
                compareAtPrice { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

const PRODUCTS_BY_SKU_QUERY_BASIC = `
  query ProductsBySku($query: String!) {
    products(first: 25, query: $query) {
      edges {
        node {
          title
          description
          handle
          onlineStoreUrl
          featuredImage { url }
          images(first: 8) { edges { node { url } } }
          variants(first: 25) {
            edges {
              node {
                sku
                availableForSale
                price { amount currencyCode }
                compareAtPrice { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

async function graphqlRequest(version, query, variables, baseUrl = BASE_URL) {
  const url = `${baseUrl}/api/${version}/graphql.json`;
  return axios.post(
    url,
    { query, variables },
    {
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
      },
      timeout: 8000,
      validateStatus: () => true,
    }
  );
}

function isInventoryFieldError(res) {
  const errors = res?.data?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) =>
    /quantityAvailable/i.test(e.message || '') ||
    /inventory/i.test(e.message || '')
  );
}

// In-memory, per-process cache of whether a store exposes exact
// inventory quantities via the Storefront GraphQL API (a merchant
// opt-in setting). This is a property of the STORE, not any one
// product — once a `quantityAvailable` field error is seen for a
// given baseUrl, every subsequent enrichment call for that store can
// skip straight past the now-guaranteed-useless productByHandle
// attempt instead of re-discovering "not supported" on every single
// product in a batch. That wasted request (roughly doubling network
// calls per SKU) was the single biggest contributor to slow batch runs.
const inventorySupportByStore = new Map();

function markInventoryUnsupported(baseUrl) {
  inventorySupportByStore.set(baseUrl, false);
}

function isInventoryKnownUnsupported(baseUrl) {
  return inventorySupportByStore.get(baseUrl) === false;
}

/**
 * Runs async `fn` over `items` with at most `limit` in flight at once —
 * a plain Promise.all would fire every request simultaneously (risking
 * rate limits), a plain for-loop runs one at a time (slow); this is the
 * middle ground already used by the batch endpoint's worker pool.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Collects every image URL for a GraphQL product node, featured image first. */
function graphqlNodeImages(node) {
  const gallery = (node.images?.edges || []).map((e) => e.node?.url).filter(Boolean);
  const featured = node.featuredImage?.url || null;
  const ordered = featured ? [featured, ...gallery.filter((u) => u !== featured)] : gallery;
  return ordered;
}

function mapGraphQLProducts(data, sku, baseUrl = BASE_URL) {
  const edges = data?.data?.products?.edges || [];
  const products = [];
  const target = sku.toUpperCase();

  for (const { node } of edges) {
    const variantEdges = node.variants?.edges || [];
    const exact = variantEdges.find(
      (v) => v.node.sku && v.node.sku.toUpperCase() === target
    );

    // IMPORTANT: Shopify's `products(query:)` search is fuzzy/full-text,
    // not an exact filter — it can return products that merely mention
    // the SKU-like string somewhere, without any variant actually
    // carrying that SKU. Previously this fell back to the product's
    // first variant regardless, which let unrelated products through
    // (and could push the real match out of a small result window).
    // Skip anything that doesn't have a verified exact variant match.
    if (!exact) continue;
    const variant = exact.node;
    const images = graphqlNodeImages(node);

    products.push({
      title: node.title,
      description: node.description || null,
      sku: variant.sku,
      image: images[0] || null,
      images,
      price: variant.price ? parseFloat(variant.price.amount) : null,
      compareAtPrice: variant.compareAtPrice
        ? parseFloat(variant.compareAtPrice.amount)
        : null,
      inStock:
        typeof variant.availableForSale === 'boolean'
          ? variant.availableForSale
          : null,
      // Exact count, only populated if the store exposes it via the
      // Storefront API. Otherwise stays null — use `inStock` instead.
      stockQuantity:
        typeof variant.quantityAvailable === 'number'
          ? variant.quantityAvailable
          : null,
      url: node.onlineStoreUrl || `${baseUrl}/products/${node.handle}`,
    });
  }

  return products;
}

async function searchBySkuGraphQL(sku, log, baseUrl = BASE_URL) {
  // Try a couple of query-syntax variants since Shopify's supported
  // search filter keys for `products(query:)` have shifted across
  // API versions.
  const queryVariants = [`sku:${sku}`, `variants.sku:${sku}`];

  for (const version of GRAPHQL_VERSIONS_TO_TRY) {
    for (const q of queryVariants) {
      let res = await graphqlRequest(version, PRODUCTS_BY_SKU_QUERY_WITH_INVENTORY, {
        query: q,
      }, baseUrl);

      if (isInventoryFieldError(res)) {
        log(`Store doesn't expose quantityAvailable; retrying without it (version=${version})`);
        markInventoryUnsupported(baseUrl);
        res = await graphqlRequest(version, PRODUCTS_BY_SKU_QUERY_BASIC, { query: q }, baseUrl);
      }

      if (res.status === 200 && res.data && !res.data.errors) {
        const products = mapGraphQLProducts(res.data, sku, baseUrl);
        if (products.length > 0) {
          log(`GraphQL succeeded (version=${version}, query="${q}")`);
          return products;
        }
        // 200 with zero matches — try the other query syntax before
        // giving up on this version.
        continue;
      }

      const bodyStr = JSON.stringify(res.data || {}).slice(0, 300);
      if (res.status === 400 || res.status === 404) {
        // Likely unsupported API version or bad query syntax — move on.
        log(`GraphQL version=${version} query="${q}" rejected: ${bodyStr}`);
        continue;
      }

      // Anything else (auth error, 5xx, etc.) — not worth retrying
      // across every version/query combo, bail out to next layer.
      throw new Error(`GraphQL request failed (status ${res.status}): ${bodyStr}`);
    }
  }

  return []; // no version/query combo returned a match
}

// ------------------------------------------------------------------
// Inventory enrichment: exact productByHandle lookup
// ------------------------------------------------------------------
//
// The `products(query: "sku:...")` fuzzy search above isn't reliable
// for every store/API version — it can return zero matches even when
// the product exists, which silently falls all the way through to the
// slow HTML layer (which has no inventory data at all).
//
// Once *any* layer has found a product (and therefore its URL/handle),
// we can look that exact product up directly via `productByHandle` —
// no search/fuzzy-matching involved, just a direct exact lookup. This
// is fast, precise, and is how we backfill `stockQuantity` even when
// the product was originally found via predictive search or the HTML
// page, neither of which expose inventory at all.

const PRODUCT_BY_HANDLE_QUERY_WITH_INVENTORY = `
  query ProductByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      title
      variants(first: 25) {
        edges {
          node {
            sku
            availableForSale
            quantityAvailable
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
          }
        }
      }
    }
  }
`;

const PRODUCT_BY_HANDLE_QUERY_BASIC = `
  query ProductByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      title
      variants(first: 25) {
        edges {
          node {
            sku
            availableForSale
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
          }
        }
      }
    }
  }
`;

function extractHandleFromUrl(url) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/products\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Exact lookup of a single product's live variant data by handle.
 * Returns null if the product/handle can't be resolved on any tried
 * API version, or the specific SKU's variant can't be found.
 */
async function fetchProductByHandle(handle, sku, log, baseUrl = BASE_URL) {
  // Already know this store's token can't see inventory quantities —
  // skip straight to the basic query instead of paying for a request
  // we already know will come back with a field error.
  const skipInventoryField = isInventoryKnownUnsupported(baseUrl);

  for (const version of GRAPHQL_VERSIONS_TO_TRY) {
    let res = skipInventoryField
      ? await graphqlRequest(version, PRODUCT_BY_HANDLE_QUERY_BASIC, { handle }, baseUrl)
      : await graphqlRequest(version, PRODUCT_BY_HANDLE_QUERY_WITH_INVENTORY, { handle }, baseUrl);

    if (!skipInventoryField && isInventoryFieldError(res)) {
      markInventoryUnsupported(baseUrl);
      res = await graphqlRequest(version, PRODUCT_BY_HANDLE_QUERY_BASIC, { handle }, baseUrl);
    }

    if (res.status === 200 && res.data && !res.data.errors) {
      const node = res.data?.data?.productByHandle;
      if (!node) return null; // valid response, product genuinely not found

      const variantEdges = node.variants?.edges || [];
      const target = sku ? sku.toUpperCase() : null;
      const exact = target
        ? variantEdges.find((v) => v.node.sku && v.node.sku.toUpperCase() === target)
        : null;
      const variant = (exact || variantEdges[0])?.node;
      if (!variant) return null;

      log(`Live inventory fetched via productByHandle (version=${version}, handle="${handle}")`);

      return {
        sku: variant.sku || sku || null,
        inStock:
          typeof variant.availableForSale === 'boolean' ? variant.availableForSale : null,
        stockQuantity:
          typeof variant.quantityAvailable === 'number' ? variant.quantityAvailable : null,
      };
    }

    const bodyStr = JSON.stringify(res.data || {}).slice(0, 300);
    if (res.status === 400 || res.status === 404) {
      // Unsupported version — try the next one.
      continue;
    }
    // Anything else: not worth retrying every remaining version for
    // one enrichment call — just skip enrichment for this product.
    log(`productByHandle failed (status ${res.status}) for handle="${handle}": ${bodyStr}`);
    return null;
  }

  return null;
}

// ------------------------------------------------------------------
// Inventory enrichment: scraping the actual product page
// ------------------------------------------------------------------
//
// Some stores don't expose inventory quantities via the Storefront
// API at all (that's a merchant opt-in setting), which means the
// GraphQL `quantityAvailable` field is permanently unavailable no
// matter which layer finds the product. But the product page itself
// often renders two things that don't require any special API access:
//
//   1. A low-stock warning like "Hurry, Only 2 Left!" — an exact
//      count, but only shown once inventory drops below the theme's
//      configured threshold.
//   2. A standard JSON-LD <script type="application/ld+json"> block
//      with `offers.availability` (InStock/OutOfStock/...) — present
//      on virtually every Shopify product page, and more reliable
//      than guessing from a "Sold Out" CSS badge.

function extractProductJsonLd(html) {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]');

  for (let i = 0; i < scripts.length; i++) {
    try {
      const data = JSON.parse($(scripts[i]).html());
      if (data && (data['@type'] === 'Product' || data.offers)) return data;
    } catch {
      // Malformed/unrelated JSON-LD block — skip it.
    }
  }

  return null;
}

function mapSchemaAvailability(availability) {
  if (!availability) return null;
  if (/InStock|LimitedAvailability|PreOrder/i.test(availability)) return true;
  if (/OutOfStock|SoldOut|Discontinued/i.test(availability)) return false;
  return null;
}

function parseLowStockCount(html) {
  const $ = cheerio.load(html);
  const text = $('.variant__countdown-text').first().text().trim();
  if (!text) return null;
  // Matches "Hurry, Only 2 Left!", "Only 5 left in stock", etc.
  const match = text.match(/(\d+)\s*left/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Fetches the actual product page and extracts whatever stock signal
 * it can: an exact count from the low-stock warning (only present
 * when stock is low), and/or a reliable in-stock boolean from the
 * page's JSON-LD structured data.
 */
async function fetchProductPageStock(url, log) {
  let res;
  try {
    res = await requestWithBackoff(() => axios.get(url, {
      headers: { ...BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml' },
      timeout: 10000,
      validateStatus: () => true,
    }));
  } catch (err) {
    throw new Error(`Product page request failed: ${err.message}`);
  }

  if (res.status !== 200 || !res.data) {
    throw new Error(`Product page fetch failed (status ${res.status})`);
  }

  const html = res.data;
  const jsonLd = extractProductJsonLd(html);
  const stockQuantity = parseLowStockCount(html);
  const inStock = mapSchemaAvailability(jsonLd?.offers?.availability);

  log(
    `Product page scrape: inStock(JSON-LD)=${inStock}, ` +
      `lowStockCount=${stockQuantity}`
  );

  return {
    inStock,
    stockQuantity,
    lowStockWarning: stockQuantity !== null,
  };
}

// ------------------------------------------------------------------
// Inventory enrichment: live cart probe (last resort, most accurate)
// ------------------------------------------------------------------
//
// Neither the Storefront API's quantityAvailable nor the product
// page's low-stock banner tell the whole story: many merchants cap
// purchase quantity via an app (order-limit apps, per-customer caps)
// that only ever gets enforced when Shopify actually validates a real
// cart-add — nothing about that cap is visible in product JSON or
// page HTML. This probes /cart/add.js with a quantity far larger than
// any real cap, reads the true number out of the rejection message,
// then immediately clears the cart.
//
// This is fundamentally different from every other layer in this
// file: it's a genuine write against the live store's cart, not a
// read. Kept fast by doing it with two plain HTTP requests (no
// browser) rather than driving a full headless browser per product.

const CART_PROBE_QTY = Number(process.env.CART_PROBE_QTY) || 9999;

/** The AJAX API's numeric variant IDs (used by /cart/add.js) — distinct from the GraphQL GIDs. */
async function fetchProductAjaxJson(baseUrl, handle) {
  const res = await requestWithBackoff(() => axios.get(`${baseUrl}/products/${handle}.js`, {
    headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
    timeout: 8000,
    validateStatus: () => true,
  }));
  if (res.status !== 200 || !res.data) return null;
  return res.data;
}

function extractCartCookie(setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders)) return '';
  return setCookieHeaders.map((c) => c.split(';')[0]).join('; ');
}

/**
 * Adds CART_PROBE_QTY of one variant to the cart, reads the true cap
 * out of whatever rejection message comes back (native Shopify
 * inventory rejection or a limit app's own message — both tend to
 * embed the actual number, e.g. "Only 12 available", "Limit 3 per
 * order"), then clears the cart regardless of outcome so nothing is
 * left behind.
 */
async function probeCartLimit(baseUrl, variantId, log) {
  let cookie = '';
  try {
    // requestWithBackoff only retries 429/5xx — a genuine inventory/
    // limit-app rejection (the case we actually want) comes back as a
    // different status (usually 422) and passes straight through.
    const addRes = await requestWithBackoff(() => axios.post(
      `${baseUrl}/cart/add.js`,
      { items: [{ id: variantId, quantity: CART_PROBE_QTY }] },
      {
        headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 10000,
        validateStatus: () => true,
      }
    ));
    cookie = extractCartCookie(addRes.headers['set-cookie']);

    let result;
    if (addRes.status >= 200 && addRes.status < 300) {
      // Accepted an absurdly large quantity outright — no cap found
      // below CART_PROBE_QTY. Not a real "quantity available" number,
      // so leave stockQuantity alone rather than reporting a fake one.
      result = { stockQuantity: null, inStock: true };
    } else {
      const body = addRes.data;
      const message = body?.message || body?.description
        || (Array.isArray(body) ? body.join(' ') : '') || '';
      const match = String(message).match(/(\d+)/);
      const limit = match ? parseInt(match[1], 10) : null;
      result = { stockQuantity: limit, inStock: limit === null ? null : limit > 0 };
      log(`Cart probe rejected (variant=${variantId}): "${message}" -> parsed limit=${limit}`);
    }

    try {
      await axios.post(`${baseUrl}/cart/clear.js`, {}, {
        headers: { ...BROWSER_HEADERS, Cookie: cookie },
        timeout: 8000,
        validateStatus: () => true,
      });
    } catch (err) {
      log(`Cart probe cleanup failed for variant=${variantId}: ${err.message}`);
    }

    return result;
  } catch (err) {
    log(`Cart probe failed for variant=${variantId}: ${err.message}`);
    return null;
  }
}

/**
 * For any product still missing an exact stockQuantity, try to
 * backfill it. Products that already have a number (e.g. resolved by
 * the GraphQL sku: search layer) are left untouched to avoid an
 * unnecessary extra request.
 *
 * Two speed decisions that matter a lot at batch scale:
 *  - Skip the productByHandle GraphQL attempt entirely once this store
 *    is known not to expose quantityAvailable (see
 *    isInventoryKnownUnsupported) — that request can never yield a
 *    number for this store, so it was pure wasted latency, roughly
 *    doubling request count per product.
 *  - Enrich multiple products concurrently (bounded) rather than one
 *    at a time — matters for multi-match SKUs, and for the store-scrape
 *    catalog crawl's optional enrichment pass.
 */
async function enrichMissingStockQuantities(products, log, baseUrl = BASE_URL, concurrency = 6) {
  const skipHandleLookup = isInventoryKnownUnsupported(baseUrl);

  return mapWithConcurrency(products, concurrency, async (p) => {
    if (typeof p.stockQuantity === 'number' || !p.url) {
      return p;
    }

    let merged = { ...p };

    // Attempt 1: exact GraphQL productByHandle lookup (only useful if
    // the store has inventory quantities exposed via the Storefront API).
    if (!skipHandleLookup) {
      const handle = extractHandleFromUrl(p.url);
      if (handle) {
        try {
          const live = await fetchProductByHandle(handle, p.sku, log, baseUrl);
          if (live) {
            merged = {
              ...merged,
              sku: merged.sku || live.sku,
              inStock: live.inStock ?? merged.inStock,
              stockQuantity: live.stockQuantity,
            };
          }
        } catch (err) {
          log(`Inventory enrichment (GraphQL) failed for handle="${handle}": ${err.message}`);
        }
      }
    }

    // Attempt 2: scrape the actual product page for the low-stock
    // warning + JSON-LD availability. This works regardless of any
    // Storefront API permission settings, so it's a valuable fallback
    // (and can give a real number precisely when stock is low, which
    // is usually the most actionable case anyway).
    if (typeof merged.stockQuantity !== 'number') {
      try {
        const pageStock = await fetchProductPageStock(p.url, log);
        merged = {
          ...merged,
          inStock: pageStock.inStock ?? merged.inStock,
          stockQuantity: pageStock.stockQuantity,
          lowStockWarning: pageStock.lowStockWarning || undefined,
        };
      } catch (err) {
        log(`Inventory enrichment (product page) failed for url="${p.url}": ${err.message}`);
      }
    }

    // Attempt 3: live cart probe. Last resort — only reached when
    // neither the GraphQL layer nor the page's own low-stock banner
    // could produce a number (i.e. stock is comfortably above the
    // banner's threshold, or this store doesn't run one at all).
    if (typeof merged.stockQuantity !== 'number') {
      const handle = extractHandleFromUrl(p.url);
      if (handle) {
        try {
          const productJs = await fetchProductAjaxJson(baseUrl, handle);
          const target = merged.sku ? merged.sku.toUpperCase() : null;
          const variant = target
            ? productJs?.variants?.find((v) => v.sku && v.sku.toUpperCase() === target)
            : productJs?.variants?.[0];
          if (variant?.id) {
            const probe = await probeCartLimit(baseUrl, variant.id, log);
            if (probe) {
              merged = {
                ...merged,
                inStock: probe.inStock ?? merged.inStock,
                stockQuantity: probe.stockQuantity,
                lowStockWarning: typeof probe.stockQuantity === 'number' ? true : merged.lowStockWarning,
              };
            }
          }
        } catch (err) {
          log(`Cart probe enrichment failed for handle="${handle}": ${err.message}`);
        }
      }
    }

    return merged;
  });
}

// ------------------------------------------------------------------
// Layer 3: Predictive Search JSON (/search/suggest.json)
// ------------------------------------------------------------------

async function searchBySkuSuggest(sku, log, baseUrl = BASE_URL) {
  const url = `${baseUrl}/search/suggest.json`;
  const res = await axios.get(url, {
    params: {
      q: sku,
      'resources[type]': 'product',
      'resources[limit]': 20,
      'resources[options][unavailable_products]': 'last',
    },
    headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
    timeout: 8000,
    validateStatus: () => true,
  });

  if (res.status !== 200 || !res.data) {
    throw new Error(`Predictive search failed (status ${res.status})`);
  }

  const items = res.data?.resources?.results?.products || [];
  log(`Predictive search returned ${items.length} raw result(s)`);

  const mapped = items.map((p) => {
    const image = p.image ? (p.image.startsWith('http') ? p.image : `https:${p.image}`) : null;
    return {
      title: p.title,
      // This endpoint doesn't expose SKU, a full gallery, or a
      // description — enrichMissingStockQuantities backfills the
      // stock number, but description/extra images stay unavailable
      // for products only found via this layer.
      description: null,
      sku: null,
      image,
      images: image ? [image] : [],
      price: parsePrice(p.price),
      compareAtPrice: p.compare_at_price ? parsePrice(p.compare_at_price) : null,
      // Predictive search exposes an in-stock/out-of-stock flag on some
      // themes/versions, but never an exact quantity.
      inStock: typeof p.available === 'boolean' ? p.available : null,
      stockQuantity: null,
      url: p.url ? cleanProductUrl(p.url, baseUrl) : null,
    };
  });

  return filterByConfirmedSku(mapped, sku, log);
}

// ------------------------------------------------------------------
// Layer 4: Full HTML search page scrape (guaranteed fallback)
// ------------------------------------------------------------------

function parseSearchResults(html, baseUrl = BASE_URL) {
  const $ = cheerio.load(html);
  const results = [];

  $('grid-item.product-item, .grid-item.product-item').each((_, el) => {
    const $item = $(el);
    const $link = $item.find('a.product-link').first();
    const rawUrl = $link.attr('href');
    if (!rawUrl) return;

    const title = $item.find('.product-item__title').first().text().trim();
    const image = $item.find('img').first().attr('src');
    const imageUrl = image ? (image.startsWith('http') ? image : `https:${image}`) : null;

    const newPriceText = $item
      .find('.product-item__price .new-price, .product-item__price .price')
      .first()
      .text()
      .trim();
    const oldPriceText = $item
      .find('.product-item__price .old-price')
      .first()
      .text()
      .trim();

    const badgeText = $item.find('.badge-box-container').first().text().trim();
    // Best-effort only: the search/collection grid renders a "Sold Out"
    // badge when a product has no stock (and the theme is configured to
    // still show it), but never an exact quantity. Treat an explicit
    // "sold out" badge as out-of-stock; absence of a badge as a guess
    // that it's in stock (Shopify usually hides fully out-of-stock
    // items from search unless the merchant enabled "continue selling").
    const inStock = /sold\s*out/i.test(badgeText) ? false : true;

    results.push({
      title,
      description: null, // not exposed on the search/collection grid
      sku: null,
      image: imageUrl,
      images: imageUrl ? [imageUrl] : [],
      price: parsePrice(newPriceText),
      compareAtPrice: parsePrice(oldPriceText) || null,
      inStock,
      stockQuantity: null, // not exposed on the search/collection page
      url: cleanProductUrl(rawUrl, baseUrl),
    });
  });

  const caption = $('.search__caption').first().text().trim();
  return { results, caption };
}

async function fetchSearchHtml(query, opts = {}, log = () => {}, baseUrl = BASE_URL) {
  const { retries = 5, baseDelayMs = 2000 } = opts;
  const url = buildSearchUrl(query, baseUrl);

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await axios.get(url, {
        headers: {
          ...BROWSER_HEADERS,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 15000,
        validateStatus: () => true,
      });
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      log(`Network error (${err.message}). Retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
      await sleep(delay);
      continue;
    }

    if (response.status === 200) return response.data;

    if (response.status === 429 || response.status >= 500) {
      if (attempt === retries) {
        throw new Error(`Request failed with status code ${response.status} after ${retries} retries`);
      }
      const retryAfterHeader = response.headers['retry-after'];
      const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : null;
      const backoffMs = baseDelayMs * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 500);
      const delay = (retryAfterMs || backoffMs) + jitter;
      log(`Got HTTP ${response.status}. Waiting ${delay}ms before retry (attempt ${attempt + 1}/${retries})...`);
      await sleep(delay);
      continue;
    }

    throw new Error(`Request failed with status code ${response.status}`);
  }
}

async function searchBySkuHtml(sku, opts, log, baseUrl = BASE_URL) {
  const html = await fetchSearchHtml(sku, opts, log, baseUrl);
  const { results, caption } = parseSearchResults(html, baseUrl);
  log(`HTML search page caption: "${caption}" (${results.length} raw result(s))`);

  const confirmed = filterByConfirmedSku(results, sku, log);

  // This is the last-resort layer — if strict filtering wiped out
  // everything but the raw HTML page did return results, surface the
  // raw list rather than reporting "not found". Flag it so the CLI
  // can warn the user these are unverified.
  if (confirmed.length === 0 && results.length > 0) {
    log('No result could be verified against the SKU; returning raw (unverified) results as a last resort.');
    return results.map((p) => ({ ...p, unverified: true }));
  }

  return confirmed;
}

// ------------------------------------------------------------------
// Unified entry point: cache -> GraphQL -> predictive search -> HTML
// ------------------------------------------------------------------

/**
 * @param {string} sku
 * @param {object} [options]
 * @param {boolean} [options.useCache=true]
 * @param {boolean} [options.verbose=false]
 * @param {object}  [options.htmlRetryOpts] - passed to the HTML fallback layer
 * @param {boolean} [options.skipHtmlLayer=false] - never fall through to the
 *   slow, rate-limited HTML search page; a SKU that GraphQL and predictive
 *   search couldn't find is reported as not-found instead. Trades
 *   completeness for speed/reliability in large batch runs.
 * @param {string} [options.baseUrl] - which storefront to search, e.g.
 *   "bhunes.com" or "https://otherstore.com". Defaults to bhunes.com.
 *   Since this is a request-time value that can come from a user (the
 *   UI's "Storefront" field), it's validated the same way the store
 *   catalog scrape's URL is — see assertPublicStoreUrl. Note the
 *   Storefront GraphQL layer still only works for stores whose access
 *   token matches STOREFRONT_TOKEN (bhunes.com by default); other
 *   stores fall through to predictive search / HTML, same as when
 *   GraphQL fails for any other reason.
 * @returns {Promise<{query, count, source, timingMs, products}>}
 */
async function searchBySku(sku, options = {}) {
  if (!sku || typeof sku !== 'string') {
    throw new Error('searchBySku(sku): sku must be a non-empty string');
  }
  const clean = sku.trim();
  const {
    useCache = true,
    verbose = false,
    htmlRetryOpts = {},
    skipHtmlLayer = false,
  } = options;
  const log = (...args) => {
    if (verbose) console.error('[scraper]', ...args);
  };

  // The UI always sends a "site" value (pre-filled with the default),
  // so this needs to skip the DNS-based SSRF check for the common case
  // of it just being our own trusted default — otherwise every single
  // SKU lookup in a batch would pay for a redundant DNS lookup against
  // a hostname we already trust.
  const requestedBaseUrl = options.baseUrl ? normalizeStoreUrl(options.baseUrl) : BASE_URL;
  const baseUrl = requestedBaseUrl === BASE_URL
    ? BASE_URL
    : (await assertPublicStoreUrl(requestedBaseUrl)).toString().replace(/\/+$/, '');

  const start = Date.now();

  if (useCache) {
    const cached = readCache(clean, baseUrl);
    if (cached) {
      log('Cache hit');
      return {
        query: clean,
        count: cached.length,
        source: 'cache',
        timingMs: Date.now() - start,
        products: cached,
      };
    }
  }

  // Layer 2: Storefront GraphQL API
  try {
    let products = await searchBySkuGraphQL(clean, log, baseUrl);
    if (products.length > 0) {
      products = await enrichMissingStockQuantities(products, log, baseUrl);
      writeCache(clean, products, baseUrl);
      return {
        query: clean,
        count: products.length,
        source: 'graphql',
        timingMs: Date.now() - start,
        products,
      };
    }
    log('GraphQL returned zero matches, trying predictive search...');
  } catch (err) {
    log(`GraphQL layer failed: ${err.message}. Trying predictive search...`);
  }

  // Layer 3: Predictive search JSON
  try {
    let products = await searchBySkuSuggest(clean, log, baseUrl);
    if (products.length > 0) {
      products = await enrichMissingStockQuantities(products, log, baseUrl);
      writeCache(clean, products, baseUrl);
      return {
        query: clean,
        count: products.length,
        source: 'predictive-search',
        timingMs: Date.now() - start,
        products,
      };
    }
    log('Predictive search returned zero matches, falling back to HTML scrape...');
  } catch (err) {
    log(`Predictive search layer failed: ${err.message}. Falling back to HTML scrape...`);
  }

  if (skipHtmlLayer) {
    log('skipHtmlLayer is set — not attempting the HTML fallback. Reporting as not found.');
    return {
      query: clean,
      count: 0,
      source: 'predictive-search',
      timingMs: Date.now() - start,
      products: [],
    };
  }

  // Layer 4: Full HTML scrape (with retry/backoff for 429/5xx)
  let products = await searchBySkuHtml(clean, htmlRetryOpts, log, baseUrl);
  if (products.length > 0) {
    products = await enrichMissingStockQuantities(products, log, baseUrl);
    writeCache(clean, products, baseUrl);
  }

  return {
    query: clean,
    count: products.length,
    source: 'html',
    timingMs: Date.now() - start,
    products,
  };
}

// ------------------------------------------------------------------
// Store-wide catalog scrape: /products.json (public Shopify endpoint)
// ------------------------------------------------------------------
//
// Everything above answers "does SKU X exist?". This answers "list
// every product this store sells" for an arbitrary Shopify storefront
// URL (not just bhunes.com) — used by the "Scrape Store" task, where
// the site is a value the user types in rather than a constant.
//
// Shopify exposes `/products.json` on virtually every storefront
// without authentication (it's the same JSON the theme itself can
// fetch client-side), so — unlike the SKU-search layers above — this
// doesn't need a per-store Storefront API token. It paginates via
// `page=` — the Admin API's `since_id` cursor is a different, private
// endpoint and gets silently ignored here, so `page=` is what actually
// works against the public storefront JSON.

const PRIVATE_IPV4_RANGES = [
  (a, b) => a === 10,
  (a, b) => a === 127,
  (a, b) => a === 0,
  (a, b) => a === 169 && b === 254, // link-local, incl. cloud metadata (169.254.169.254)
  (a, b) => a === 172 && b >= 16 && b <= 31,
  (a, b) => a === 192 && b === 168,
];

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return PRIVATE_IPV4_RANGES.some((test) => test(a, b));
  }
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
  }
  return false;
}

/**
 * The store URL for this feature comes straight from the user, and the
 * server then makes HTTP requests to it — the textbook shape of an
 * SSRF vulnerability if unguarded (e.g. a "store URL" of
 * `http://169.254.169.254/...` or `http://localhost:5432/...`). This
 * rejects anything that isn't a plain public http(s) host before any
 * request is made.
 *
 * Residual risk: this resolves DNS once up front, but the actual HTTP
 * request re-resolves independently, so a DNS-rebinding attacker who
 * controls their own domain could in principle swap the answer between
 * the two lookups. Pinning the checked IP for the request itself would
 * close that gap but requires manually managing TLS SNI for https — a
 * fair chunk of complexity for a low-probability attack path here, so
 * it's out of scope for now.
 */
async function assertPublicStoreUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('That doesn\'t look like a valid URL.');
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('Only http:// and https:// store URLs are allowed.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '0.0.0.0') {
    throw new Error('That host is not allowed.');
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('That host resolves to a private/internal address and is not allowed.');
  }

  return parsed;
}

function normalizeStoreUrl(input) {
  let v = (input || '').trim();
  if (!v) throw new Error('Store URL is required.');
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v.replace(/\/+$/, '');
}

/**
 * Flattens one Shopify REST product (with its variants) into the same
 * shape searchBySku's callers already know how to render: one row per
 * variant/SKU. `/products.json` doesn't expose exact inventory counts
 * (that's Admin-API-only), so stockQuantity always stays null here —
 * only the in-stock/out-of-stock boolean is available.
 */
// Strips HTML tags from a Shopify body_html description down to plain
// text — REST /products.json only offers the rendered HTML, not a
// plain-text field the way the Storefront GraphQL API does.
function stripHtmlToText(html, maxLength = 2000) {
  if (!html) return null;
  const text = cheerio.load(html).text().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function mapCatalogProduct(product, baseUrl) {
  const images = (product.images || []).map((img) => img.src).filter(Boolean);
  const image = images[0] || product.image?.src || null;
  const url = `${baseUrl}/products/${product.handle}`;
  const description = stripHtmlToText(product.body_html);
  const variants = product.variants || [];

  return variants.map((v) => ({
    sku: v.sku ? v.sku.trim() : null,
    title: v.title && v.title !== 'Default Title' ? `${product.title} — ${v.title}` : product.title,
    description,
    image,
    images: images.length > 0 ? images : (image ? [image] : []),
    price: v.price != null ? parseFloat(v.price) : null,
    compareAtPrice: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
    inStock: typeof v.available === 'boolean' ? v.available : null,
    stockQuantity: null,
    url,
    productId: product.id,
  }));
}

/**
 * Fetches one page via the public REST catalog listing. Works on any
 * Shopify storefront without a token, but never exposes exact stock
 * counts — only the in-stock/out-of-stock boolean.
 *
 * Uses `page=` rather than `since_id=` — `since_id` is an Admin-API-only
 * cursor that this public endpoint silently ignores (confirmed against
 * a live store: passing since_id just returns page 1 again, every
 * time). `page=` is what it actually respects.
 */
async function fetchCatalogPageRest(baseUrl, { page, limit }) {
  const pageNum = Math.max(1, Number(page) || 1);
  const res = await axios.get(`${baseUrl}/products.json`, {
    params: { limit, page: pageNum },
    headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
    timeout: 15000,
    maxRedirects: 3,
    validateStatus: () => true,
  });

  if (res.status !== 200 || !res.data || !Array.isArray(res.data.products)) {
    throw new Error(
      `Couldn't read the product catalog (status ${res.status}). This may not be a Shopify store, or its catalog listing is disabled.`
    );
  }

  const products = res.data.products;
  const variants = products.flatMap((p) => mapCatalogProduct(p, baseUrl));
  const hasMore = products.length === limit;

  return {
    baseUrl,
    source: 'rest',
    productCount: products.length,
    variants,
    nextCursor: hasMore ? `rest:${pageNum + 1}` : null,
    hasMore,
  };
}

// ------------------------------------------------------------------
// Store-wide catalog scrape, layer 2: Storefront GraphQL listing
// ------------------------------------------------------------------
//
// The REST layer above works everywhere but never has exact stock
// counts. The Storefront GraphQL API *does* expose quantityAvailable
// (same field searchBySkuGraphQL already uses) — and critically, it
// can be read for an entire page of products in one request, so
// getting exact quantities here doesn't cost an extra request per
// product the way enrichMissingStockQuantities does for SKU search.
//
// The catch: it needs a Storefront API access token scoped to the
// target store. STOREFRONT_TOKEN is bhunes.com's token, so this layer
// only succeeds for bhunes.com (or another store whose matching token
// is supplied via BHUNES_STOREFRONT_TOKEN) — for any other store URL
// the request fails fast (401/403) and the caller falls back to REST.

const CATALOG_QUERY_WITH_INVENTORY = `
  query CatalogPage($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
          description
          handle
          onlineStoreUrl
          featuredImage { url }
          images(first: 8) { edges { node { url } } }
          variants(first: 50) {
            edges {
              node {
                title
                sku
                availableForSale
                quantityAvailable
                price { amount currencyCode }
                compareAtPrice { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

const CATALOG_QUERY_BASIC = `
  query CatalogPage($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
          description
          handle
          onlineStoreUrl
          featuredImage { url }
          images(first: 8) { edges { node { url } } }
          variants(first: 50) {
            edges {
              node {
                title
                sku
                availableForSale
                price { amount currencyCode }
                compareAtPrice { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

function mapGraphQLCatalogNode(node, baseUrl) {
  const variantEdges = node.variants?.edges || [];
  const images = graphqlNodeImages(node);
  const url = node.onlineStoreUrl || `${baseUrl}/products/${node.handle}`;

  return variantEdges.map(({ node: v }) => ({
    sku: v.sku ? v.sku.trim() : null,
    title: v.title && v.title !== 'Default Title' ? `${node.title} — ${v.title}` : node.title,
    description: node.description || null,
    image: images[0] || null,
    images,
    price: v.price ? parseFloat(v.price.amount) : null,
    compareAtPrice: v.compareAtPrice ? parseFloat(v.compareAtPrice.amount) : null,
    inStock: typeof v.availableForSale === 'boolean' ? v.availableForSale : null,
    stockQuantity: typeof v.quantityAvailable === 'number' ? v.quantityAvailable : null,
    url,
  }));
}

/**
 * @param {string} baseUrl
 * @param {object} options
 * @param {string} [options.apiVersion] - pin to a known-good version
 *   (skips the version-discovery loop) once one has already succeeded
 *   for this crawl.
 * @param {string|null} [options.cursor] - Relay cursor from the
 *   previous page's pageInfo.endCursor.
 * @param {number} options.limit
 */
async function fetchCatalogPageGraphQL(baseUrl, { apiVersion, cursor, limit }) {
  const versionsToTry = apiVersion ? [apiVersion] : GRAPHQL_VERSIONS_TO_TRY;

  for (const version of versionsToTry) {
    let res = await graphqlRequest(version, CATALOG_QUERY_WITH_INVENTORY, {
      first: limit,
      after: cursor || null,
    }, baseUrl);

    if (isInventoryFieldError(res)) {
      res = await graphqlRequest(version, CATALOG_QUERY_BASIC, {
        first: limit,
        after: cursor || null,
      }, baseUrl);
    }

    if (res.status === 200 && res.data && !res.data.errors) {
      const productsField = res.data?.data?.products;
      if (!productsField) continue;

      const edges = productsField.edges || [];
      const variants = edges.flatMap(({ node }) => mapGraphQLCatalogNode(node, baseUrl));
      const hasMore = !!productsField.pageInfo?.hasNextPage;
      const endCursor = productsField.pageInfo?.endCursor || null;

      return {
        baseUrl,
        source: 'graphql',
        productCount: edges.length,
        variants,
        nextCursor: hasMore ? `gql:${version}:${endCursor || '-'}` : null,
        hasMore,
      };
    }

    // Wrong/unsupported API version — try the next one. Anything else
    // (auth rejected, 5xx, ...) means this store's token doesn't work
    // here at all, so stop trying versions and let the caller fall
    // back to the REST layer instead.
    if (res.status !== 400 && res.status !== 404) {
      const bodyStr = JSON.stringify(res.data || {}).slice(0, 300);
      throw new Error(`Storefront GraphQL catalog listing failed (status ${res.status}): ${bodyStr}`);
    }
  }

  throw new Error('No supported Storefront API version accepted the catalog listing query.');
}

/**
 * Fetches one page of the store's public catalog — exact stock counts
 * when the GraphQL layer works for this store, in-stock/out-of-stock
 * only otherwise. `cursor` is an opaque string this function hands
 * back (`nextCursor`); pass it straight through on the next call and
 * this dispatches to whichever layer produced it. Passing no cursor
 * starts a fresh crawl, trying GraphQL first.
 *
 * @param {string} storeUrl - any Shopify storefront URL, e.g. "bhunes.com"
 * @param {object} [options]
 * @param {string|null} [options.cursor=null]
 * @param {number} [options.limit=250] - Shopify caps both layers at 250.
 * @param {boolean} [options.enrichStock=true] - run every variant still
 *   missing a number through enrichMissingStockQuantities (GraphQL
 *   productByHandle -> page-scrape -> live cart probe) before
 *   returning. This is what makes the catalog crawl show exact
 *   quantities instead of just in-stock/out-of-stock — same as Single
 *   Lookup and Batch Check already do — but at catalog scale it's a
 *   lot more network calls per page (each unresolved variant can cost
 *   up to 3 extra requests, one of which briefly writes to the
 *   store's live cart), so a full-store crawl takes meaningfully
 *   longer than a listing-only one. Pass false to skip it.
 * @returns {Promise<{baseUrl, source, productCount, variants, nextCursor, hasMore}>}
 */
async function fetchCatalogPage(storeUrl, options = {}) {
  // Off by default: enriching every product in a full catalog crawl
  // means thousands of extra requests (page scrapes + live cart
  // probes) in a short window, which is exactly what triggered this
  // store's own rate limiting during testing. The fast path just lists
  // the catalog (in-stock/out-of-stock only, no cart writes) — callers
  // who want exact quantities for specific SKUs should run those
  // through searchBySku instead (see "Check exact quantities" on the
  // Scrape Store results page), which only touches the SKUs someone
  // actually asked about.
  const { cursor = null, enrichStock = false } = options;
  const baseUrl = normalizeStoreUrl(storeUrl);
  await assertPublicStoreUrl(baseUrl);
  const limit = Math.min(Math.max(1, Number(options.limit) || 250), 250);
  const log = () => {};

  let page;
  if (cursor && cursor.startsWith('rest:')) {
    page = await fetchCatalogPageRest(baseUrl, { page: Number(cursor.slice(5)) || 1, limit });
  } else if (cursor && cursor.startsWith('gql:')) {
    const [, apiVersion, after] = cursor.split(':');
    page = await fetchCatalogPageGraphQL(baseUrl, { apiVersion, cursor: after === '-' ? null : after, limit });
  } else {
    // Fresh crawl: try GraphQL first (exact quantities), fall back to
    // the public REST listing (works everywhere, no exact quantities)
    // if this store's token doesn't apply here.
    try {
      page = await fetchCatalogPageGraphQL(baseUrl, { cursor: null, limit });
    } catch {
      page = await fetchCatalogPageRest(baseUrl, { page: 1, limit });
    }
  }

  if (enrichStock && page.variants.length > 0) {
    // Deliberately modest concurrency: a full store-scrape can mean
    // thousands of enrichment requests (page scrapes + live cart
    // probes) in a short window, and pushing that too hard is exactly
    // what got this store's own rate limiting to kick in during
    // testing — after which every request from this IP came back
    // 429, even a plain products/*.js GET. requestWithBackoff (used
    // by every enrichment request) recovers from a rate-limit window,
    // but staying well under the threshold that triggers it in the
    // first place is cheaper than backing off from it constantly.
    //
    // enrichMissingStockQuantities already catches errors per-product
    // internally, but this catches anything that still escapes that
    // (a bug, a rare edge case) so a page's already-fetched listing
    // data isn't thrown away just because quantity enrichment hit a
    // snag — the page still comes back with in-stock/out-of-stock
    // instead of exact numbers, rather than failing outright.
    try {
      page.variants = await enrichMissingStockQuantities(page.variants, log, baseUrl, 4);
    } catch (err) {
      console.error(`Catalog page enrichment failed for baseUrl="${baseUrl}":`, err.message);
    }
  }

  return page;
}

// ------------------------------------------------------------------
// CLI entry point
// ------------------------------------------------------------------

/**
 * Renders the best stock info we have. Exact counts (stockQuantity)
 * only come from the GraphQL layer, and only if the merchant has
 * exposed inventory quantities via the Storefront API. Everything
 * else falls back to a simple in-stock/out-of-stock guess, or
 * "unknown" if even that couldn't be determined.
 */
function formatStock(product) {
  if (typeof product.stockQuantity === 'number') {
    const urgency = product.lowStockWarning ? ' ⚠ low stock' : '';
    return `${product.stockQuantity} available${urgency}`;
  }
  if (product.inStock === true) {
    return 'In stock (exact quantity not exposed by this source)';
  }
  if (product.inStock === false) {
    return 'Out of stock';
  }
  return 'Unknown (not exposed by this data source)';
}

async function main() {
  const args = process.argv.slice(2);
  const sku = args.find((a) => !a.startsWith('--'));
  const asJson = args.includes('--json');
  const verbose = args.includes('--verbose');
  const noCache = args.includes('--no-cache');
  const shouldOpen = args.includes('--open');

  if (!sku) {
    console.error('Usage: node scraper.js <SKU> [--json] [--verbose] [--no-cache] [--open]');
    console.error('Example: node scraper.js BHU438A --verbose');
    process.exit(1);
  }

  try {
    const data = await searchBySku(sku, { useCache: !noCache, verbose });

    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (verbose) {
      console.error(`[scraper] Source: ${data.source} | Time: ${data.timingMs}ms`);
    }

    if (data.count === 0) {
      console.log(`No products found for SKU "${sku}".`);
      console.log(`Searched: ${buildSearchUrl(sku)}`);
      return;
    }

    console.log(`Found ${data.count} product(s) for "${sku}" (via ${data.source}, ${data.timingMs}ms):\n`);
    data.products.forEach((p, i) => {
      console.log(`${i + 1}. ${p.title}${p.unverified ? '  [UNVERIFIED — not confirmed to match this SKU]' : ''}`);
      console.log(`   Price: ${p.price != null ? 'Rs. ' + p.price : 'N/A'}`);
      console.log(`   Stock: ${formatStock(p)}`);
      console.log(`   URL:   ${p.url}`);
      console.log('');
    });

    if (shouldOpen) {
      try {
        const open = (await import('open')).default;
        await open(data.products[0].url);
      } catch {
        console.log('(Install the "open" package to enable --open: npm i open)');
      }
    }
  } catch (err) {
    console.error('Scrape failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  searchBySku,
  buildSearchUrl,
  cleanProductUrl,
  parseSearchResults,
  searchBySkuGraphQL,
  searchBySkuSuggest,
  mapGraphQLProducts,
  filterByConfirmedSku,
  fetchProductByHandle,
  enrichMissingStockQuantities,
  extractHandleFromUrl,
  fetchProductPageStock,
  extractProductJsonLd,
  parseLowStockCount,
  mapSchemaAvailability,
  sleep,
  fetchCatalogPage,
  normalizeStoreUrl,
  assertPublicStoreUrl,
  isPrivateIp,
};