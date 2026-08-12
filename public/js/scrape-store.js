(function () {
  const $ = (id) => document.getElementById(id);

  const storeUrlInput = $('storeUrlInput');
  const startScrapeBtn = $('startScrapeBtn');
  const errorBanner = $('errorBanner');
  const progressWrap = $('progressWrap');
  const progressLabel = $('progressLabel');

  const runsBody = $('runsBody');
  const runsEmpty = $('runsEmpty');
  const clearRunsBtn = $('clearRunsBtn');

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove('d-none');
  }
  function clearError() {
    errorBanner.classList.add('d-none');
    errorBanner.textContent = '';
  }

  // ---------- recent scrapes ledger ----------

  function renderRuns() {
    const entries = BhunesHistory.byType('store-scrape');
    if (entries.length === 0) {
      runsBody.innerHTML = '';
      runsEmpty.classList.remove('d-none');
      return;
    }
    runsEmpty.classList.add('d-none');

    runsBody.innerHTML = entries.map((e) => `
      <tr>
        <td class="text-faint font-mono">${BhunesFmt.relativeTime(e.ts)}</td>
        <td class="font-mono small">${BhunesFmt.escapeHtml(e.storeUrl)}</td>
        <td class="font-mono">${e.totalProducts}</td>
        <td class="text-accent fw-semibold">${e.skusFound}</td>
        <td>${e.runId
          ? `<a href="/batch-results.html?run=${encodeURIComponent(e.runId)}" class="btn btn-outline-robotik btn-sm-pill">View <i class="bi bi-arrow-right ms-1"></i></a>`
          : '<span class="text-faint small">expired</span>'}</td>
      </tr>
    `).join('');
  }
  clearRunsBtn.addEventListener('click', () => {
    BhunesHistory.clear('store-scrape');
    renderRuns();
  });

  // ---------- run scrape ----------

  function buildRunResults(variants) {
    return variants.map((v) => {
      // 'graphql' means this came with an exact stock count; 'rest'
      // means only the in-stock/out-of-stock boolean was available.
      const sourceLabel = v.source === 'graphql' ? 'catalog (live qty)' : 'catalog';
      // A variant without a SKU still gets the full row — image, price,
      // stock, product link — same as any other; it just can't be
      // searched by SKU later, so the ledger flags it (red) instead of
      // hiding its details.
      return {
        sku: v.sku || null,
        isNoSku: !v.sku,
        count: 1,
        source: sourceLabel,
        timingMs: 0,
        error: null,
        products: [{
          title: v.title, sku: v.sku, image: v.image, price: v.price,
          compareAtPrice: v.compareAtPrice, inStock: v.inStock,
          stockQuantity: v.stockQuantity, url: v.url,
        }],
      };
    });
  }

  startScrapeBtn.addEventListener('click', async () => {
    clearError();
    const storeUrl = storeUrlInput.value.trim();
    if (!storeUrl) { showError('Enter a store website URL.'); return; }

    startScrapeBtn.disabled = true;
    startScrapeBtn.innerHTML = '<span class="spinner-robotik"></span>Starting…';
    progressWrap.classList.remove('d-none');
    progressLabel.textContent = 'Connecting to store…';

    try {
      const { baseUrl, totalProducts, variants } = await BhunesAPI.crawlStore(storeUrl, {
        onProgress: ({ pages, totalProducts, skusFound }) => {
          progressLabel.textContent = `Page ${pages} · ${totalProducts} products scanned · ${skusFound} SKUs found so far…`;
          startScrapeBtn.innerHTML = `<span class="spinner-robotik"></span>Scanning… ${totalProducts} products`;
        },
      });

      const results = buildRunResults(variants);
      const skusFound = variants.filter((v) => v.sku).length;

      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      BhunesRuns.save({
        id: runId,
        type: 'store-scrape',
        ts: Date.now(),
        skus: results.map((r) => r.sku),
        storeUrl: baseUrl,
        options: {},
        summary: { total: results.length, found: skusFound, notFound: results.length - skusFound, errored: 0, totalProducts },
        results,
      });
      BhunesHistory.add({
        type: 'store-scrape',
        runId,
        storeUrl: baseUrl,
        totalProducts,
        skusFound,
      });

      window.location.href = `/batch-results.html?run=${encodeURIComponent(runId)}`;
    } catch (err) {
      showError(err.message);
      renderRuns();
    } finally {
      startScrapeBtn.disabled = false;
      startScrapeBtn.innerHTML = '<i class="bi bi-radar me-1"></i>Start Scrape';
      progressWrap.classList.add('d-none');
    }
  });

  renderRuns();
})();
