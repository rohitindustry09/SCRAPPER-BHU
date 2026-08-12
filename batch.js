/**
 * bhunes-batch-scraper
 * -----------------------------------------------------------
 * Batch version of scraper.js: reads a list of SKUs from a file,
 * scrapes all of them (reusing scraper.js's cache -> GraphQL ->
 * predictive-search -> HTML fallback chain), then:
 *
 *   1. Prints a colorful summary: "X SKU Scrapped successfully"
 *      (plus how many were found vs not found).
 *   2. Walks through the results one SKU at a time, showing
 *      SKU / Product Name / Product Link, and asks
 *      "Open in browser? (Y/n)" — Enter or Y opens it, n skips.
 *   3. If a SKU matched more than one product, that SKU is
 *      highlighted and you pick which product to open, then get
 *      asked whether to open the other match(es) too.
 *   4. Writes a CSV with every SKU's full scraped data.
 *
 * Usage:
 *   node batch.js                     // uses ./skus.txt by default
 *   node batch.js my-skus.txt
 *   node batch.js my-skus.txt --auto              // skip interactive review
 *   node batch.js my-skus.txt --out=results.csv
 *   node batch.js my-skus.txt --delay=400         // ms between lookups
 *   node batch.js my-skus.txt --verbose
 *   node batch.js my-skus.txt --no-cache
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');
const boxen = require('boxen');
const cliProgress = require('cli-progress');

const { searchBySku, buildSearchUrl, sleep } = require('./scraper');

// ------------------------------------------------------------------
// CLI args
// ------------------------------------------------------------------

function parseArgs(argv) {
  const args = { positional: [], flags: {} };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [key, value] = a.slice(2).split('=');
      args.flags[key] = value === undefined ? true : value;
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

const { positional, flags } = parseArgs(process.argv.slice(2));

const INPUT_FILE = positional[0] || path.join(__dirname, 'skus.txt');
const OUTPUT_CSV = flags.out || `bhunes-stock-${dateStamp()}.csv`;
const AUTO_MODE = Boolean(flags.auto); // skip interactive review entirely
const VERBOSE = Boolean(flags.verbose);
const USE_CACHE = !flags['no-cache'];
const DELAY_MS = Number(flags.delay) || 350; // throttle between network lookups
const CONCURRENCY = Number(flags.concurrency) || 1; // parallel SKU lookups
const FAST_MODE = Boolean(flags.fast); // give up immediately on 429 instead of waiting
const SKIP_HTML = Boolean(flags['skip-html']); // never fall through to the slow HTML layer

function dateStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}`;
}

// ------------------------------------------------------------------
// Loading & de-duplicating the SKU list
// ------------------------------------------------------------------

function loadSkus(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`✖ Input file not found: ${filePath}`));
    console.error(chalk.gray('  Usage: node batch.js <sku-list-file.txt>'));
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const seen = new Map(); // uppercased -> original-cased first occurrence
  const duplicates = [];

  for (const line of lines) {
    const key = line.toUpperCase();
    if (seen.has(key)) {
      duplicates.push(line);
    } else {
      seen.set(key, line);
    }
  }

  return {
    skus: [...seen.values()],
    totalLines: lines.length,
    duplicateCount: duplicates.length,
  };
}

// ------------------------------------------------------------------
// Readline prompt helper
// ------------------------------------------------------------------

let rl;
function getRl() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

function ask(question) {
  return new Promise((resolve) => getRl().question(question, resolve));
}

async function openInBrowser(url) {
  try {
    const open = (await import('open')).default;
    await open(url);
    return true;
  } catch (err) {
    console.log(chalk.yellow(`  Couldn't launch a browser automatically (${err.message}).`));
    console.log(chalk.yellow(`  Copy this URL manually: ${url}`));
    return false;
  }
}

// ------------------------------------------------------------------
// Scrape phase
// ------------------------------------------------------------------

async function scrapeAll(skus) {
  const results = new Array(skus.length);

  const bar = VERBOSE
    ? null
    : new cliProgress.SingleBar(
        {
          format:
            chalk.cyan('Scraping') +
            ' |' +
            chalk.cyan('{bar}') +
            '| {percentage}% | {value}/{total} | {sku}',
          hideCursor: true,
          clearOnComplete: false,
        },
        cliProgress.Presets.shades_classic
      );

  if (bar) bar.start(skus.length, 0, { sku: '' });

  let nextIndex = 0;
  let completed = 0;

  const searchOptions = {
    useCache: USE_CACHE,
    verbose: VERBOSE,
    // --fast: give up immediately on a 429/5xx instead of waiting out
    // Shopify's retry-after window (trades completeness for speed).
    htmlRetryOpts: FAST_MODE ? { retries: 0 } : {},
    // --skip-html: never even attempt the slow/rate-limited HTML page;
    // a SKU only GraphQL and predictive search couldn't find is reported
    // as not found rather than falling through to it.
    skipHtmlLayer: SKIP_HTML,
  };

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= skus.length) return;
      const sku = skus[i];

      if (VERBOSE) console.log(chalk.gray(`\n[${i + 1}/${skus.length}] Scraping ${sku}...`));

      let result;
      try {
        const r = await searchBySku(sku, searchOptions);
        result = { sku, ...r, error: null };
      } catch (err) {
        result = { sku, count: 0, products: [], source: null, timingMs: 0, error: err.message };
      }

      results[i] = result;
      completed++;
      if (bar) bar.update(completed, { sku });

      // Cache hits are instant and don't touch the network at all —
      // no reason to throttle those. Only pace actual network lookups.
      if (DELAY_MS > 0 && result.source !== 'cache' && completed < skus.length) {
        await sleep(DELAY_MS);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(CONCURRENCY, skus.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (bar) bar.stop();
  return results;
}

// ------------------------------------------------------------------
// Summary panel
// ------------------------------------------------------------------

function printSummary(results, meta) {
  const found = results.filter((r) => r.count > 0).length;
  const notFound = results.filter((r) => r.count === 0 && !r.error).length;
  const errored = results.filter((r) => r.error).length;
  const multiMatch = results.filter((r) => r.count > 1).length;

  const lines = [
    chalk.bold.white(`${results.length} SKU Scrapped successfully`),
    '',
    chalk.green(`✔ Found:        ${found}`),
    chalk.yellow(`⚠ Multi-match:  ${multiMatch}`),
    chalk.red(`✖ Not found:    ${notFound}`),
    errored ? chalk.red(`✖ Errors:       ${errored}`) : null,
  ].filter(Boolean);

  if (meta.duplicateCount > 0) {
    lines.push('');
    lines.push(chalk.gray(`(${meta.duplicateCount} duplicate SKU(s) in input skipped)`));
  }

  console.log(
    '\n' +
      boxen(lines.join('\n'), {
        padding: 1,
        margin: 1,
        borderColor: errored ? 'red' : multiMatch ? 'yellow' : 'green',
        borderStyle: 'round',
        title: '📦 Batch Scrape Complete',
        titleAlignment: 'center',
      })
  );
}

// ------------------------------------------------------------------
// CSV export
// ------------------------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvRows(results) {
  const columns = [
    'SKU',
    'MatchCount',
    'MatchIndex',
    'ProductTitle',
    'Price',
    'CompareAtPrice',
    'InStock',
    'StockQuantity',
    'LowStockWarning',
    'ProductURL',
    'Source',
    'Unverified',
    'Status',
    'Error',
  ];

  const rows = [columns];

  for (const r of results) {
    if (r.error) {
      rows.push([
        r.sku,
        0,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        buildSearchUrl(r.sku),
        '',
        '',
        'ERROR',
        r.error,
      ]);
      continue;
    }

    if (r.count === 0) {
      rows.push([
        r.sku,
        0,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        buildSearchUrl(r.sku),
        r.source || '',
        '',
        'NOT FOUND',
        '',
      ]);
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
        p.inStock === null ? '' : p.inStock,
        p.stockQuantity ?? '',
        p.lowStockWarning ? 'YES' : '',
        p.url,
        r.source || '',
        p.unverified ? 'YES' : '',
        'FOUND',
        '',
      ]);
    });
  }

  return rows;
}

function writeCsv(results, outPath) {
  const rows = buildCsvRows(results);
  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  fs.writeFileSync(outPath, csv, 'utf8');
  return outPath;
}

// ------------------------------------------------------------------
// Interactive review phase
// ------------------------------------------------------------------

function formatStockLine(p) {
  if (typeof p.stockQuantity === 'number') {
    const base = `${p.stockQuantity} available`;
    return p.lowStockWarning
      ? chalk.yellow.bold(`⚠ ${base} — low stock!`)
      : chalk.green(base);
  }
  if (p.inStock === true) return chalk.green('In stock') + chalk.gray(' (exact qty not exposed)');
  if (p.inStock === false) return chalk.red('Out of stock');
  return chalk.gray('Unknown');
}

function printProductBlock(p, indexLabel) {
  const label = indexLabel ? chalk.bold(`  ${indexLabel}. `) : '  ';
  console.log(`${label}${chalk.white(p.title)}${p.unverified ? chalk.red('  [UNVERIFIED]') : ''}`);
  console.log(`     Price: ${p.price != null ? chalk.white('Rs. ' + p.price) : chalk.gray('N/A')}`);
  console.log(`     Stock: ${formatStockLine(p)}`);
  console.log(`     URL:   ${chalk.underline.blue(p.url)}`);
}

/**
 * Handles the single-match case: show it, ask Y/n to open.
 * Returns 'quit' if the user wants to stop the whole review early,
 * otherwise undefined.
 */
