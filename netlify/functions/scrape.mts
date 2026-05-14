/**
 * Netlify Scheduled Function — HTTP scraper naboru slaskie.edu.com.pl
 * Uruchamia się co 30 minut, wyniki zapisuje do Netlify Blobs.
 *
 * Nie używa Playwright — czyste HTTP + regex parsing (działa w serverless).
 */
import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const PAGE_URL =
  "https://slaskie.edu.com.pl/kandydat/app/candidates_statistics.xhtml";
const CITY_CODE = "0942469";

// ─── Cookie jar ───────────────────────────────────────────────────────────────
class CookieJar {
  private jar = new Map<string, string>();

  ingest(resp: Response) {
    const raw = resp.headers.get("set-cookie") ?? "";
    // Split on commas that precede a new cookie name (heuristic)
    for (const cookie of raw.split(/,(?=[A-Za-z_-]+=)/)) {
      const pair = cookie.split(";")[0].trim();
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

// ─── HTML utilities ───────────────────────────────────────────────────────────
function extractViewState(html: string): string | null {
  const m = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
  return m ? decodeHtml(m[1]) : null;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract all table rows (across all tables) as arrays of cell text. */
function extractAllRows(html: string): string[][] {
  const rows: string[][] = [];
  // Split on <tr so each segment starts right after a row opening tag
  const segments = html.split(/<tr[\s>]/i);
  for (const seg of segments.slice(1)) {
    const end = seg.search(/<\/tr>/i);
    const rowHtml = end >= 0 ? seg.slice(0, end) : seg;
    const cells: string[] = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m: RegExpExecArray | null;
    while ((m = tdRe.exec(rowHtml)) !== null) {
      cells.push(stripTags(m[1]));
    }
    if (cells.length >= 3) rows.push(cells);
  }
  return rows;
}

/** Find an input/select's name attribute by matching part of its id or value. */
function findFieldName(html: string, idFragment: string): string | null {
  const re = new RegExp(
    `name="([^"]+)"[^>]*id="[^"]*${idFragment}[^"]*"`,
    "i"
  );
  return html.match(re)?.[1] ?? null;
}

/** Find value="Szukaj" submit button name. */
function findSearchBtnName(html: string): string | null {
  return html.match(/name="([^"]+)"[^>]*value="Szukaj"/)?.[1] ?? null;
}

/** Find the form element's own name (j_idt… wrapping the whole form). */
function findFormId(html: string, citySelectName: string): string {
  // The form id is typically the prefix of the citySelectName
  const parts = citySelectName.split(":");
  return parts[0] ?? "j_idt63";
}

/** Find "Następna strona" button name. */
function findNextPageName(html: string): string | null {
  return (
    html.match(/name="([^"]+)"[^>]*value="Następna strona"/)?.[1] ?? null
  );
}

// ─── Data builders (mirrors scraper.js logic) ─────────────────────────────────
function parseCount(str: string) {
  str = str.replace("*", "").trim();
  const m = str.match(/^(\d+)\((\d+)\)$/);
  if (m) {
    const c = +m[1], u = +m[2];
    return { confirmed: c, unconfirmed: u, total: c + u };
  }
  const n = parseInt(str);
  return { confirmed: isNaN(n) ? 0 : n, unconfirmed: 0, total: isNaN(n) ? 0 : n };
}

function extractSchoolName(full: string): string {
  if (full.includes(" - RAZEM")) return full.replace(/ - RAZEM$/, "").trim();
  const i = full.lastIndexOf(" - ");
  return i > 0 ? full.slice(0, i).trim() : full.trim();
}

interface SchoolClass {
  section: string; places: number;
  totalConfirmed: number; totalUnconfirmed: number; totalAll: number;
  firstConfirmed: number; firstUnconfirmed: number;
}
interface Razem {
  totalConfirmed: number; totalUnconfirmed: number; totalAll: number;
  firstConfirmed: number; firstUnconfirmed: number;
}
interface School { name: string; places: number; classes: SchoolClass[]; razem: Razem | null; }

function buildSchools(rows: string[][]): Record<string, School> {
  const schools: Record<string, School> = {};

  for (const row of rows) {
    const full = row[0]?.trim();
    if (!full || /Szko[łl][^-]*odzia/i.test(full)) continue;

    const isRazem = full.includes(" - RAZEM") || full.endsWith("RAZEM");
    const schoolName = extractSchoolName(full);
    if (!schools[schoolName])
      schools[schoolName] = { name: schoolName, places: 0, classes: [], razem: null };

    const t = parseCount(row[2] ?? "0");
    const f = parseCount(row[3] ?? "0(0)");

    if (isRazem) {
      schools[schoolName].places = parseInt(row[1]) || 0;
      schools[schoolName].razem = {
        totalConfirmed: t.confirmed, totalUnconfirmed: t.unconfirmed, totalAll: t.total,
        firstConfirmed: f.confirmed, firstUnconfirmed: f.unconfirmed,
      };
    } else {
      const i = full.lastIndexOf(" - ");
      schools[schoolName].classes.push({
        section: i > 0 ? full.slice(i + 3).trim() : full,
        places: parseInt(row[1]) || 0,
        totalConfirmed: t.confirmed, totalUnconfirmed: t.unconfirmed, totalAll: t.total,
        firstConfirmed: f.confirmed, firstUnconfirmed: f.unconfirmed,
      });
    }
  }

  // RAZEM row from site shows only unique confirmed count ("10*") — compute unconfirmed from classes
  for (const school of Object.values(schools)) {
    if (school.razem) {
      const sumUnconf = school.classes.reduce((s, c) => s + c.totalUnconfirmed, 0);
      school.razem.totalUnconfirmed = sumUnconf;
      school.razem.totalAll = school.razem.totalConfirmed + sumUnconf;
    }
  }

  return schools;
}

// ─── HTTP scraping ────────────────────────────────────────────────────────────
async function httpScrape() {
  const jar = new CookieJar();
  const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

  const baseHeaders = () => ({
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
    "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
    Cookie: jar.header(),
  });

  // 1. Initial GET
  const initResp = await fetch(PAGE_URL, { headers: baseHeaders() });
  jar.ingest(initResp);
  const initHtml = await initResp.text();
  let viewState = extractViewState(initHtml);
  if (!viewState) throw new Error("ViewState missing from initial page");

  const citySelectName =
    findFieldName(initHtml, "citySelect") ?? "j_idt63:j_idt64:citySelect";
  const schoolSelectName =
    findFieldName(initHtml, "schoolSelect") ??
    "j_idt63:schoolSelectSect:j_idt90:schoolSelect";
  const searchBtnName =
    findSearchBtnName(initHtml) ?? "j_idt63:j_idt104:j_idt105";
  const formId = findFormId(initHtml, citySelectName);

  // 2. POST search for Racibórz
  const searchBody = new URLSearchParams({
    [formId]: formId,
    [citySelectName]: CITY_CODE,
    [schoolSelectName]: "",
    [searchBtnName]: "Szukaj",
    "javax.faces.ViewState": viewState,
  });

  const searchResp = await fetch(PAGE_URL, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: PAGE_URL,
    },
    body: searchBody.toString(),
  });
  jar.ingest(searchResp);
  let pageHtml = await searchResp.text();
  viewState = extractViewState(pageHtml) ?? viewState;

