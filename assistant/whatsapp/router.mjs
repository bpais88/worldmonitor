// WhatsApp (Twilio) request router — Marco's 4th channel, the Teams twin. Twilio delivers
// inbound WhatsApp messages as form-encoded webhooks; we verify the Basic-auth webhook secret
// (see verify.mjs for why not X-Twilio-Signature), ack fast, run the SAME agent as Slack/Teams
// over the read-only tools, and reply via the Twilio API through the neutral send() seam.
//
// Scope: reactive Q&A only — we always reply inside WhatsApp's 24h free-form window, so no
// message templates are needed. Watches + action tools are excluded: actions have no approval
// affordance in plain text, and watches need BOTH proactive delivery (approved templates) AND
// a per-user scope (today's single team:'whatsapp' tenant would cross-leak list/cancel across
// users) — both land together in the proactive phase.
import { verifyWebhookBasicAuth } from './verify.mjs';
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

export async function handleWhatsAppRequest(req, res, body) {
  const ok = verifyWebhookBasicAuth({
    header: req.headers['authorization'],
    expectedSecret: process.env.WHATSAPP_WEBHOOK_SECRET || '',
  });
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
    await send(install, { text: out }); // WhatsApp routes by install.deliver.to, not channelId
    await appendTurn(key, text, out);
  } catch (e) {
    console.error('[whatsapp] agent error:', e.message);
    await send(install, { text: `⚠️ Sorry — I hit an error: ${e.message}` }).catch(() => {});
  }
}
