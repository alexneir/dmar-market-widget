#!/usr/bin/env node
/*
 * update-data.js — checks DMAR for a newer monthly report and, if there is one,
 * rewrites data.json with its figures.
 *
 * Runs inside GitHub Actions. Needs ANTHROPIC_API_KEY in the environment.
 * Optional: ANTHROPIC_MODEL (defaults to claude-sonnet-5).
 *
 * Exit codes:
 *   0  either nothing new was published, or data.json was updated successfully
 *   1  something went wrong and a human should look
 *
 * Nothing new is NOT an error. Two of the three monthly runs are expected to
 * find nothing, and a failing workflow every month would train you to ignore it.
 *
 * No dependencies. Node 20 or newer (uses global fetch).
 */
 
const fs = require("fs");
const path = require("path");
 
const ROOT = __dirname;
const DATA_PATH = path.join(ROOT, "data.json");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;
 
const MONTHS = ["january","february","march","april","may","june",
                "july","august","september","october","november","december"];
const MON3 = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const MONTHS_CAP = MONTHS.map(m => m[0].toUpperCase() + m.slice(1));
 
const UA = { "user-agent": "dmar-market-widget/1.0 (github actions; static site data refresh)" };
 
function log(...a){ console.log(...a); }
function fail(msg){ console.error("ERROR: " + msg); process.exit(1); }
function nothingNew(msg){ log("No update: " + msg); process.exit(0); }
 
/* ---------- find the newest report ---------- */
 
function nextMonthOf(ym){
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? [y + 1, 1] : [y, m + 1];
}
 
async function tryUrl(url){
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow" });
    if (!r.ok) return null;
    const html = await r.text();
    /* DMAR serves a soft 404 for some bad slugs; require the report heading */
    if (!/market\s*trends/i.test(html)) return null;
    return html;
  } catch { return null; }
}
 
/*
 * DMAR's article slugs are not consistent month to month: some read
 * "august-2026", older ones read "sep-25". Try the known shapes, then fall back
 * to scanning the index page for any link naming the month we want.
 */
async function findReport(year, month){
  const full = MONTHS[month - 1];
  const ab = MON3[month - 1];
  const yy = String(year).slice(2);
  const base = "https://www.dmarealtors.com/news/market-trends/dmar-real-estate-market-trends-report-";
 
  const candidates = [
    `${base}${full}-${year}`,
    `${base}${ab}-${yy}`,
    `${base}${full}-${yy}`,
    `${base}${ab}-${year}`,
  ];
 
  for (const url of candidates){
    const html = await tryUrl(url);
    if (html) return { url, html };
  }
 
  /* fallback: scan the index */
  try {
    const r = await fetch("https://www.dmarealtors.com/market-trends-reports", { headers: UA });
    if (r.ok){
      const idx = await r.text();
      const re = /href="([^"]*dmar-real-estate-market-trends-report-[^"]*)"/gi;
      let m;
      const seen = new Set();
      while ((m = re.exec(idx)) !== null){
        let href = m[1];
        if (!/^https?:/.test(href)) href = "https://www.dmarealtors.com" + href;
        if (seen.has(href)) continue;
        seen.add(href);
        const slug = href.toLowerCase();
        const namesMonth = slug.includes(`-${full}-`) || slug.endsWith(`-${full}-${year}`) ||
                           slug.includes(`-${ab}-`);
        const namesYear = slug.includes(String(year)) || slug.includes(`-${yy}`);
        if (namesMonth && namesYear){
          const html = await tryUrl(href);
          if (html) return { url: href, html };
        }
      }
    }
  } catch { /* fall through */ }
 
  return null;
}
 
/* ---------- html to readable text ---------- */
 
function toText(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&rsquo;|&#8217;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, " - ").replace(/&ndash;/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30000);
}
 
/* ---------- extraction ---------- */
 
const NUM = { type: ["number", "null"] };
 