  // 3. Paginate through all result pages
  const allRows: string[][] = [];
  let pageNum = 0;

  while (true) {
    pageNum++;
    const rows = extractAllRows(pageHtml);
    allRows.push(...rows);
    console.log(`  Page ${pageNum}: ${rows.length} rows`);

    const nextName = findNextPageName(pageHtml);
    if (!nextName || pageNum > 100) break; // safety cap

    const nextBody = new URLSearchParams({
      [formId]: formId,
      [nextName]: nextName,
      "javax.faces.ViewState": viewState!,
    });

    const nextResp = await fetch(PAGE_URL, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: PAGE_URL,
      },
      body: nextBody.toString(),
    });
    jar.ingest(nextResp);
    pageHtml = await nextResp.text();
    viewState = extractViewState(pageHtml) ?? viewState;
  }

  const schools = buildSchools(allRows);
  const schoolCount = Object.keys(schools).length;
  let totalPlaces = 0, totalConfirmed = 0, totalUnconfirmed = 0;
  for (const s of Object.values(schools)) {
    totalPlaces += s.places;
    totalConfirmed += s.razem?.totalConfirmed ?? 0;
    totalUnconfirmed += s.razem?.totalUnconfirmed ?? 0;
  }

  return {
    meta: {
      source: PAGE_URL,
      city: "Racibórz",
      cityCode: CITY_CODE,
      scrapedAt: new Date().toISOString(),
      schoolCount,
      totalPlaces,
      totalConfirmed,
      totalUnconfirmed,
      totalCandidates: totalConfirmed + totalUnconfirmed,
    },
    schools,
  };
}

// ─── Netlify handler ──────────────────────────────────────────────────────────
export default async function (): Promise<Response> {
  console.log("Scheduled scrape →", new Date().toISOString());
  try {
    const data = await httpScrape();

    if (Object.keys(data.schools).length === 0) {
      throw new Error("No schools found — scraping likely failed");
    }

    const store = getStore("nabor");
    await store.set("raciborz", JSON.stringify(data), {
      metadata: { scrapedAt: data.meta.scrapedAt },
    });

    console.log(`Stored data for ${data.meta.schoolCount} schools`);
    return new Response(JSON.stringify({ ok: true, ...data.meta }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Scrape failed:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const config: Config = {
  schedule: "*/30 * * * *",
};
