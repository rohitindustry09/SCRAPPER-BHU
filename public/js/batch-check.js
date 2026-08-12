(function () {
  const $ = (id) => document.getElementById(id);

  const siteInput = $('siteInput');
  const tabType = $('tabType'), tabFile = $('tabFile');
  const paneType = $('paneType'), paneFile = $('paneFile');
  const skuTextarea = $('skuTextarea');
  const fileDrop = $('fileDrop'), fileInput = $('fileInput');
  const countPill = $('countPill');
  const loadDefaultBtn = $('loadDefaultBtn');
  const runBatchBtn = $('runBatchBtn');
  const errorBanner = $('errorBanner');
  const concurrencyInput = $('concurrencyInput');
  const delayInput = $('delayInput');
  const noCacheCheck = $('noCacheCheck');

  const progressWrap = $('progressWrap');
  const progressLabel = $('progressLabel');
  const progressPct = $('progressPct');
  const progressBar = $('progressBar');

  const livePanel = $('livePanel');
  const liveBody = $('liveBody');
  const liveStats = $('liveStats');
  const liveDot = $('liveDot');
  const liveCountText = $('liveCountText');
  const liveViewAllBtn = $('liveViewAllBtn');
  const liveCsvBtn = $('liveCsvBtn');

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

  function parseSkuLines(text) {
    return [...new Set(
      text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.toUpperCase())
    )];
  }

  function refreshCount() {
    const n = parseSkuLines(skuTextarea.value).length;
    countPill.innerHTML = `<i class="bi bi-list-ol"></i>${n} SKU${n === 1 ? '' : 's'} ready`;
  }
  skuTextarea.addEventListener('input', refreshCount);

  // ---------- source tabs ----------

  function setMode(mode) {
    const isType = mode === 'type';
    tabType.classList.toggle('active', isType);
    tabFile.classList.toggle('active', !isType);
    paneType.style.display = isType ? '' : 'none';
    paneFile.style.display = isType ? 'none' : '';
  }
  tabType.addEventListener('click', () => setMode('type'));
  tabFile.addEventListener('click', () => setMode('file'));

  fileDrop.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.classList.add('drag'); });
  fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag'));
  fileDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDrop.classList.remove('drag');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      skuTextarea.value = reader.result;
      refreshCount();
      setMode('type');
    };
    reader.onerror = () => showError(`Couldn't read "${file.name}".`);
    reader.readAsText(file);
  }

  // ---------- default list ----------

  loadDefaultBtn.addEventListener('click', async () => {
    clearError();
    loadDefaultBtn.disabled = true;
    loadDefaultBtn.innerHTML = '<span class="spinner-robotik" style="border-top-color:var(--accent); border-color:rgba(67,217,255,0.25);"></span>Loading…';
    try {
      const data = await BhunesAPI.defaultSkus();
      skuTextarea.value = data.skus.join('\n');
      refreshCount();
      setMode('type');
      loadDefaultBtn.innerHTML = `<i class="bi bi-check2 me-1"></i>Loaded ${data.count} from ${data.filename}`;
      setTimeout(() => { loadDefaultBtn.innerHTML = '<i class="bi bi-file-earmark-arrow-down me-1"></i>Use default list (my-skus.txt)'; }, 3000);
    } catch (err) {
      showError(err.message);
      loadDefaultBtn.innerHTML = '<i class="bi bi-file-earmark-arrow-down me-1"></i>Use default list (my-skus.txt)';
    } finally {
      loadDefaultBtn.disabled = false;
    }
  });

  // ---------- recent runs ledger ----------

  function renderRuns() {
    const entries = BhunesHistory.byType('batch');
    if (entries.length === 0) {
      runsBody.innerHTML = '';
      runsEmpty.classList.remove('d-none');
      return;
    }
    runsEmpty.classList.add('d-none');

    runsBody.innerHTML = entries.map((e) => `
      <tr>
        <td class="text-faint font-mono">${BhunesFmt.relativeTime(e.ts)}</td>
        <td class="font-mono">${e.skuCount}</td>
        <td class="text-accent fw-semibold">${e.found}</td>
        <td>${e.notFound}</td>
        <td>${e.errored ? `<span class="stamp stamp-out">${e.errored}</span>` : '<span class="text-faint">0</span>'}</td>
        <td>${e.runId
          ? `<a href="/batch-results.html?run=${encodeURIComponent(e.runId)}" class="btn btn-outline-robotik btn-sm-pill">View <i class="bi bi-arrow-right ms-1"></i></a>`
          : '<span class="text-faint small">expired</span>'}</td>
      </tr>
    `).join('');
  }
  clearRunsBtn.addEventListener('click', () => {
    BhunesHistory.clear('batch');
    BhunesRuns.clear();
    renderRuns();
  });

  // ---------- live results feed ----------
  // Every completed SKU is prepended so the newest check is always at
  // the top without scrolling. productLookup mirrors batch-results.js
  // so the same shared product modal can be opened from these rows.

  const liveProducts = [];
  let liveSerial = 0;
  const liveTally = { found: 0, notFound: 0, errored: 0 };
  // Full result set of the last completed run, kept so the panel's own
  // CSV button can export without a trip to the results page.
  let liveCsvResults = null;

  function resetLive(total) {
    liveBody.innerHTML = '';
    liveProducts.length = 0;
    liveSerial = 0;
    liveTally.found = 0;
    liveTally.notFound = 0;
    liveTally.errored = 0;
    liveViewAllBtn.classList.add('d-none');
    liveCsvBtn.classList.add('d-none');
    liveDot.classList.remove('online', 'offline');
    liveDot.classList.add('pending');
    liveCountText.textContent = `0 / ${total} checked`;
    livePanel.classList.remove('d-none');
    renderLiveStats();
  }

  function renderLiveStats() {
    liveStats.innerHTML = `
      <div class="stat-tile ok"><div class="num">${liveTally.found}</div><div class="lbl">Found</div></div>
      <div class="stat-tile danger"><div class="num">${liveTally.notFound}</div><div class="lbl">Not found</div></div>
      ${liveTally.errored ? `<div class="stat-tile danger"><div class="num">${liveTally.errored}</div><div class="lbl">Errors</div></div>` : ''}
    `;
  }

  function appendLiveRow(result) {
    liveSerial += 1;

    if (result.error) {
      liveTally.errored += 1;
      liveBody.insertAdjacentHTML('afterbegin', `
        <tr class="row-notfound">
          <td class="hide-sm serial-cell">${liveSerial}</td>
          <td class="sku-cell">${BhunesFmt.escapeHtml(result.sku)}</td>
          <td colspan="4">Error: ${BhunesFmt.escapeHtml(result.error)}</td>
        </tr>`);
    } else if (result.count === 0) {
      liveTally.notFound += 1;
      liveBody.insertAdjacentHTML('afterbegin', `
        <tr class="row-notfound">
          <td class="hide-sm serial-cell">${liveSerial}</td>
          <td class="sku-cell">${BhunesFmt.escapeHtml(result.sku)}</td>
          <td colspan="4">Not found</td>
        </tr>`);
    } else {
      liveTally.found += 1;
      const p = result.products[0];
      const idx = liveProducts.length;
      liveProducts.push({ ...p, sku: p.sku || result.sku, source: result.source, timingMs: result.timingMs });

      const thumb = p.image
        ? `<img src="${p.image}" alt="" loading="lazy" class="result-thumb result-thumb-clickable" data-live-idx="${idx}"
             onerror="this.outerHTML='<span class=&quot;result-thumb result-thumb-empty&quot; data-live-idx=&quot;${idx}&quot;><i class=&quot;bi bi-image&quot;></i></span>'">`
        : `<span class="result-thumb result-thumb-empty" data-live-idx="${idx}" style="cursor:pointer"><i class="bi bi-image"></i></span>`;

      liveBody.insertAdjacentHTML('afterbegin', `
        <tr>
          <td class="hide-sm serial-cell">${liveSerial}</td>
          <td class="sku-cell">${BhunesFmt.escapeHtml(result.sku)}</td>
          <td>
            <div class="d-flex align-items-center gap-3">
              ${thumb}
              <a href="${p.url}" target="_blank" rel="noopener" style="max-width:280px;">${BhunesFmt.escapeHtml(p.title)}</a>
            </div>
          </td>
          <td class="price-cell">${BhunesFmt.price(p)}</td>
          <td>${BhunesFmt.stamp(p)}</td>
          <td>
            <div class="d-flex gap-2 flex-nowrap">
              <button type="button" class="btn btn-outline-robotik btn-sm-pill" data-live-idx="${idx}"><i class="bi bi-images me-1"></i>Details</button>
              <a href="${p.url}" target="_blank" rel="noopener" class="btn btn-outline-robotik btn-sm-pill">Open <i class="bi bi-box-arrow-up-right ms-1"></i></a>
            </div>
          </td>
        </tr>`);
    }

    renderLiveStats();
  }

  liveBody.addEventListener('click', (e) => {
    const el = e.target.closest('[data-live-idx]');
    if (!el) return;
    const product = liveProducts[Number(el.dataset.liveIdx)];
    if (product) BhunesProductModal.open(product);
  });

  liveCsvBtn.addEventListener('click', () => {
    if (!liveCsvResults) return;
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    BhunesCsv.download(liveCsvResults, `bhunes-stock-${stamp}.csv`);
  });

  // ---------- batch run ----------

  function setProgress(completed, total) {
    const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
    progressLabel.textContent = `Checking ${completed} / ${total}…`;
    progressPct.textContent = `${pct}%`;
    progressBar.style.width = `${pct}%`;
  }

  runBatchBtn.addEventListener('click', async () => {
    clearError();
    const skus = parseSkuLines(skuTextarea.value);

    if (skus.length === 0) { showError('Add at least one SKU — type some in, upload a .txt file, or load the default list.'); return; }

    const site = siteInput.value.trim();
    const noCache = noCacheCheck.checked;

    runBatchBtn.disabled = true;
    runBatchBtn.innerHTML = '<span class="spinner-robotik"></span>Starting…';
    progressWrap.classList.remove('d-none');
    setProgress(0, skus.length);
    resetLive(skus.length);

    try {
      const { results, summary } = await BhunesAPI.batchStreamed(
        skus,
        { noCache, site: site || undefined },
        {
          concurrency: Number(concurrencyInput.value) || 3,
          delayMs: Number(delayInput.value) || 350,
          onResult: (result, completed, total) => {
            appendLiveRow(result);
            setProgress(completed, total);
            liveCountText.textContent = `${completed} / ${total} checked`;
            runBatchBtn.innerHTML = `<span class="spinner-robotik"></span>Checking ${completed} / ${total}…`;
          },
        }
      );

      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      BhunesRuns.save({
        id: runId,
        ts: Date.now(),
        skus,
        storeUrl: site || 'https://bhunes.com',
        options: { noCache },
        summary,
        results,
      });
      BhunesHistory.add({
        type: 'batch',
        runId,
        skuCount: skus.length,
        found: summary.found,
        notFound: summary.notFound,
        errored: summary.errored,
      });

      // Deliberately no auto-redirect any more: the live feed above is
      // the point of the run, and yanking the page away the moment it
      // finishes would hide it. The full results page (filters, SKU-list
      // filter, CSV export) is one click away instead.
      liveDot.classList.remove('pending');
      liveDot.classList.add('online');
      liveViewAllBtn.href = `/batch-results.html?run=${encodeURIComponent(runId)}`;
      liveViewAllBtn.classList.remove('d-none');
      liveCsvResults = results;
      liveCsvBtn.classList.remove('d-none');
      renderRuns();
    } catch (err) {
      showError(err.message);
      liveDot.classList.remove('pending');
      liveDot.classList.add('offline');
      renderRuns();
    } finally {
      runBatchBtn.disabled = false;
      runBatchBtn.innerHTML = '<i class="bi bi-play-fill me-1"></i>Run batch check';
      progressWrap.classList.add('d-none');
    }
  });

  // ---------- incoming handoff from Scrape Store ----------

  const handoff = BhunesHandoff.take();
  if (handoff && Array.isArray(handoff.skus) && handoff.skus.length > 0) {
    skuTextarea.value = handoff.skus.join('\n');
    if (handoff.storeUrl) siteInput.value = handoff.storeUrl;
    setMode('type');
    loadDefaultBtn.innerHTML = `<i class="bi bi-check2 me-1"></i>Loaded ${handoff.skus.length} SKUs from your last store scrape`;
  }

  refreshCount();
  renderRuns();
})();
