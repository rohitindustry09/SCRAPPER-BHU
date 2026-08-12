/* Shared "product detail" modal: image carousel, description, and an
   optional manual paste-in for dimension/weight tables that aren't
   available from any of the scraper's data sources. Injects its own
   markup into <body> on first use, so any page just needs this script
   (plus api.js and the Bootstrap JS bundle) to call
   BhunesProductModal.open(product). */
const BhunesProductModal = (() => {
  let modalEl, bsModal;
  let titleEl, skuEl, priceEl, stockEl, metaEl, descEl, linkEl;
  let carouselInner, carouselIndicators;
  let extraCheck, extraWrap, extraTextarea, extraTable;

  function ensureModal() {
    if (modalEl) return;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="modal fade" id="productDetailModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content modal-robotik">
            <div class="modal-header">
              <div>
                <h5 class="modal-title mb-0" id="pdmTitle"></h5>
                <span class="font-mono small text-faint" id="pdmSku"></span>
              </div>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <div class="row g-4">
                <div class="col-md-5">
                  <div id="pdmCarousel" class="carousel slide pdm-carousel">
                    <div class="carousel-indicators" id="pdmIndicators"></div>
                    <div class="carousel-inner" id="pdmInner"></div>
                    <button class="carousel-control-prev" type="button" data-bs-target="#pdmCarousel" data-bs-slide="prev">
                      <span class="carousel-control-prev-icon" aria-hidden="true"></span>
                    </button>
                    <button class="carousel-control-next" type="button" data-bs-target="#pdmCarousel" data-bs-slide="next">
                      <span class="carousel-control-next-icon" aria-hidden="true"></span>
                    </button>
                  </div>
                </div>
                <div class="col-md-7">
                  <div class="d-flex align-items-center gap-3 flex-wrap mb-2">
                    <span class="price-cell fs-5" id="pdmPrice"></span>
                    <span id="pdmStock"></span>
                  </div>
                  <p class="text-faint font-mono small mb-3 d-none" id="pdmMeta"></p>
                  <p class="text-dim small mb-4" id="pdmDescription"></p>
                  <a href="#" target="_blank" rel="noopener" class="btn btn-outline-robotik mb-4" id="pdmLink">Open product <i class="bi bi-box-arrow-up-right ms-1"></i></a>

                  <div class="divider-glow mb-3"></div>

                  <div class="form-check mb-2">
                    <input class="form-check-input" type="checkbox" id="pdmExtraCheck">
                    <label class="form-check-label small" for="pdmExtraCheck">Add extra details (height, weight, etc.)</label>
                  </div>
                  <div class="d-none" id="pdmExtraWrap">
                    <p class="text-faint small mb-2">Not something the scraper collects — paste the dimensions table's HTML from the product page (copy it via your browser's DevTools) and it'll be parsed below.</p>
                    <textarea class="form-control font-mono small mb-3" id="pdmExtraTextarea" rows="4" placeholder="&lt;div class=&quot;product-dimensions-table&quot;&gt;...&lt;/div&gt;"></textarea>
                    <div id="pdmExtraTable"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrapper.firstElementChild);

    modalEl = document.getElementById('productDetailModal');
    bsModal = new bootstrap.Modal(modalEl);
    titleEl = document.getElementById('pdmTitle');
    skuEl = document.getElementById('pdmSku');
    priceEl = document.getElementById('pdmPrice');
    stockEl = document.getElementById('pdmStock');
    metaEl = document.getElementById('pdmMeta');
    descEl = document.getElementById('pdmDescription');
    linkEl = document.getElementById('pdmLink');
    carouselInner = document.getElementById('pdmInner');
    carouselIndicators = document.getElementById('pdmIndicators');
    extraCheck = document.getElementById('pdmExtraCheck');
    extraWrap = document.getElementById('pdmExtraWrap');
    extraTextarea = document.getElementById('pdmExtraTextarea');
    extraTable = document.getElementById('pdmExtraTable');

    extraCheck.addEventListener('change', () => {
      extraWrap.classList.toggle('d-none', !extraCheck.checked);
    });
    extraTextarea.addEventListener('input', () => renderExtraDetails(extraTextarea.value));

    modalEl.addEventListener('hidden.bs.modal', () => {
      // The pasted-in extras are a scratch area for whichever product
      // was open — clear them so they don't leak onto the next product.
      extraCheck.checked = false;
      extraWrap.classList.add('d-none');
      extraTextarea.value = '';
      extraTable.innerHTML = '';
    });
  }

  /**
   * Parses a pasted `.product-dimensions-table` HTML snippet (copied
   * from a live product page) into label/value rows. Only ever reads
   * `.textContent` from the parsed DOM — never re-inserts the pasted
   * markup itself — so arbitrary pasted HTML can't inject anything
   * into the page.
   */
  function renderExtraDetails(html) {
    extraTable.innerHTML = '';
    if (!html || !html.trim()) return;

    let rows = [];
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      rows = [...doc.querySelectorAll('.product-dimensions-table__row')];
    } catch {
      rows = [];
    }

    if (rows.length === 0) {
      extraTable.innerHTML = '<p class="text-faint small mb-0">No recognizable rows found in the pasted markup — expecting <code>.product-dimensions-table__row</code> elements.</p>';
      return;
    }

    const pairs = rows
      .map((row) => ({
        label: row.querySelector('.product-dimensions-table__label')?.textContent.trim() || '',
        value: row.querySelector('.product-dimensions-table__value')?.textContent.trim() || '',
      }))
      .filter((p) => p.label || p.value);

    extraTable.innerHTML = `
      <table class="table table-robotik table-sm mb-0">
        <tbody>
          ${pairs.map((p) => `<tr><td class="text-dim" style="width:40%;">${BhunesFmt.escapeHtml(p.label)}</td><td>${BhunesFmt.escapeHtml(p.value)}</td></tr>`).join('')}
        </tbody>
      </table>`;
  }

  function open(product) {
    ensureModal();

    const images = product.images && product.images.length > 0
      ? product.images
      : (product.image ? [product.image] : []);

    titleEl.textContent = product.title || 'Untitled product';
    skuEl.textContent = product.sku || '';
    priceEl.innerHTML = BhunesFmt.price(product);
    stockEl.innerHTML = BhunesFmt.stamp(product);
    descEl.textContent = product.description || 'No description available for this product.';
    linkEl.href = product.url || '#';

    if (product.source) {
      metaEl.textContent = typeof product.timingMs === 'number' && product.timingMs > 0
        ? `via ${product.source}, ${product.timingMs}ms`
        : `via ${product.source}`;
      metaEl.classList.remove('d-none');
    } else {
      metaEl.classList.add('d-none');
    }

    carouselInner.innerHTML = images.length > 0
      ? images.map((src, i) => `
          <div class="carousel-item ${i === 0 ? 'active' : ''}">
            <img src="${src}" class="d-block w-100 pdm-carousel-img" alt="" loading="lazy">
          </div>`).join('')
      : `<div class="carousel-item active"><div class="pdm-carousel-empty"><i class="bi bi-image"></i></div></div>`;

    carouselIndicators.innerHTML = images.length > 1
      ? images.map((_, i) => `<button type="button" data-bs-target="#pdmCarousel" data-bs-slide-to="${i}" class="${i === 0 ? 'active' : ''}" aria-current="${i === 0}"></button>`).join('')
      : '';

    bsModal.show();
  }

  return { open };
})();
