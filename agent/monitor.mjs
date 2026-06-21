#!/usr/bin/env node
// Monitoring agent — one tick (Phase 1, deterministic; LLM synthesis is Phase 2).
//
// gather flagged ferries -> classify vs memory (dedup/gate/escalation/resolution)
// -> deliver Slack pings + resolutions -> persist memory.
//
// Env: RELAY_URL, RELAY_SHARED_SECRET, SLACK_WEBHOOK_URL,
//      UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, FERRY_BBOX
// Flags: --dry-run (log instead of posting; also used when no webhook set)

import { fetchIncidents } from './lib/gather.mjs';
import { classifyIncidents, severityBand } from './lib/episodes.mjs';
import { formatPing, formatResolution } from './lib/format.mjs';
import { postSlack } from './lib/deliver.mjs';
import { makeStore } from './lib/memory.mjs';

const DRY_RUN = process.argv.includes('--dry-run') || !process.env.SLACK_WEBHOOK_URL;
// Anti-flood: never send more than this many individual pings per tick (cold
// start or a genuine mass event); the rest collapse into one summary line.
const MAX_PINGS = Number(process.env.MONITOR_MAX_PINGS) || 6;

// Most urgent first: stalled / higher band, then larger ETA growth.
function pingRank(p) {
  return severityBand(p.incident) * 1000 + (p.incident.etaGrowthMin || 0);
}

async function tick() {
  const relay = process.env.RELAY_URL || 'http://localhost:3004';
  const secret = process.env.RELAY_SHARED_SECRET || '';
  const webhook = process.env.SLACK_WEBHOOK_URL || '';
  const store = makeStore();

  const memory = await store.load();
  const incidents = await fetchIncidents(relay, secret, process.env.FERRY_BBOX);
  const { pings, resolutions, nextMem } = classifyIncidents(incidents, memory, Date.now());

  const ranked = [...pings].sort((a, b) => pingRank(b) - pingRank(a));
  const shown = ranked.slice(0, MAX_PINGS);
  const overflow = ranked.length - shown.length;

  for (const p of shown) {
    await postSlack(webhook, formatPing(p), { dryRun: DRY_RUN });
  }
  if (overflow > 0) {
    await postSlack(webhook, `… and *${overflow}* more ferries newly delayed this cycle.`, { dryRun: DRY_RUN });
  }
  for (const r of resolutions) {
    await postSlack(webhook, formatResolution(r.name || `MMSI ${r.mmsi}`), { dryRun: DRY_RUN });
  }
  await store.save(nextMem);

  console.log(`[monitor] flagged=${incidents.length} pings=${pings.length} resolved=${resolutions.length} dryRun=${DRY_RUN}`);
}

tick().catch((e) => { console.error('[monitor] tick failed:', e.message); process.exitCode = 1; });
