'use strict';

// Weekly Med Freight Corridor Report — the outward-facing artifact of the analytics layer.
// Reads the LIVE Neon data (read-only) + the relay's disruption feed, applies the same
// honest-stats discipline as the serving layer (every number carries its n; thin sections are
// SUPPRESSED, never padded), and renders a single self-contained HTML file into reports/
// (git-ignored) plus a plain-text digest on stdout for pasting into a post.
//
// Usage: DATABASE_URL=... node scripts/corridor-report.cjs
//        (optional: PROD_RELAY_URL + RELAY_SHARED_SECRET for the strike-calendar section)
// Or:    npm run report:corridor  (loads .env via node --env-file)
//
// Design decisions:
//   - No week-over-week deltas yet: the collection clock started 2026-07-02 and the #103 grace
//     fix (2026-07-12) step-changed arrival counts — a WoW delta would be a methodology artifact.
//     Deltas start once two clean, same-methodology weeks exist.
//   - Operator on-time is labelled an EARLY SIGNAL below OPERATOR_SOLID_N eligible trips.
//   - All queries filter status='arrived' / coverage_ok — degraded feed windows never count.

const MIN = {
  peakHourArrivals: 50,   // arrivals a port needs before its peak hour is quotable
  dwellArrivals: 100,     // arrivals with dwell before a port enters the turnaround table
  dwellPlausibleMin: 15,  // a median "turnaround" below this is a geofence-transit artifact (the
                          // 8km port circle, not the berth) — suppressed until berth-level zones
  corridorLegs: 10,       // measured legs before a corridor is quotable
  operatorTrips: 25,      // eligible trips before an operator appears at all
};
const OPERATOR_SOLID_N = 100; // below this, the on-time table carries the early-signal caveat

// operator_id → display name (fallback: title-cased id)
const OPERATOR_NAMES = { msc_line: 'MSC', cma_cgm: 'CMA CGM', gnv: 'GNV', dfds: 'DFDS', moby: 'Moby Lines', grimaldi: 'Grimaldi' };
const opName = (id) => OPERATOR_NAMES[id] || String(id).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ISO week label for the report header + filename, e.g. { year: 2026, week: 28 }.
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // Thursday of this ISO week
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - yearStart) / 86_400_000 + 1) / 7) };
}

