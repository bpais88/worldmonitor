// The shared "one turn" core for the plain-chat adapters (WhatsApp, Telegram, and future
// SMS/Signal/etc.): history → runAgent over the adapter's read-only tools → record usage →
// reply via send() → persist the turn. Each adapter owns only its TRANSPORT — verifying the
// inbound secret, acking fast, and extracting {user, text, deliver} from the platform's payload —
// then hands the rest here. Teams keeps its own dispatch: it needs approval fan-out, a
// tenant-scoped thread key, and card routing that don't fit this reactive-Q&A shape.
import { runAgent } from './agent.mjs';
import { DEFAULT_POLICY } from './guardrails.mjs';
import { threadKey, getHistory, appendTurn } from './slack/memory.mjs';
import { recordUsage } from './usage.mjs';
import { send } from './send.mjs';

/**
 * Run one reactive Q&A turn for a plain-chat channel. `deliver` is the platform-specific routing
 * record that send() branches on (e.g. `{to}` for WhatsApp, `{chatId}` for Telegram). Read-only.
 */
export async function runChannelTurn({ platform, user, text, deliver, tools, system, maxReply }) {
  console.log(`[${platform}] msg from ${user}: "${text.slice(0, 100)}"`);
  const install = { platform, deliver };
  const key = threadKey(platform, user); // one conversation thread per user

  try {
    const { text: reply, usage, calls } = await runAgent({
      userText: text,
      history: await getHistory(key),
      tools,
      system,
      policy: DEFAULT_POLICY, // read-only
      // team = per-USER tenant (`whatsapp:+31…`, `telegram:12345`), not the bare platform: the
      // watch tools scope list/cancel by ctx.team, and a shared 'whatsapp' tenant would let any
      // user list — and cancel — every other user's watches.
      context: { channel: user, user, team: `${platform}:${user}`, platform, deliver },
    });
    const out = (reply || '(no answer)').slice(0, maxReply);
    const day = await recordUsage(platform, usage);
    console.log(`[${platform}]   → tools: ${calls.join(', ') || 'none'} · ${usage.input}+${usage.output} tok · replied ${out.length} chars` +
      (day ? ` · today ${day.messages} msg` : ''));
    await send(install, { text: out });
    await appendTurn(key, text, out);
  } catch (e) {
    console.error(`[${platform}] agent error:`, e.message);
    await send(install, { text: `⚠️ Sorry — I hit an error: ${e.message}` }).catch(() => {});
  }
}
