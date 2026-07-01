// WhatsApp (Twilio) request router — Marco's 4th channel, the Teams twin. Twilio delivers
// inbound WhatsApp messages as form-encoded webhooks; we verify the `?k=` webhook secret
// (see verify.mjs for why a URL secret, not X-Twilio-Signature/Basic-auth), ack fast, run the
// SAME agent as Slack/Teams over the read-only tools, and reply via the Twilio API through send().
//
// Scope: reactive Q&A only — we always reply inside WhatsApp's 24h free-form window, so no
// message templates are needed. Watches + action tools are excluded: actions have no approval
// affordance in plain text, and watches need BOTH proactive delivery (approved templates) AND
// a per-user scope (today's single team:'whatsapp' tenant would cross-leak list/cancel across
// users) — both land together in the proactive phase.
import { verifyWebhookSecret } from './verify.mjs';
import { DEFAULT_SYSTEM } from '../agent.mjs';
import { freightTools } from '../tools/freight.mjs';
import { weatherTools } from '../tools/weather.mjs';
import { MARCO_PERSONA } from '../slack/onboarding.mjs';
import { runChannelTurn } from '../channel-turn.mjs';

// Read-only tool set — the exact same handlers as Slack/Teams.
const WHATSAPP_TOOLS = [...freightTools, ...weatherTools];
const WHATSAPP_SYSTEM =
  `${MARCO_PERSONA}\n\n${DEFAULT_SYSTEM}\n\n` +
  'You are replying on WhatsApp. Keep it short and mobile-friendly — a few sentences, lead ' +
  'with the answer. WhatsApp supports only *bold* and _italic_ (no headings/tables). You only ' +
  'answer freight/port/weather questions; you cannot take actions.';
const MAX_REPLY = 1500; // WhatsApp per-message limit is 1600 — keep a margin.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
// The shared secret Twilio carries in the webhook URL's `?k=` param (see verify.mjs). Read once at
// load, matching connector.mjs — a Railway env change redeploys anyway, so nothing is lost hoisting.
const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || '';

// Read a query value with percent-decoding but WITHOUT the application/x-www-form-urlencoded
// `+`→space conversion that URLSearchParams applies. So the secret matches whether the webhook URL
// carries it literally (`?k=a+b`) or percent-encoded (`?k=a%2Bb`) — both decode to `a+b` — while a
// literal `+` never becomes a space. (A `&`/`#`/`%` inside the secret must be percent-encoded.)
export function rawQueryValue(search, key) {
  for (const pair of (search || '').replace(/^\?/, '').split('&')) {
    const i = pair.indexOf('=');
    if ((i < 0 ? pair : pair.slice(0, i)) === key) {
      const raw = i < 0 ? '' : pair.slice(i + 1);
      try { return decodeURIComponent(raw); } catch { return raw; } // malformed %XX → compare raw
    }
  }
  return null;
}

export async function handleWhatsAppRequest(req, res, body, u) {
  const ok = verifyWebhookSecret({ provided: rawQueryValue(u.search, 'k'), expected: WEBHOOK_SECRET });
  if (!ok) {
    console.warn('[whatsapp] webhook auth rejected');
    res.writeHead(403);
    return res.end();
  }
  const params = Object.fromEntries(new URLSearchParams(body || ''));
  // Ack fast with empty TwiML — we reply out-of-band via the API (running the agent takes
  // longer than Twilio's webhook window), like the Slack/Teams adapters.
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(EMPTY_TWIML);
  void dispatch(params);
}

async function dispatch(params) {
  const from = params.From || ''; // "whatsapp:+31..."
  const text = (params.Body || '').trim();
  if (!from || !text) return;
  // Transport-specific bits done; the reactive-Q&A core is shared across the plain-chat channels.
  await runChannelTurn({
    platform: 'whatsapp',
    user: from.replace(/^whatsapp:/, ''), // one thread per user number
    text,
    deliver: { to: from }, // send() routes WhatsApp by deliver.to
    tools: WHATSAPP_TOOLS,
    system: WHATSAPP_SYSTEM,
    maxReply: MAX_REPLY,
  });
}