async function reviewSingleMatch(record, state) {
  const p = record.products[0];
  printProductBlock(p);

  if (state.autoOpenAll) {
    console.log(chalk.gray('  (auto-open enabled — opening automatically)'));
    await openInBrowser(p.url);
    return;
  }

  const answer = (await ask(chalk.cyan('  Open in browser? [Y/n/a=open all remaining/q=quit review]: ')))
    .trim()
    .toLowerCase();

  if (answer === 'q') return 'quit';
  if (answer === 'a') {
    state.autoOpenAll = true;
    await openInBrowser(p.url);
    return;
  }
  if (answer === '' || answer === 'y' || answer === 'yes') {
    await openInBrowser(p.url);
  }
  // 'n'/anything else: skip
}

/**
 * Handles the multi-match case: highlight it, let the user pick
 * which product to open, then ask if they want to open the others too.
 * Returns 'quit' if the user wants to stop the whole review early.
 */
async function reviewMultiMatch(record, state) {
  console.log(
    chalk.bgYellow.black.bold(
      `  ⚠ ${record.products.length} PRODUCTS MATCHED THIS SKU — please confirm which one you want  `
    )
  );

  record.products.forEach((p, idx) => printProductBlock(p, idx + 1));

  const opened = new Set();

  while (opened.size < record.products.length) {
    const remaining = record.products
      .map((_, idx) => idx)
      .filter((idx) => !opened.has(idx));

    const prompt =
      remaining.length === record.products.length
        ? chalk.cyan(`  Select product to open [1-${record.products.length}] (s=skip, q=quit review): `)
        : chalk.cyan(
            `  Open another match too? [${remaining.map((i) => i + 1).join(',')}] (n=no, q=quit review): `
          );

    const answer = (await ask(prompt)).trim().toLowerCase();

    if (answer === 'q') return 'quit';
    if (answer === 's' || answer === 'n' || answer === '') {
      // On the very first prompt, blank/s means skip entirely.
      // On follow-up prompts, blank/n means "no more".
      break;
    }

    const choice = parseInt(answer, 10);
    if (Number.isNaN(choice) || choice < 1 || choice > record.products.length) {
      console.log(chalk.red('  Not a valid option, try again.'));
      continue;
    }

    const idx = choice - 1;
    if (opened.has(idx)) {
      console.log(chalk.gray('  Already opened that one.'));
      continue;
    }

    await openInBrowser(record.products[idx].url);
    opened.add(idx);

    if (opened.size === record.products.length) break;
  }
}

