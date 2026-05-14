/**
 * Scraper statystyk naboru – slaskie.edu.com.pl
 * Pobiera dane wszystkich szkół w Raciborzu i zapisuje do data/raciborz.json
 *
 * Użycie:
 *   node scraper.js [--city <kod>] [--headless false] [--out data/raciborz.json]
 *
 * Kody miast: Racibórz=0942469
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
}
const CITY_VALUE = getArg('city', '0942469');
const HEADLESS   = getArg('headless', 'true') !== 'false';
const OUT_FILE   = join(__dirname, getArg('out', 'data/raciborz.json'));
const URL        = 'https://slaskie.edu.com.pl/kandydat/app/candidates_statistics.xhtml';

// --- Helpers ---
function parseCount(str) {
  if (!str) return { confirmed: 0, unconfirmed: 0, total: 0 };
  const isRazem = str.includes('*');
  str = str.replace('*', '').trim();
  const m = str.match(/^(\d+)\((\d+)\)$/);
  if (m) {
    const c = parseInt(m[1]), u = parseInt(m[2]);
    return { confirmed: c, unconfirmed: u, total: c + u, isRazem };
  }
  const n = parseInt(str);
  return { confirmed: isNaN(n) ? 0 : n, unconfirmed: 0, total: isNaN(n) ? 0 : n, isRazem };
}

function extractSchoolName(fullName) {
  if (fullName.includes(' - RAZEM')) {
    return fullName.replace(/ - RAZEM$/, '').trim();
  }
  const idx = fullName.lastIndexOf(' - ');
  return idx > 0 ? fullName.substring(0, idx).trim() : fullName.trim();
}

function extractSection(fullName) {
  const idx = fullName.lastIndexOf(' - ');
  return idx > 0 ? fullName.substring(idx + 3).trim() : fullName.trim();
}

function buildSchools(rows) {
  const schools = {};
  for (const row of rows) {
    if (!row[0] || row[0] === 'Szkoła-oddział/grupa' || row[0] === 'Szkoła - oddział/grupa') continue;
    const fullName   = row[0].trim();
    const places     = parseInt(row[1]) || 0;
    const totalStr   = (row[2] || '0').trim();
    const firstStr   = (row[3] || '0(0)').trim();
    const isRazem    = fullName.includes(' - RAZEM') || fullName.endsWith('RAZEM');
    const schoolName = extractSchoolName(fullName);

    if (!schools[schoolName]) {
      schools[schoolName] = { name: schoolName, places: 0, classes: [], razem: null };
    }

    const t = parseCount(totalStr);
    const f = parseCount(firstStr);

    if (isRazem) {
      schools[schoolName].places = places;
      schools[schoolName].razem = {
        totalConfirmed: t.confirmed, totalUnconfirmed: t.unconfirmed, totalAll: t.total,
        firstConfirmed: f.confirmed, firstUnconfirmed: f.unconfirmed,
        totalStr, firstStr,
      };
    } else {
      schools[schoolName].classes.push({
        section: extractSection(fullName),
        places,
        totalConfirmed: t.confirmed, totalUnconfirmed: t.unconfirmed, totalAll: t.total,
        firstConfirmed: f.confirmed, firstUnconfirmed: f.unconfirmed,
        totalStr, firstStr,
      });
    }
  }
  // RAZEM row from the site only shows unique confirmed count ("10*") — no unconfirmed.
  // Compute it as sum of individual class rows.
  for (const school of Object.values(schools)) {
    if (school.razem) {
      const sumUnconf = school.classes.reduce((s, c) => s + (c.totalUnconfirmed || 0), 0);
      school.razem.totalUnconfirmed = sumUnconf;
      school.razem.totalAll = school.razem.totalConfirmed + sumUnconf;
    }
  }

  return schools;
}

async function waitForBlockUI(page, timeoutMs = 25000) {
  // PrimeFaces shows .blockUI overlay during AJAX — wait for it to disappear
  await page.waitForFunction(
    () => !document.querySelector('.blockUI') || document.querySelector('.blockUI').style.display === 'none',
    { timeout: timeoutMs }
  ).catch(() => null);
}

async function extractRows(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    let dataTable = null;
    for (const t of tables) {
      const headers = Array.from(t.querySelectorAll('th')).map(th => th.textContent.trim());
      if (headers.some(h => h.includes('Szko') || h.includes('Miejsc'))) {
        dataTable = t;
        break;
      }
    }
    if (!dataTable) return [];
    return Array.from(dataTable.querySelectorAll('tr')).map(tr =>
      Array.from(tr.querySelectorAll('td, th')).map(c => c.textContent.trim())
    ).filter(r => r.length >= 3);
  });
}

async function scrapeAllRows(page) {
  const allRows = [];
  let pageNum = 0;

  while (true) {
    pageNum++;
    process.stdout.write(`  Strona ${pageNum}... `);

    // Wait for blockUI overlay to clear and table to be present
    await waitForBlockUI(page);
    await page.waitForSelector('table', { timeout: 15000 }).catch(() => null);

    const rows = await extractRows(page);
    const dataRows = rows.filter(r => r[0] && r[0] !== 'Szkoła-oddział/grupa' && r[0] !== 'Szkoła - oddział/grupa');
    allRows.push(...rows);
    process.stdout.write(`${dataRows.length} wierszy danych\n`);

    // Find "Następna strona" — use exact input selector from PrimeFaces
    const nextBtn = page.locator('input[type="submit"][value="Następna strona"]').first();
    const hasNext = await nextBtn.count() > 0;
    if (!hasNext) break;

    // Ensure overlay is gone, then click
    await waitForBlockUI(page);
    await nextBtn.click();

    // Wait for AJAX overlay to appear (loading started) then disappear (loading done)
    await page.waitForSelector('.blockUI', { state: 'visible', timeout: 5000 }).catch(() => null);
    await waitForBlockUI(page, 30000);
  }

  return allRows;
}

async function main() {
  console.log(`🚀 Scraper naboru Racibórz — ${new Date().toLocaleString('pl-PL')}`);
  console.log(`   URL: ${URL}`);
  console.log(`   Miasto: ${CITY_VALUE} | Headless: ${HEADLESS}\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: 'pl-PL',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // 1. Open the page
    console.log('📄 Otwieranie strony...');
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 2. Select city
    console.log('🏙️  Wybór miasta Racibórz...');
    const citySelect = page.locator('select').filter({ hasText: /Racib/ }).first()
      .or(page.locator('select[id*="citySelect"], select[id*="city"]').first());

    // Try to find and select city dropdown
    const selects = await page.locator('select').all();
    let cityFound = false;
    for (const sel of selects) {
      const opts = await sel.locator('option').all();
      for (const opt of opts) {
        const val = await opt.getAttribute('value');
        const text = await opt.textContent();
        if (val === CITY_VALUE || (text && text.includes('Racib'))) {
          await sel.selectOption(val || CITY_VALUE);
          cityFound = true;
          console.log(`   ✅ Wybrano miasto: ${text?.trim()} (${val})`);
          break;
        }
      }
      if (cityFound) break;
    }

    if (!cityFound) {
      console.warn('   ⚠️  Nie znaleziono selecta z miastem, próbuję po value...');
      await page.selectOption(`select[id*="city"]`, CITY_VALUE).catch(() => null);
    }

    // 3. Click search button
    console.log('🔍 Klikam Szukaj...');
    const searchBtn = page.locator('input[type="submit"][value*="Szukaj"], button:has-text("Szukaj")').first();
    await searchBtn.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });

    // Wait for results
    await page.waitForSelector('table tr td', { timeout: 20000 }).catch(() => null);

    // 4. Scrape all pages
    console.log('📊 Scrapowanie danych ze wszystkich stron:');
    const allRows = await scrapeAllRows(page);

    // 5. Build JSON
    const schools = buildSchools(allRows);
    const schoolCount = Object.keys(schools).length;
    console.log(`\n✅ Znaleziono ${schoolCount} szkół`);

    // Compute summary stats
    let totalPlaces = 0, totalConfirmed = 0, totalUnconfirmed = 0;
    for (const s of Object.values(schools)) {
      totalPlaces     += s.places || 0;
      totalConfirmed  += s.razem?.totalConfirmed  || 0;
      totalUnconfirmed+= s.razem?.totalUnconfirmed|| 0;
    }

    const output = {
      meta: {
        source: URL,
        city: 'Racibórz',
        cityCode: CITY_VALUE,
        scrapedAt: new Date().toISOString(),
        schoolCount,
        totalPlaces,
        totalConfirmed,
        totalUnconfirmed,
        totalCandidates: totalConfirmed + totalUnconfirmed,
      },
      schools,
    };

    // 6. Save
    mkdirSync(dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`💾 Zapisano → ${OUT_FILE}`);
    console.log(`\n📈 Podsumowanie:`);
    console.log(`   Miejsc ogółem:       ${totalPlaces}`);
    console.log(`   Potwierdzeni:        ${totalConfirmed}`);
    console.log(`   Niepotwierdzone:     ${totalUnconfirmed}`);
    console.log(`   Chętni ogółem:       ${totalConfirmed + totalUnconfirmed}`);

  } catch (err) {
    console.error('\n❌ Błąd scrapowania:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
