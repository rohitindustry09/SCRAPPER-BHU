(function () {
  const $ = (id) => document.getElementById(id);

  const siteInput = $('siteInput');
  const quickSku = $('quickSku');
  const quickSearchBtn = $('quickSearchBtn');
  const quickResult = $('quickResult');
  const noCacheCheck = $('noCacheCheck');
  const errorBanner = $('errorBanner');
  const historyBody = $('historyBody');
  const historyEmpty = $('historyEmpty');
  const clearHistoryBtn = $('clearHistoryBtn');

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove('d-none');
  }
  function clearError() {
    errorBanner.classList.add('d-none');
    errorBanner.textContent = '';
  }

  function renderHistory() {
    const entries = BhunesHistory.byType('single');
    if (entries.length === 0) {
      historyBody.innerHTML = '';
      historyEmpty.classList.remove('d-none');
      return;
    }
    historyEmpty.classList.add('d-none');

    historyBody.innerHTML = entries.map((e) => {
      const when = `<span class="text-faint font-mono">${BhunesFmt.relativeTime(e.ts)}</span>`;
      const sku = `<span class="sku-cell">${BhunesFmt.escapeHtml(e.sku)}</span>`;

      if (e.error) {
        return `<tr class="row-notfound">
          <td>${when}</td><td>${sku}</td>
          <td colspan="5">Error: ${BhunesFmt.escapeHtml(e.error)}</td>
        </tr>`;
      }
      if (e.count === 0) {
        return `<tr class="row-notfound">
          <td>${when}</td><td>${sku}</td>
          <td colspan="5">Not found</td>
        </tr>`;
      }
      const p = e.product;
      return `<tr>
        <td>${when}</td>
        <td>${sku}</td>
        <td>${BhunesFmt.escapeHtml(p.title)}</td>
        <td class="price-cell">${BhunesFmt.price(p)}</td>
        <td>${BhunesFmt.stamp(p)}</td>
        <td class="text-faint font-mono small">${BhunesFmt.escapeHtml(e.source)}</td>
        <td class="hide-sm"><a href="${p.url}" target="_blank" rel="noopener">Open <i class="bi bi-box-arrow-up-right"></i></a></td>
      </tr>`;
    }).join('');
  }

  let quickProducts = [];

  function renderQuickResult(sku, data) {
    if (data.count === 0) {
      quickProducts = [];
      quickResult.innerHTML = `
        <div class="empty-note text-start px-0 pt-4 pb-0">
          <i class="bi bi-search"></i>
          No product found for <strong class="text-light">${BhunesFmt.escapeHtml(sku)}</strong>.
          ${data.searchedUrl ? `<div class="mt-2"><a href="${data.searchedUrl}" target="_blank" rel="noopener">Search on bhunes.com <i class="bi bi-box-arrow-up-right"></i></a></div>` : ''}
        </div>`;
      return;
    }

    quickProducts = data.products.map((p) => ({ ...p, sku: p.sku || sku, source: data.source }));

    quickResult.innerHTML = `<div class="divider-glow my-4"></div>` + quickProducts.map((p, idx) => `
      <div class="d-flex gap-3 align-items-center flex-wrap py-2">
        ${p.image
          ? `<img src="${p.image}" alt="" width="64" height="64" data-quick-idx="${idx}" class="result-thumb-clickable" style="object-fit:cover;border-radius:10px;border:1px solid var(--border);cursor:zoom-in;">`
          : `<span class="result-thumb result-thumb-empty" data-quick-idx="${idx}" style="width:64px;height:64px;cursor:pointer;"><i class="bi bi-image"></i></span>`}
        <div class="flex-grow-1" style="min-width:220px;">
          <div class="fw-semibold mb-1">${BhunesFmt.escapeHtml(p.title)}</div>
          ${p.description ? `<p class="text-dim small description-cell mb-2" style="max-width:none;">${BhunesFmt.escapeHtml(p.description)}</p>` : ''}
          <div class="d-flex gap-3 align-items-center flex-wrap small">
            <span class="price-cell">${BhunesFmt.price(p)}</span>
            ${BhunesFmt.stamp(p)}
            <span class="text-faint font-mono">via ${BhunesFmt.escapeHtml(data.source)}, ${data.timingMs}ms</span>
          </div>
        </div>
        <div class="d-flex gap-2">
          <button class="btn btn-outline-robotik btn-sm-pill" data-quick-idx="${idx}"><i class="bi bi-images me-1"></i>Details</button>
          <a href="${p.url}" target="_blank" rel="noopener" class="btn btn-outline-robotik btn-sm-pill">Open <i class="bi bi-box-arrow-up-right ms-1"></i></a>
        </div>
      </div>
    `).join('');
  }

  quickResult.addEventListener('click', (e) => {
    const el = e.target.closest('[data-quick-idx]');
    if (!el) return;
    const product = quickProducts[Number(el.dataset.quickIdx)];
    if (product) BhunesProductModal.open(product);
  });

  async function runQuickSearch() {
    const sku = quickSku.value.trim();
    if (!sku) return;
    clearError();

    quickSearchBtn.disabled = true;
    quickSearchBtn.innerHTML = '<span class="spinner-robotik"></span>Searching…';
    quickResult.innerHTML = '';

    try {
      const site = siteInput.value.trim();
      const data = await BhunesAPI.search(sku, { noCache: noCacheCheck.checked, site: site || undefined });
      renderQuickResult(sku, data);
      BhunesHistory.add({
        type: 'single',
        sku,
        count: data.count,
        source: data.source,
        product: data.count > 0 ? data.products[0] : null,
        error: null,
      });
    } catch (err) {
      showError(err.message);
      BhunesHistory.add({ type: 'single', sku, count: 0, source: null, product: null, error: err.message });
    } finally {
      renderHistory();
      quickSearchBtn.disabled = false;
      quickSearchBtn.innerHTML = '<i class="bi bi-lightning-charge me-1"></i>Search';
    }
  }

  quickSearchBtn.addEventListener('click', runQuickSearch);
  quickSku.addEventListener('keydown', (e) => { if (e.key === 'Enter') runQuickSearch(); });
  clearHistoryBtn.addEventListener('click', () => { BhunesHistory.clear('single'); renderHistory(); });

  renderHistory();
})();