const TOOL = {
  name: "report_metrics",
  description: "Record the Denver metro figures stated in this DMAR monthly report.",
  input_schema: {
    type: "object",
    properties: {
      published_date: { type: ["string","null"], description: "Publication date of the article, YYYY-MM-DD, or null" },
      median_close_price: {
        type: "object",
        properties: { value: NUM, mom: NUM, yoy: NUM,
          yoy_note: { type: ["string","null"], description: "Set to 'unchanged' only if DMAR calls it flat or essentially unchanged" } },
        required: ["value","mom","yoy"]
      },
      active_listings: {
        type: "object",
        properties: { value: NUM, mom: NUM, yoy: NUM },
        required: ["value","mom","yoy"]
      },
      closed_sales: {
        type: "object",
        properties: { value: NUM, mom: NUM, yoy: NUM },
        required: ["value","mom","yoy"]
      },
      days_in_mls: {
        type: "object",
        properties: { value: NUM, mom: NUM, yoy: NUM },
        required: ["value","mom","yoy"]
      },
      ytd_median_price: {
        type: "object",
        properties: { value: NUM, yoy: NUM },
        required: ["value","yoy"]
      },
      ytd_closings: {
        type: "object",
        properties: { value: NUM, yoy: NUM },
        required: ["value","yoy"]
      },
      notes: {
        type: "array",
        items: { type: "string" },
        minItems: 2, maxItems: 3,
        description: "Two or three short factual sentences from this month's report"
      }
    },
    required: ["median_close_price","active_listings","closed_sales","days_in_mls",
               "ytd_median_price","ytd_closings","notes"]
  }
};
 
function extractionPrompt(monthLabel, text){
  return `Below is the text of the Denver Metro Association of REALTORS monthly Market Trends Report article for ${monthLabel}.
 
Record the figures for the COMBINED residential market (detached + attached together) for the Denver metro area.
 
Rules, in order of importance:
 
1. Report only figures the text actually states. If a figure is not stated, use null. A null is correct and expected; an invented number is a serious error. Do not estimate, interpolate, or calculate a value from a percentage.
2. Never substitute a detached-only or attached-only figure for a combined figure. If only the split is given, the combined value is null.
3. Keep the exact precision the text uses. If it says 18.99 percent, record -18.99, not -19.
4. Signs: a decrease is negative, an increase is positive.
5. "mom" is the change from the previous month. "yoy" is the change from the same month a year earlier. If the text gives a change but not the underlying count, record the change and leave value null.
6. If the text says a figure is "flat", "essentially unchanged" or similar without a number, record 0 and set yoy_note to "unchanged".
7. days_in_mls is the median days in MLS. If the text gives this month and last month as plain numbers (for example "rose to 27, up from 21"), compute mom from those two numbers. Same for yoy if it names last year's figure.
8. For notes: two or three short factual sentences drawn from this month's report, each under 130 characters, each a complete sentence. Good subjects are the detached versus attached split, days on market contrasts, or the luxury segment. Factual only. No advice, no opinion, no adjectives the report does not use.
 
ARTICLE TEXT:
${text}`;
}
 
async function extract(monthLabel, text){
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "report_metrics" },
      messages: [{ role: "user", content: extractionPrompt(monthLabel, text) }],
    }),
  });
 
  if (!res.ok){
    const body = await res.text();
    fail(`Anthropic API returned ${res.status}: ${body.slice(0, 500)}`);
  }
 
  const out = await res.json();
  const block = (out.content || []).find(c => c.type === "tool_use");
  if (!block) fail("Model did not return structured output");
  return block.input;
}
 
/* ---------- validation ---------- */
 