const fmtH = (h) => `${String(h).padStart(2, '0')}:00`;
const fmtDur = (min) => (min >= 90 ? `${Math.round(min / 6) / 10}h` : `${Math.round(min)}min`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- queries ---------------------------------------------------------------------------------

async function collect(sql) {
  const [head, dow, peaks, dwell, operators, corridors, berth] = await Promise.all([
    sql`SELECT
          (SELECT count(DISTINCT mmsi) FROM trips WHERE opened_at > now() - interval '7 days') AS fleet,
          (SELECT count(*) FROM trips WHERE status='arrived' AND arrived_at > now() - interval '7 days') AS arrivals_7d,
          (SELECT count(*) FROM trip_points) AS points,
          (SELECT count(*) FROM port_snapshots WHERE coverage_ok) AS snapshots`,
    sql`SELECT to_char(arrived_at,'Dy') AS dy, EXTRACT(dow FROM arrived_at)::int AS d, count(*)::int AS n
        FROM trips WHERE status='arrived' AND arrived_at > now() - interval '7 days' GROUP BY 1,2 ORDER BY 2`,
    sql`WITH a AS (
          SELECT t.dest_port_id, p.name, EXTRACT(hour FROM t.arrived_at AT TIME ZONE p.tz)::int AS h
          FROM trips t JOIN ports p ON p.port_id=t.dest_port_id WHERE t.status='arrived')
        SELECT dest_port_id, name, mode() WITHIN GROUP (ORDER BY h)::int AS peak, count(*)::int AS n
        FROM a GROUP BY 1,2 HAVING count(*) >= ${MIN.peakHourArrivals} ORDER BY n DESC LIMIT 8`,
    sql`SELECT t.dest_port_id, p.name, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.dest_dwell_min))::int AS med, count(*)::int AS n
        FROM trips t JOIN ports p ON p.port_id=t.dest_port_id
        WHERE t.status='arrived' AND t.dest_dwell_min IS NOT NULL
        GROUP BY 1,2
        HAVING count(*) >= ${MIN.dwellArrivals}
           AND percentile_cont(0.5) WITHIN GROUP (ORDER BY t.dest_dwell_min) >= ${MIN.dwellPlausibleMin}
        ORDER BY med ASC LIMIT 10`,
    sql`SELECT v.operator_id AS op,
          round(100.0*count(*) FILTER (WHERE t.arrived_at <= t.departure_eta + interval '15 min')/count(*))::int AS pct,
          count(*)::int AS n
        FROM trips t JOIN vessels v ON v.mmsi=t.mmsi
        WHERE t.status='arrived' AND t.eta_at_open AND t.departure_eta IS NOT NULL AND v.operator_id IS NOT NULL
        GROUP BY 1 HAVING count(*) >= ${MIN.operatorTrips} ORDER BY pct DESC`,
    sql`SELECT t.origin_port_id AS o, t.dest_port_id AS d, po.name AS oname, pd.name AS dname,
          round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.duration_min))::int AS med, count(*)::int AS n
        FROM trips t JOIN ports po ON po.port_id=t.origin_port_id JOIN ports pd ON pd.port_id=t.dest_port_id
        WHERE t.status='arrived' AND t.origin_port_id IS NOT NULL AND t.duration_min IS NOT NULL
        GROUP BY 1,2,3,4 HAVING count(*) >= ${MIN.corridorLegs} ORDER BY n DESC LIMIT 10`,
    sql`SELECT s.port_id, p.name, round(avg(s.at_berth))::int AS mean,
          round(percentile_cont(0.9) WITHIN GROUP (ORDER BY s.at_berth))::int AS p90
        FROM port_snapshots s JOIN ports p ON p.port_id=s.port_id
        WHERE s.coverage_ok AND s.ts > now() - interval '7 days'
        GROUP BY 1,2 HAVING round(avg(s.at_berth))::int >= 5 ORDER BY mean DESC LIMIT 6`,
  ]);
  return { head: head[0], dow, peaks, dwell, operators, corridors, berth };
}

// Upcoming scheduled strikes from the relay (best-effort: section is suppressed without env).
async function collectStrikes() {
  const base = process.env.PROD_RELAY_URL, secret = process.env.RELAY_SHARED_SECRET;
  if (!base || !secret) return null;
  try {
    const res = await fetch(`${base}/ais/disruptions?days=14`, { headers: { Authorization: `Bearer ${secret}` } });
    if (!res.ok) return null;
    const { events = [] } = await res.json();
    return events
      .filter((e) => e.kind === 'strike_scheduled' && e.startsAt)
      .sort((a, b) => a.startsAt - b.startsAt)
      .slice(0, 6);
  } catch { return null; }
}

// --- pure rendering --------------------------------------------------------------------------

/** Assemble the report model from raw query results (pure — unit-testable). */
function buildModel(raw, strikes, now = new Date()) {
  const wk = isoWeek(now);
  const busiestDow = [...raw.dow].sort((a, b) => b.n - a.n)[0];
  const quietestDow = [...raw.dow].sort((a, b) => a.n - b.n)[0];
  const solidOperators = raw.operators.every((o) => o.n >= OPERATOR_SOLID_N);
  return {
    week: wk,
    dateLabel: now.toISOString().slice(0, 10),
    head: raw.head,
    dow: raw.dow,
    busiestDow, quietestDow,
    peaks: raw.peaks,
    // Sub-plausible medians are zone-transit artifacts, not turnarounds — drop the PORT (its
    // number is untrustworthy), don't trim its samples (that would bias the median upward).
    dwell: raw.dwell.filter((d) => d.med >= MIN.dwellPlausibleMin),
    operators: raw.operators.map((o) => ({ ...o, name: opName(o.op) })),
    operatorsEarly: !solidOperators,
    corridors: raw.corridors,
    berth: raw.berth,
    strikes,
  };
}

function renderText(m) {
  const L = [];
  L.push(`MED FREIGHT CORRIDOR REPORT — week ${m.week.week}/${m.week.year} (issue #1)`);
  L.push(`${m.head.arrivals_7d} freight arrivals tracked across 39 ports this week · ${m.head.fleet} active vessels`);
  if (m.busiestDow) L.push(`Heaviest day: ${m.busiestDow.dy} (${m.busiestDow.n} arrivals) — quietest: ${m.quietestDow.dy} (${m.quietestDow.n}). Short-sea freight peaks INTO the weekend.`);
  if (m.peaks.length) L.push(`Peak arrival hours: ${m.peaks.slice(0, 5).map((p) => `${p.name} ${fmtH(p.peak)}`).join(' · ')}`);
  if (m.dwell.length) L.push(`Fastest median turnaround: ${m.dwell.slice(0, 3).map((d) => `${d.name} ${fmtDur(d.med)}`).join(' · ')}`);
  if (m.strikes && m.strikes.length) L.push(`Scheduled strikes next 14 days: ${m.strikes.map((s) => `${new Date(s.startsAt).toISOString().slice(5, 10)} ${s.summary}`).join(' | ').slice(0, 300)}`);
  return L.join('\n');
}

function renderHtml(m) {
  const section = (title, note, body) => body
    ? `<section><h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ''}${body}</section>` : '';
  const table = (heads, rows) =>
    `<table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i > 0 ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

  const dowBody = m.dow.length ? (() => {
    const max = Math.max(...m.dow.map((d) => d.n));
    return `<div class="bars">${m.dow.map((d) => `<div class="bar"><span class="v" style="height:${Math.max(6, Math.round(72 * d.n / max))}px"></span><span class="l">${esc(d.dy)}</span><span class="n">${d.n}</span></div>`).join('')}</div>
    <p>The short-sea week is lopsided: <strong>${esc(m.busiestDow.dy)} is the heaviest arrival day</strong> (${m.busiestDow.n}) and ${esc(m.quietestDow.dy)} the quietest (${m.quietestDow.n}) — freight positions into the weekend for the Monday road-leg, not away from it.</p>`;
  })() : null;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Med Freight Corridor Report — Week ${m.week.week}/${m.week.year}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..850&family=IBM+Plex+Mono:wght@400;600&family=Alegreya+Sans:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--paper:#f7f3ea;--ink:#152238;--soft:#4a5670;--line:#d4c9ae;--signal:#c8431a;--sea:#0e6b5e}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--paper);color:var(--ink);font-family:'Alegreya Sans',sans-serif;font-size:16px;line-height:1.6;max-width:820px;margin:0 auto;padding:2.5rem 1.5rem 4rem}
header{border-bottom:3px double var(--ink);padding-bottom:1.4rem;margin-bottom:.5rem}
.kicker{font-family:'IBM Plex Mono',monospace;font-size:.68rem;letter-spacing:.2em;color:var(--signal)}
h1{font-family:Fraunces,serif;font-weight:800;font-size:2.1rem;line-height:1.05;margin:.4rem 0}
.meta{font-family:'IBM Plex Mono',monospace;font-size:.68rem;color:var(--soft);letter-spacing:.08em}
.headline{display:flex;gap:2.2rem;flex-wrap:wrap;padding:1.1rem 0;border-bottom:1px solid var(--line)}
.headline b{font-family:Fraunces,serif;font-size:1.7rem;display:block}
.headline span{font-family:'IBM Plex Mono',monospace;font-size:.62rem;letter-spacing:.12em;color:var(--soft)}
section{margin-top:2.2rem}
h2{font-family:Fraunces,serif;font-size:1.25rem;margin-bottom:.5rem}
p{margin:.5rem 0;color:var(--ink)}
.note{font-family:'IBM Plex Mono',monospace;font-size:.66rem;color:var(--soft)}
table{width:100%;border-collapse:collapse;margin:.7rem 0;font-size:.92rem}
th{font-family:'IBM Plex Mono',monospace;font-size:.6rem;letter-spacing:.12em;text-transform:uppercase;text-align:left;color:var(--soft);border-bottom:2px solid var(--ink);padding:.35em .5em}
td{padding:.42em .5em;border-bottom:1px solid var(--line)}
td.num{font-family:'IBM Plex Mono',monospace;font-size:.82rem;text-align:right}
.bars{display:flex;gap:10px;align-items:flex-end;margin:1rem 0 .6rem;height:110px}
.bar{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;flex:1}
.bar .v{width:100%;background:var(--sea);border-radius:2px 2px 0 0}
.bar:nth-child(1) .v,.bar:nth-child(6) .v{background:var(--signal)}
.bar .l{font-family:'IBM Plex Mono',monospace;font-size:.6rem;color:var(--soft)}
.bar .n{font-family:'IBM Plex Mono',monospace;font-size:.62rem;font-weight:600}
.strike{border-left:4px solid var(--signal);background:rgba(200,67,26,.07);padding:.6rem .9rem;margin:.5rem 0;border-radius:0 3px 3px 0;font-size:.92rem}
.strike b{font-family:'IBM Plex Mono',monospace;font-size:.72rem;color:var(--signal)}
footer{margin-top:3rem;border-top:1px dashed var(--line);padding-top:1rem;font-family:'IBM Plex Mono',monospace;font-size:.62rem;color:var(--soft);line-height:1.9}
</style></head><body>
<header>
  <div class="kicker">WORLDMONITOR · MED SHORT-SEA INTELLIGENCE</div>
  <h1>Freight Corridor Report</h1>
  <div class="meta">WEEK ${m.week.week} / ${m.week.year} · ISSUE #1 · GENERATED ${esc(m.dateLabel)} · ITALY + UK + SPAIN + NETHERLANDS · 39 PORTS</div>
</header>
<div class="headline">
  <div><b>${m.head.arrivals_7d}</b><span>ARRIVALS THIS WEEK</span></div>
  <div><b>${m.head.fleet}</b><span>ACTIVE FREIGHT VESSELS</span></div>
  <div><b>${(m.head.points / 1e6).toFixed(1)}M</b><span>AIS TRACK POINTS BANKED</span></div>
  <div><b>${(m.head.snapshots / 1e3).toFixed(0)}k</b><span>PORT OBSERVATIONS</span></div>
</div>
${section('The week has a shape', null, dowBody)}
${section('When ports actually peak', 'modal arrival hour, local time, all observed arrivals',
    m.peaks.length ? table(['Port', 'Peak hour', 'Arrivals observed'], m.peaks.map((p) => [esc(p.name), fmtH(p.peak), p.n])) : null)}
${section('Turnaround league', `median dwell after arrival · ports with ≥${MIN.dwellArrivals} measured calls`,
    m.dwell.length ? table(['Port', 'Median turnaround', 'Calls measured'], m.dwell.map((d) => [esc(d.name), fmtDur(d.med), d.n])) : null)}
${section('Operator punctuality — early signal', m.operatorsEarly ? `on-time = arrived within 15min of the ETA declared AT DEPARTURE. Samples are still small; treat as directional until each operator passes ${OPERATOR_SOLID_N} measured voyages.` : 'on-time = arrived within 15min of the ETA declared at departure',
    m.operators.length ? table(['Operator', 'On-time', 'Voyages measured'], m.operators.map((o) => [esc(o.name), `${o.pct}%`, o.n])) : null)}
${section('Corridor benchmarks', `median port-to-port duration · corridors with ≥${MIN.corridorLegs} measured legs`,
    m.corridors.length ? table(['Corridor', 'Median leg', 'Legs'], m.corridors.map((c) => [`${esc(c.oname)} → ${esc(c.dname)}`, fmtDur(c.med), c.n])) : null)}
${section('Busiest berths this week', 'freight vessels at berth · mean and p90 spike, coverage-verified samples only',
    m.berth.length ? table(['Port', 'Typical at berth', 'p90 spike'], m.berth.map((b) => [esc(b.name), b.mean, b.p90])) : null)}
${m.strikes && m.strikes.length ? section('Scheduled strikes — next 14 days', 'official transport-ministry calendar; advance dates, not news reports',
    m.strikes.map((s) => `<div class="strike"><b>${esc(new Date(s.startsAt).toISOString().slice(0, 10))}</b> — ${esc(s.summary)}</div>`).join('')) : ''}
<footer>
  METHOD — AIS-derived, freight vessels only (cargo + RoPax), ${(m.head.snapshots / 1e3).toFixed(0)}k coverage-verified port observations; degraded feed windows excluded. Every figure carries its sample size; sections below threshold are omitted, never padded. On-time is measured against the ETA declared at departure — late promises don't score. Corridors require a geofence-confirmed origin (coverage expanding).<br>
  WORLDMONITOR · live board: worldmonitor-rouge-delta.vercel.app/ferry.html · report generated ${esc(m.dateLabel)}
</footer>
</body></html>`;
  return html;
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  const { neon } = require('@neondatabase/serverless');
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
  const sql = neon(url);
  const [raw, strikes] = await Promise.all([collect(sql), collectStrikes()]);
  const model = buildModel(raw, strikes);
  const html = renderHtml(model);

  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `corridor-report-${model.week.year}-W${String(model.week.week).padStart(2, '0')}.html`);
  fs.writeFileSync(file, html);
  console.log(renderText(model));
  console.log(`\nHTML → ${file}`);
  if (!strikes) console.log('(strike section suppressed: PROD_RELAY_URL/RELAY_SHARED_SECRET not set or relay unreachable)');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { isoWeek, buildModel, renderHtml, renderText, opName, fmtDur, MIN, OPERATOR_SOLID_N };
