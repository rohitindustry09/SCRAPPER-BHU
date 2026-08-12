(function () {
  const $ = (id) => document.getElementById(id);

  const resultsView = $('resultsView');
  const emptyView = $('emptyView');
  const runMeta = $('runMeta');
  const summaryStrip = $('summaryStrip');
  const resultsBody = $('resultsBody');
  const filterInput = $('filterInput');
  const downloadCsvBtn = $('downloadCsvBtn');
  const checkQtyBtn = $('checkQtyBtn');
  const skuFilterBtn = $('skuFilterBtn');
  const skuFilterModalEl = $('skuFilterModal');
  const skuFilterTextarea = $('skuFilterTextarea');
  const skuFilterDrop = $('skuFilterDrop');
  const skuFilterFileInput = $('skuFilterFileInput');
  const skuFilterCount = $('skuFilterCount');
  const skuFilterApplyBtn = $('skuFilterApplyBtn');
  const skuFilterClearBtn = $('skuFilterClearBtn');
  const visibleCountText = $('visibleCountText');
  const paginationBar = $('paginationBar');
  const pageInfo = $('pageInfo');
  const prevPageBtn = $('prevPageBtn');
  const nextPageBtn = $('nextPageBtn');

  const breadcrumbParentLink = $('breadcrumbParentLink');
  const resultsHeading = $('resultsHeading');
  const newRunLink = $('newRunLink');

  const params = new URLSearchParams(window.location.search);
  const runId = params.get('run');
  const run = runId ? BhunesRuns.get(runId) : BhunesRuns.latest();

  if (!run) {
    emptyView.classList.remove('d-none');
    return;
  }
  resultsView.classList.remove('d-none');

  const isStoreScrape = run.type === 'store-scrape';
  if (isStoreScrape) {
    breadcrumbParentLink.textContent = 'Scrape Store';
    breadcrumbParentLink.href = '/scrape-store.html';
    resultsHeading.textContent = 'Store Scrape Results';
    newRunLink.href = '/scrape-store.html';
    newRunLink.innerHTML = '<i class="bi bi-arrow-left me-1"></i>New scrape';
    checkQtyBtn.classList.remove('d-none');
  }

  const PAGE_SIZE = 100;
  let currentPage = 1;
  let activeTab = 'all';

  // ---------- flatten results into one row per rendered <tr> ----------
  // productLookup holds the full product payload (with sku/source
  // merged in) for every rendered row, indexed so the click handler
  // can find it regardless of which page is currently shown.

  const productLookup = [];

  function buildRows(results) {
    const rows = [];
    let serial = 0;

    for (const r of results) {
      if (r.error) {
        serial += 1;
        rows.push({
          tab: 'error',
          sku: r.sku || null,
          search: (r.sku || '').toLowerCase(),
          csvResult: { sku: r.sku, count: 0, source: r.source, timingMs: r.timingMs, error: r.error },
          html: `
            <tr class="row-notfound">
              <td class="hide-sm serial-cell">${serial}</td>
              <td class="sku-cell">${BhunesFmt.escapeHtml(r.sku)}</td>
              <td colspan="5">Error: ${BhunesFmt.escapeHtml(r.error)}</td>
            </tr>`,
        });
        continue;
      }
      if (r.count === 0) {
        serial += 1;
        const label = r.notFoundLabel || 'Not found';
        rows.push({
          tab: 'notfound',
          sku: r.sku || null,
          search: ((r.sku || '') + ' ' + label).toLowerCase(),
          csvResult: { sku: r.sku, count: 0, source: r.source, timingMs: r.timingMs, error: null },
          html: `
            <tr class="row-notfound">
              <td class="hide-sm serial-cell">${serial}</td>
              <td class="sku-cell">${BhunesFmt.escapeHtml(r.sku)}</td>
              <td colspan="5">${BhunesFmt.escapeHtml(label)}</td>
            </tr>`,
        });
        continue;
      }
      r.products.forEach((p) => {
        serial += 1;
        const title = BhunesFmt.escapeHtml(p.title);

        const productIdx = productLookup.length;
        productLookup.push({ ...p, sku: r.isNoSku ? null : (p.sku || r.sku), source: r.source, timingMs: r.timingMs });

        const thumb = p.image
          ? `<img src="${p.image}" alt="" loading="lazy" class="result-thumb result-thumb-clickable"
               data-product-idx="${productIdx}"
               onerror="this.outerHTML='<span class=&quot;result-thumb result-thumb-empty&quot; data-product-idx=&quot;${productIdx}&quot;><i class=&quot;bi bi-image&quot;></i></span>'">`
          : `<span class="result-thumb result-thumb-empty" data-product-idx="${productIdx}" style="cursor:pointer"><i class="bi bi-image"></i></span>`;

        // A "no SKU" product still gets the exact same row (image,
        // price, stock, link, description) as any other — it's just
        // flagged red and labeled, since it can't be looked up by SKU
        // later.
        const skuCell = r.isNoSku
          ? '<span class="text-danger">No SKU</span>'
          : BhunesFmt.escapeHtml(r.sku);
        const descText = p.description
          ? BhunesFmt.escapeHtml(p.description)
          : '<span class="text-faint">&mdash;</span>';

        rows.push({
          tab: r.isNoSku ? 'nosku' : 'found',
          sku: r.isNoSku ? null : (p.sku || r.sku),
          search: ((r.sku || '') + ' ' + (p.title || '') + ' ' + (p.description || '')).toLowerCase(),
          csvResult: { sku: r.sku, count: 1, source: r.source, timingMs: r.timingMs, error: null, products: [p] },
          html: `
            <tr class="${r.isNoSku ? 'row-notfound' : ''}">
              <td class="hide-sm serial-cell">${serial}</td>
              <td class="sku-cell">${skuCell}</td>
              <td>
                <div class="d-flex align-items-center gap-3">
                  ${thumb}
                  <a href="${p.url}" target="_blank" rel="noopener" style="max-width:280px;">${title}</a>
                </div>
              </td>
              <td class="price-cell">${BhunesFmt.price(p)}</td>
              <td>${BhunesFmt.stamp(p)}</td>
              <td>
                <div class="d-flex gap-2 flex-nowrap">
                  <button type="button" class="btn btn-outline-robotik btn-sm-pill" data-product-idx="${productIdx}"><i class="bi bi-images me-1"></i>Details</button>
                  <a href="${p.url}" target="_blank" rel="noopener" class="btn btn-outline-robotik btn-sm-pill">Open <i class="bi bi-box-arrow-up-right ms-1"></i></a>
                </div>
              </td>
              <td class="hide-sm description-cell" title="${BhunesFmt.escapeHtml(p.description || '')}">${descText}</td>
            </tr>`,
        });
      });
    }

    return rows;
  }

  const allRows = buildRows(run.results);
  const allSkuSet = new Set(
    allRows.map((row) => row.sku).filter(Boolean).map((s) => s.toUpperCase())
  );

  function buildMissingSkuRow(sku) {
    return {
      tab: 'notfound',
      sku,
      search: sku.toLowerCase(),
      csvResult: { sku, count: 0, source: null, timingMs: 0, error: null },
      html: `
        <tr class="row-notfound">
          <td class="hide-sm serial-cell">&mdash;</td>
          <td class="sku-cell">${BhunesFmt.escapeHtml(sku)}</td>
          <td colspan="5">Not found in this run</td>
        </tr>`,
    };
  }

  // Optional SKU-list filter (paste or upload a .txt like my-skus.txt)
  // — when set, only rows whose SKU is in this list show up, on top of
  // whatever the active tab/search filter already narrows down to.
  // Any SKU in the pasted list that never appeared in the run at all
  // (a straight intersection would just silently drop it) gets a
  // synthetic "Not found in this run" row instead, so the list you
  // pasted is what gets accounted for — not just whatever happened to
  // already be in the results.
  let skuFilterSet = null;

  function filteredRows() {
    const q = filterInput.value.trim().toLowerCase();
    let rows = activeTab === 'all' ? allRows : allRows.filter((row) => row.tab === activeTab);
    if (q) rows = rows.filter((row) => row.search.includes(q));
    if (skuFilterSet) {
      rows = rows.filter((row) => row.sku && skuFilterSet.has(row.sku.toUpperCase()));
      const missing = [...skuFilterSet].filter((sku) => !allSkuSet.has(sku));
      if (missing.length > 0) rows = [...rows, ...missing.map(buildMissingSkuRow)];
    }
    return rows;
  }

  function renderPage() {
    const rows = filteredRows();
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    currentPage = Math.min(Math.max(1, currentPage), totalPages);

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);

    resultsBody.innerHTML = pageRows.map((row) => row.html).join('')
      || `<tr><td colspan="7" class="empty-note">No results match.</td></tr>`;

    const rangeLabel = rows.length === 0
      ? '0 rows'
      : `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length}`;
    pageInfo.textContent = `${rangeLabel} · Page ${currentPage} of ${totalPages}`;

    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = currentPage >= totalPages;
    paginationBar.classList.toggle('d-none', rows.length <= PAGE_SIZE);

    visibleCountText.textContent = rows.length === allRows.length
      ? `${rows.length} showing`
      : `${rows.length} of ${allRows.length} showing`;
  }

  function tabDefinitions() {
    const { summary } = run;
    if (isStoreScrape) {
      return [
        { key: 'all', cls: 'accent', num: summary.totalProducts, lbl: 'Products in store' },
        { key: 'found', cls: 'ok', num: summary.found, lbl: 'SKUs found' },
        { key: 'nosku', cls: 'danger', num: summary.notFound, lbl: 'No SKU' },
      ];
    }
    const tabs = [
      { key: 'found', cls: 'ok', num: summary.found, lbl: 'Found' },
      { key: 'notfound', cls: 'danger', num: summary.notFound, lbl: 'Not found' },
      { key: 'all', cls: 'accent', num: summary.total, lbl: 'Total checked' },
    ];
    if (summary.errored) tabs.push({ key: 'error', cls: 'danger', num: summary.errored, lbl: 'Errors' });
    return tabs;
  }

  function renderSummaryStrip() {
    summaryStrip.innerHTML = tabDefinitions().map((t) => `
      <button type="button" class="stat-tile ${t.cls} clickable ${activeTab === t.key ? 'active' : ''}" data-tab="${t.key}">
        <div class="num">${t.num}</div><div class="lbl">${t.lbl}</div>
      </button>
    `).join('');
  }

  summaryStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    activeTab = btn.dataset.tab;
    currentPage = 1;
    renderSummaryStrip();
    renderPage();
  });

  function render() {
    const { ts, skus } = run;

    runMeta.textContent = isStoreScrape
      ? `${new Date(ts).toLocaleString()} · ${run.storeUrl || ''}`
      : `${new Date(ts).toLocaleString()} · ${skus.length} SKU(s) submitted · ${run.storeUrl || 'https://bhunes.com'}`;

    renderSummaryStrip();
    renderPage();
  }

  filterInput.addEventListener('input', () => {
    currentPage = 1;
    renderPage();
  });

  prevPageBtn.addEventListener('click', () => { currentPage -= 1; renderPage(); });
  nextPageBtn.addEventListener('click', () => { currentPage += 1; renderPage(); });

  // ---------- filter by SKU list (paste or upload a .txt) ----------

  const skuFilterModal = window.bootstrap ? new bootstrap.Modal(skuFilterModalEl) : null;

  function parseSkuLines(text) {
    return [...new Set(
      text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.toUpperCase())
    )];
  }

  function refreshSkuFilterCount() {
    const n = parseSkuLines(skuFilterTextarea.value).length;
    skuFilterCount.textContent = `${n} SKU${n === 1 ? '' : 's'} entered`;
  }
  skuFilterTextarea.addEventListener('input', refreshSkuFilterCount);

  skuFilterDrop.addEventListener('dragover', (e) => { e.preventDefault(); skuFilterDrop.classList.add('drag'); });
  skuFilterDrop.addEventListener('dragleave', () => skuFilterDrop.classList.remove('drag'));
  skuFilterDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    skuFilterDrop.classList.remove('drag');
    if (e.dataTransfer.files[0]) loadSkuFilterFile(e.dataTransfer.files[0]);
  });
  skuFilterFileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadSkuFilterFile(e.target.files[0]);
  });
  function loadSkuFilterFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      skuFilterTextarea.value = reader.result;
      refreshSkuFilterCount();
    };
    reader.readAsText(file);
  }

  function updateSkuFilterBtnLabel() {
    skuFilterBtn.innerHTML = skuFilterSet
      ? `<i class="bi bi-list-check me-1"></i>SKU list (${skuFilterSet.size})`
      : `<i class="bi bi-list-check me-1"></i>Filter by SKU list`;
    skuFilterBtn.classList.toggle('active', !!skuFilterSet);
  }

  skuFilterBtn.addEventListener('click', () => { skuFilterModal && skuFilterModal.show(); });

  skuFilterApplyBtn.addEventListener('click', () => {
    const skus = parseSkuLines(skuFilterTextarea.value);
    skuFilterSet = skus.length > 0 ? new Set(skus) : null;
    updateSkuFilterBtnLabel();
    currentPage = 1;
    renderPage();
  });

  skuFilterClearBtn.addEventListener('click', () => {
    skuFilterSet = null;
    skuFilterTextarea.value = '';
    refreshSkuFilterCount();
    updateSkuFilterBtnLabel();
    currentPage = 1;
    renderPage();
    skuFilterModal && skuFilterModal.hide();
  });

  // ---------- product detail modal (carousel + description + extras) ----------

  resultsBody.addEventListener('click', (e) => {
    const el = e.target.closest('[data-product-idx]');
    if (!el) return;
    const product = productLookup[Number(el.dataset.productIdx)];
    if (product) BhunesProductModal.open(product);
  });

  downloadCsvBtn.addEventListener('click', () => {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date(run.ts);
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    // Exports whatever's currently visible — tab, search, and the
    // SKU-list filter all narrow this down — not the full run, so
    // filtering by a SKU list and downloading gives you a CSV of just
    // those products, not the whole scrape.
    const filteredResults = filteredRows().map((row) => row.csvResult);
    const prefix = isStoreScrape ? 'store-catalog' : 'bhunes-stock';
    BhunesCsv.download(filteredResults, `${prefix}-${stamp}.csv`);
  });

  if (checkQtyBtn) {
    checkQtyBtn.addEventListener('click', () => {
      // Sends whatever's currently visible — respecting the active
      // tab and search filter — so a 3000-product catalog scrape
      // doesn't turn into a 3000-SKU batch check by default. Narrow it
      // down first (filter, or the "SKUs found" tab), then send.
      const skus = [...new Set(
        filteredRows().map((row) => row.sku).filter(Boolean)
      )];
      if (skus.length === 0) {
        checkQtyBtn.disabled = true;
        checkQtyBtn.innerHTML = 'No SKUs in current view';
        setTimeout(() => {
          checkQtyBtn.disabled = false;
          checkQtyBtn.innerHTML = '<i class="bi bi-lightning-charge me-1"></i>Check Exact Quantities';
        }, 2000);
        return;
      }
      BhunesHandoff.send({ skus, storeUrl: run.storeUrl || 'https://bhunes.com' });
      window.location.href = '/batch-check.html';
    });
  }

  render();
})();
