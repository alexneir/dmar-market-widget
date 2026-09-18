#!/usr/bin/env node
/*
 * build.js — turns data.json into a finished index.html.
 *
 * Everything is rendered here, at build time, so the published page is plain
 * HTML, CSS and SVG with no JavaScript. That is what lets it work inside an
 * iframe that a CMS has locked down with sandbox="".
 *
 * Run:  node build.js            -> writes _site/index.html
 *       node build.js --out dir  -> writes <dir>/index.html
 *
 * No dependencies. Node 18 or newer.
 */
 
const fs = require("fs");
const path = require("path");
 
const ROOT = __dirname;
const outArg = process.argv.indexOf("--out");
const OUT_DIR = outArg > -1 ? process.argv[outArg + 1] : path.join(ROOT, "_site");
 
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const SHORT  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
 
/* ---------------- helpers ---------------- */
 
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
                          .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
 
const money = n => "$" + Math.round(n).toLocaleString("en-US");
const count = n => Math.round(n).toLocaleString("en-US");
 
function moneyShort(n){
  return n >= 1000 ? "$" + Math.round(n/1000) + "K" : "$" + Math.round(n);
}
 
/* keep DMAR's published precision: two decimals, trailing zeros trimmed */
function pct(n){
  let s = Math.abs(n).toFixed(2);
  if (s.includes(".")) s = s.replace(/0+$/,"").replace(/\.$/,"");
  return s + "%";
}
 
function monthLabel(ym){
  const [y,m] = String(ym).split("-");
  return MONTHS[parseInt(m,10)-1] + " " + y;
}
function shortLabel(ym){
  return SHORT[parseInt(String(ym).split("-")[1],10)-1];
}
function prettyDate(iso){
  if (!iso) return "";
  const p = String(iso).split("-");
  if (p.length < 3) return iso;
  return MONTHS[parseInt(p[1],10)-1] + " " + parseInt(p[2],10) + ", " + p[0];
}
 
function fmtValue(v, format){
  if (v === null || v === undefined) return null;
  if (format === "currency") return { main: money(v), unit: "" };
  if (format === "days")     return { main: count(v), unit: v === 1 ? "day" : "days" };
  if (format === "percent")  return { main: (Math.round(v*100)/100) + "%", unit: "" };
  return { main: count(v), unit: "" };
}
 
/* Direction to tone, respecting what "good" means for each metric.
   positive_up   -> a rise is good (prices, sales)
   positive_down -> a fall is good (days on market)
   neutral       -> neither (inventory) */
function toneFor(change, polarity){
  if (change === null || change === undefined) return "flat";
  if (Math.abs(change) < 0.05) return "flat";
  if (polarity === "neutral") return "flat";
  if (polarity === "positive_down") return change < 0 ? "up" : "down";
  return change > 0 ? "up" : "down";
}
function arrowFor(change){
  if (change === null || change === undefined) return "";
  if (Math.abs(change) < 0.05) return "→";
  return change > 0 ? "▲" : "▼";
}
 
function deltaEl(label, change, polarity, note){
  if (change === null || change === undefined) return "";
  const tone = toneFor(change, polarity);
  const txt  = (Math.abs(change) < 0.05 && note) ? esc(note) : (arrowFor(change) + " " + pct(change));
  return `<span class="delta ${tone}"><b>${txt}</b> ${esc(label)}</span>`;
}
 
/* ---------------- sections ---------------- */
 
function renderCards(d){
  let prevMonth = "", prevYear = "";
  if (d.data_month){
    const [ys, ms] = d.data_month.split("-");
    const y = parseInt(ys,10), m = parseInt(ms,10);
    prevMonth = "vs. " + SHORT[(m+10)%12];
    prevYear  = "vs. " + SHORT[m-1] + " " + (y-1);
  }
 
  return (d.metrics || []).map(mt => {
    const v = fmtValue(mt.value, mt.format);
    let headline, deltas;
 
    if (v){
      headline = `<div class="stat-value">${esc(v.main)}${v.unit ? `<span class="unit">${esc(v.unit)}</span>` : ""}</div>`;
      deltas = deltaEl(prevMonth, mt.mom, mt.polarity, mt.mom_note)
             + deltaEl(prevYear,  mt.yoy, mt.polarity, mt.yoy_note);
 
    } else if (mt.mom !== null && mt.mom !== undefined){
      /* DMAR published the change but not the count: lead with the change */
      const tone = toneFor(mt.mom, mt.polarity);
      const cls  = tone === "up" ? "is-pos" : tone === "down" ? "is-neg" : "is-neu";
      headline = `<div class="stat-value ${cls}">${arrowFor(mt.mom)} ${pct(mt.mom)}</div>`;
      deltas = `<span class="delta">${esc(prevMonth.replace("vs. ","from "))}</span>`
             + deltaEl(prevYear, mt.yoy, mt.polarity, mt.yoy_note);
 
    } else if (mt.yoy !== null && mt.yoy !== undefined){
      const tone = toneFor(mt.yoy, mt.polarity);
      const cls  = tone === "up" ? "is-pos" : tone === "down" ? "is-neg" : "is-neu";
      headline = `<div class="stat-value ${cls}">${arrowFor(mt.yoy)} ${pct(mt.yoy)}</div>`;
      deltas = `<span class="delta">year over year</span>`;
 
    } else {
      return null;   // nothing published for this metric at all
    }
 
    return `    <div class="stat">
      <div class="stat-label">${esc(mt.label)}</div>
      <div>
        ${headline}
        <div class="stat-deltas">${deltas}</div>
      </div>
    </div>`;
  }).filter(Boolean).join("\n");
}
 
