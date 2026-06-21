// Pure formatting of incidents into Slack messages (mrkdwn). No I/O.

const REASON_ICON = { meteoalarm: '⚠️', weather: '🌊', port: '⚓', fleet: '🛳', news: '📰', operator: '🏢' };

function delayPhrase(incident) {
  if (incident.stalled) return 'stalled mid-crossing';
  const g = incident.etaGrowthMin;
  return Number.isFinite(g) && g > 0 ? `delayed +${g}m` : 'delayed';
}

/** Top 2 reason lines, e.g. "⚠️ official orange coastal warning · 🛳 3 nearby also delayed". */
function reasonLine(incident) {
  const rs = (incident.reasons || []).slice(0, 2);
  if (rs.length === 0) return '';
  return rs.map((r) => {
    const icon = REASON_ICON[r.source] || '•';
    const hedge = (r.confidence ?? 0) < 0.6 ? 'possibly ' : '';
    return `${icon} ${hedge}${r.summary}`;
  }).join(' · ');
}

/** One real-time ping line for an incident. */
export function formatPing({ incident, kind }) {
  const head = kind === 'escalated' ? '↑ *Escalation*' : '🚨';
  const dest = incident.destName ? ` → ${incident.destName}` : '';
  const why = reasonLine(incident);
  const whyLine = why ? `\n    ${why}` : '';
  return `${head} *${incident.name}*${dest} — ${delayPhrase(incident)}${whyLine}`;
}

/** A resolution note. */
export function formatResolution(name) {
  return `✅ *${name}* — delay cleared, back on track`;
}

/** A periodic digest summarising the current flagged set. */
export function formatDigest(incidents) {
  if (!incidents || incidents.length === 0) return '🟢 All tracked ferries running normally.';
  const byRegion = new Map();
  let stalled = 0;
  for (const i of incidents) {
    byRegion.set(i.region || 'Other', (byRegion.get(i.region || 'Other') || 0) + 1);
    if (i.stalled) stalled++;
  }
  const regions = [...byRegion.entries()].map(([r, n]) => `${r}: ${n}`).join(', ');
  const stall = stalled ? ` (${stalled} stalled)` : '';
  return `📋 ${incidents.length} ferries delayed${stall} — ${regions}`;
}
