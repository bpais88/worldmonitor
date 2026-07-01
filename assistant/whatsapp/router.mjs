// WhatsApp (Twilio) request router — Marco's 4th channel, the Teams twin. Twilio delivers
// inbound WhatsApp messages as form-encoded webhooks; we verify the Twilio signature, ack
// fast, run the SAME agent as Slack/Teams over the read-only tools, and reply via the Twilio
// API through the neutral send() seam.
//
// Scope: reactive Q&A only — we always reply inside WhatsApp's 24h free-form window, so no
// message templates are needed. Proactive alerts (which require Meta-approved templates) are
// a later phase; that's why watches + action tools are excluded here.
import { verifyTwilioSignature } from './verify.mjs';
import { runAgent, DEFAULT_SYSTEM } from '../agent.mjs';
import { DEFAULT_POLICY } from '../guardrails.mjs';
import { freightTools } from '../tools/freight.mjs';
import { weatherTools } from '../tools/weather.mjs';
import { MARCO_PERSONA } from '../slack/onboarding.mjs';
import { threadKey, getHistory, appendTurn } from '../slack/memory.mjs';
import { recordUsage } from '../usage.mjs';
import { send } from '../send.mjs';

// Read-only tool set — the exact same handlers as Slack/Teams.
const WHATSAPP_TOOLS = [...freightTools, ...weatherTools];
const WHATSAPP_SYSTEM =
  `${MARCO_PERSONA}\n\n${DEFAULT_SYSTEM}\n\n` +
  'You are replying on WhatsApp. Keep it short and mobile-friendly — a few sentences, lead ' +
  'with the answer. WhatsApp supports only *bold* and _italic_ (no headings/tables). You only ' +
  'answer freight/port/weather questions; you cannot take actions.';
const MAX_REPLY = 1500; // WhatsApp per-message limit is 1600 — keep a margin.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Parse a form-encoded webhook body into a plain params object. */
function parseForm(body) {
  const params = {};
  for (const [k, v] of new URLSearchParams(body || '')) params[k] = v;
  return params;
}

/**
 * The public URL Twilio signed against — reconstructed from the forwarded headers Railway
 * sets, overridable via WHATSAPP_PUBLIC_URL for an exact match if the proxy rewrites host.
 */
export function webhookUrl(req, u) {
  const base = process.env.WHATSAPP_PUBLIC_URL;
  if (base) return `${base.replace(/\/+$/, '')}${u.pathname}${u.search}`;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${u.pathname}${u.search}`;
}

export async function handleWhatsAppRequest(req, res, body, u) {
  const params = parseForm(body);
  const ok = verifyTwilioSignature({
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    signature: req.headers['x-twilio-signature'],
    url: webhookUrl(req, u),
    params,
  });
  if (!ok) {
    console.warn('[whatsapp] signature rejected');
    res.writeHead(403);
    return res.end();
  }
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
  const user = from.replace(/^whatsapp:/, '');
  console.log(`[whatsapp] msg from ${user}: "${text.slice(0, 100)}"`);

  const install = { platform: 'whatsapp', deliver: { to: from } };
  const key = threadKey('whatsapp', user); // one conversation thread per user number

  try {
    const { text: reply, usage, calls } = await runAgent({
      userText: text,
      history: await getHistory(key),
      tools: WHATSAPP_TOOLS,
      system: WHATSAPP_SYSTEM,
      policy: DEFAULT_POLICY, // read-only
      context: { channel: user, user, team: 'whatsapp', platform: 'whatsapp', deliver: install.deliver },
    });
    const out = (reply || '(no answer)').slice(0, MAX_REPLY);
    const day = await recordUsage('whatsapp', usage);
    console.log(`[whatsapp]   → tools: ${calls.join(', ') || 'none'} · ${usage.input}+${usage.output} tok · replied ${out.length} chars` +
      (day ? ` · today ${day.messages} msg` : ''));
    await send(install, { channelId: user, text: out });
    await appendTurn(key, text, out);
  } catch (e) {
    console.error('[whatsapp] agent error:', e.message);
    await send(install, { channelId: user, text: `⚠️ Sorry — I hit an error: ${e.message}` }).catch(() => {});
  }
}