/*
 * The chart is positioned in percentages rather than pixels, so it stays
 * responsive with no script. The SVG holds only the area and the line and is
 * stretched to fit; every piece of text and the end dot are HTML elements
 * placed by percentage, so they never scale or distort.
 */
function renderChart(d){
  const h = (d.history || []).filter(r => typeof r.median_close_price === "number").slice(-12);
  if (h.length < 2){
    return { sub: "Trend data will appear after two months of readings.", html: '      <div class="chart"></div>' };
  }
 
  const vals = h.map(r => r.median_close_price);
  const realLo = Math.min(...vals), realHi = Math.max(...vals);
  const span = (realHi - realLo) || 1;
  const lo = realLo - span * 0.28, hi = realHi + span * 0.28;
 
  const X = i => (i / (h.length - 1)) * 100;
  const Y = v => (1 - (v - lo) / (hi - lo)) * 100;
 
  const pts  = h.map((r,i) => [X(i), Y(r.median_close_price)]);
  const line = pts.map((p,i) => (i ? "L" : "M") + p[0].toFixed(2) + " " + p[1].toFixed(2)).join(" ");
  const area = line + ` L100 100 L0 100 Z`;
 
  /* gridlines and y labels at the true min and max */
  const rules = [realHi, realLo].map(v =>
    `        <div class="rule" style="top:${Y(v).toFixed(2)}%"></div>`).join("\n");
  const yLabs = [realHi, realLo].map(v =>
    `      <span class="y-lab" style="top:${Y(v).toFixed(2)}%">${moneyShort(v)}</span>`).join("\n");
 
  /* x labels: both ends plus a few in between, without crowding */
  const step = h.length > 8 ? 3 : (h.length > 5 ? 2 : 1);
  const xLabs = h.map((r,i) => {
    const isFirst = i === 0, isLast = i === h.length - 1;
    if (!isFirst && !isLast && (i % step !== 0 || i > h.length - 2)) return null;
    const cls = isFirst ? "x-lab first" : isLast ? "x-lab last" : "x-lab";
    const style = isFirst ? "" : ` style="left:calc(46px + (100% - 50px) * ${(X(i)/100).toFixed(4)})"`;
    return `      <span class="${cls}"${style}>${shortLabel(r.month)}</span>`;
  }).filter(Boolean).join("\n");
 
  const last = pts[pts.length - 1];
 
  const html = `      <div class="chart">
      <div class="plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path class="series-area" d="${area}"/>
          <path class="series-line" d="${line}" vector-effect="non-scaling-stroke"/>
        </svg>
${rules}
        <span class="end-dot" style="left:100%;top:${last[1].toFixed(2)}%"></span>
      </div>
${yLabs}
${xLabs}
      </div>`;
 
  return { sub: monthLabel(h[0].month) + " – " + monthLabel(h[h.length-1].month), html };
}
 
function renderNotes(d){
  const notes = (d.notes || []).slice(0,3);
  if (!notes.length){
    return "        <li>Detailed commentary for this month is in the full DMAR report.</li>";
  }
  return notes.map(n => `        <li>${esc(n)}</li>`).join("\n");
}
 
/*
 * Freshness is evaluated at build time. The workflow rebuilds daily, so this
 * stays accurate without any script running in the visitor's browser.
 */
function renderAlert(d, now){
  if (!d.data_month) return "";
  const [y,m] = d.data_month.split("-").map(Number);
  const due = new Date(Date.UTC(y, m + 1, 12));   // about six weeks after the data month ends
  if (now <= due) return "";
  return `  <div class="alert" role="status">Showing ${esc(d.data_month_label || d.data_month)} data. A newer DMAR report may now be available.</div>`;
}
 
/* ---------------- main ---------------- */
 
function build(){
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
  const tpl  = fs.readFileSync(path.join(ROOT, "template.html"), "utf8");
  const now  = new Date();
 
  const market = data.market || "Denver Metro";
  const src    = data.source || {};
  const link   = src.month_url || src.url || "https://www.dmarealtors.com/market-trends-reports";
  const chart  = renderChart(data);
 
  const attrib = `Source: <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">`
               + `${esc(src.name || "Denver Metro Association of REALTORS®")} `
               + `${esc(src.report || "Market Trends Report")}</a>.`
               + (data.presented_by ? ` Presented by ${esc(data.presented_by)}.` : "");
 
  const subParts = [data.market_note, src.short ? `${src.short} ${src.report || ""}`.trim() : null]
                     .filter(Boolean).map(esc);
 
  const out = tpl
    .replace("{{PAGE_TITLE}}", esc(`${market} Market Conditions`))
    .replace("{{ALERT}}",      renderAlert(data, now))
    .replace("{{TITLE}}",      esc(`${market} Market Conditions`))
    .replace("{{SUB}}",        subParts.join(" · "))
    .replace("{{BADGE}}",      esc(`${data.data_month_label || ""} data`))
    .replace("{{CARDS}}",      renderCards(data))
    .replace("{{CHART_SUB}}",  esc(chart.sub))
    .replace("{{CHART}}",      chart.html)
    .replace("{{NOTES_SUB}}",  esc(data.data_month_label || ""))
    .replace("{{NOTES}}",      renderNotes(data))
    .replace("{{ATTRIB}}",     attrib)
    .replace("{{STAMP}}",      esc("Updated " + prettyDate(data.last_updated || data.published)));
 
  if (out.includes("{{")) throw new Error("Unfilled placeholder left in template: " + out.match(/\{\{[A-Z_]+\}\}/));
 
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), out);
  fs.copyFileSync(path.join(ROOT, "data.json"), path.join(OUT_DIR, "data.json"));
 
  console.log(`Built ${path.join(OUT_DIR, "index.html")} for ${data.data_month_label || data.data_month}`);
}
 
build();