function validate(x, prevMonthYm, newYm){
  const problems = [];
  const inRange = (v, lo, hi, name) => {
    if (v === null || v === undefined) return;
    if (typeof v !== "number" || !isFinite(v)) problems.push(`${name} is not a number`);
    else if (v < lo || v > hi) problems.push(`${name} = ${v}, outside ${lo}..${hi}`);
  };
 
  inRange(x.median_close_price?.value, 350000, 1200000, "median_close_price");
  inRange(x.ytd_median_price?.value,   350000, 1200000, "ytd_median_price");
  inRange(x.active_listings?.value,      2000,   30000, "active_listings");
  inRange(x.closed_sales?.value,           200,   12000, "closed_sales");
  inRange(x.days_in_mls?.value,              1,     200, "days_in_mls");
 
  for (const k of ["median_close_price","active_listings","closed_sales","days_in_mls"]){
    inRange(x[k]?.mom, -60, 60, `${k}.mom`);
    inRange(x[k]?.yoy, -60, 60, `${k}.yoy`);
  }
 
  if (!Array.isArray(x.notes) || x.notes.length < 2){
    problems.push("fewer than two notes returned");
  }
 
  /* the headline number must be present, or there is nothing worth publishing */
  if (x.median_close_price?.value === null && x.active_listings?.value === null){
    problems.push("neither median close price nor active listings was found");
  }
 
  const [py, pm] = prevMonthYm.split("-").map(Number);
  const [ny, nm] = newYm.split("-").map(Number);
  const gap = (ny - py) * 12 + (nm - pm);
  if (gap !== 1) log(`NOTE: jumping ${gap} months, from ${prevMonthYm} to ${newYm}`);
 
  return problems;
}
 
/* ---------- merge ---------- */
 
function merge(data, x, newYm, monthLabel, articleUrl){
  const byKey = {
    median_close_price: x.median_close_price,
    active_listings:    x.active_listings,
    closed_sales:       x.closed_sales,
    days_in_mls:        x.days_in_mls,
    ytd_median_price:   x.ytd_median_price,
    ytd_closings:       x.ytd_closings,
  };
 
  data.metrics = data.metrics.map(m => {
    const v = byKey[m.key];
    if (!v) return m;
    const next = { ...m, value: v.value ?? null };
    next.mom = v.mom ?? null;
    next.yoy = v.yoy ?? null;
    if (v.yoy_note) next.yoy_note = v.yoy_note; else delete next.yoy_note;
    return next;
  });
 
  data.notes = x.notes.slice(0, 3);
 
  const today = new Date().toISOString().slice(0, 10);
  const [ny, nm] = newYm.split("-").map(Number);
  const nextExp = new Date(Date.UTC(ny, nm + 1, 6)).toISOString().slice(0, 10);
 
  data.data_month = newYm;
  data.data_month_label = monthLabel;
  data.published = x.published_date || today;
  data.last_updated = today;
  data.next_expected = nextExp;
  data.source = { ...(data.source || {}), month_url: articleUrl };
 
  const entry = { month: newYm, derived: false };
  if (x.median_close_price?.value != null) entry.median_close_price = x.median_close_price.value;
  if (x.active_listings?.value != null)    entry.active_listings    = x.active_listings.value;
 
  data.history = (data.history || []).filter(h => h.month !== newYm);
  data.history.push(entry);
  data.history.sort((a, b) => a.month.localeCompare(b.month));
  if (data.history.length > 14) data.history = data.history.slice(-14);
 
  return data;
}
 
/* ---------- main ---------- */
 
(async () => {
  if (!API_KEY) fail("ANTHROPIC_API_KEY is not set");
 
  const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const current = data.data_month;
  log(`Published data is ${current}. Looking for the next month.`);
 
  const [ny, nm] = nextMonthOf(current);
  const newYm = `${ny}-${String(nm).padStart(2, "0")}`;
  const monthLabel = `${MONTHS_CAP[nm - 1]} ${ny}`;
 
  const found = await findReport(ny, nm);
  if (!found) nothingNew(`DMAR has not published ${monthLabel} yet`);
 
  log(`Found ${monthLabel} at ${found.url}`);
 
  const text = toText(found.html);
  if (text.length < 800) fail(`Article text too short to trust (${text.length} chars)`);
 
  const x = await extract(monthLabel, text);
  log("Extracted: " + JSON.stringify({
    median: x.median_close_price?.value,
    active: x.active_listings?.value,
    dom: x.days_in_mls?.value,
    notes: x.notes?.length,
  }));
 
  const problems = validate(x, current, newYm);
  if (problems.length){
    fail("Refusing to publish, the extracted figures failed validation:\n  - " + problems.join("\n  - "));
  }
 
  const merged = merge(data, x, newYm, monthLabel, found.url);
  fs.writeFileSync(DATA_PATH, JSON.stringify(merged, null, 2) + "\n");
  log(`data.json updated to ${monthLabel}`);
})();