async function interactiveReview(results) {
  const matched = results.filter((r) => r.count > 0);

  if (matched.length === 0) {
    console.log(chalk.yellow('\nNo matched SKUs to review.'));
    return;
  }

  console.log(
    chalk.bold(
      `\nReviewing ${matched.length} matched SKU(s). Press Enter/Y to open, n to skip, q to quit review at any time.\n`
    )
  );

  const state = { autoOpenAll: false };

  for (let i = 0; i < matched.length; i++) {
    const record = matched[i];
    console.log(chalk.gray('─'.repeat(60)));
    console.log(
      chalk.bold.cyan(`SKU: ${record.sku}`) +
        chalk.gray(`  (${i + 1}/${matched.length}, via ${record.source}, ${record.timingMs}ms)`)
    );

    const outcome =
      record.count === 1
        ? await reviewSingleMatch(record, state)
        : await reviewMultiMatch(record, state);

    if (outcome === 'quit') {
      console.log(chalk.yellow(`\nStopped review early. (${matched.length - i - 1} SKU(s) skipped — CSV already saved.)`));
      break;
    }
  }

  console.log(chalk.gray('─'.repeat(60)));
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main() {
  console.log(
    boxen(chalk.bold.white('Bhunes Batch SKU Scraper'), {
      padding: 1,
      borderColor: 'cyan',
      borderStyle: 'round',
    })
  );

  const { skus, totalLines, duplicateCount } = loadSkus(INPUT_FILE);

  console.log(chalk.gray(`Input file: ${INPUT_FILE}`));
  console.log(chalk.gray(`${totalLines} line(s) read, ${skus.length} unique SKU(s) to scrape.`));
  if (duplicateCount > 0) {
    console.log(chalk.gray(`(${duplicateCount} duplicate line(s) skipped)`));
  }
  console.log('');

  const results = await scrapeAll(skus);

  printSummary(results, { duplicateCount });

  const csvPath = writeCsv(results, OUTPUT_CSV);
  console.log(chalk.green(`✔ CSV saved: `) + chalk.underline(csvPath));

  if (!AUTO_MODE) {
    await interactiveReview(results);
  } else {
    console.log(chalk.gray('\n--auto flag set, skipping interactive review.'));
  }

  if (rl) rl.close();
  console.log(chalk.bold.green('\nDone.\n'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(chalk.red('\nBatch run failed:'), err);
    if (rl) rl.close();
    process.exit(1);
  });
}

module.exports = {
  loadSkus,
  buildCsvRows,
  writeCsv,
  csvEscape,
};