// Teams (Bot Framework) request router — the Teams adapter's receive half, mirroring
// the Slack adapter: verify the inbound request, ack fast (<5s), then handle async.
// For now it ECHOES message text so the end-to-end loop is verifiable; the real agent
// run + Adaptive-card approvals + conversation-reference capture land in later PRs.
import { verifyTeamsToken } from './verify.mjs';
import { normalizeTeamsActivity, shouldRespond } from './normalize.mjs';
import { replyToActivity } from './connector.mjs';

const MS_APP_ID = process.env.MS_APP_ID || '';
const MS_APP_SECRET = process.env.MS_APP_SECRET || '';

export async function handleTeamsRequest(req, res, body) {
  let activity;
  try { activity = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }

  // Verify the Microsoft-signed JWT (incl. the serviceUrl anti-spoof). 403 on failure.
  try {
    await verifyTeamsToken({ authHeader: req.headers.authorization, appId: MS_APP_ID, serviceUrl: activity.serviceUrl });
  } catch (e) {
    console.warn('[teams] auth rejected:', e.message);
    res.writeHead(403); return res.end();
  }

  res.writeHead(200); res.end(); // ack fast, like the Slack adapter
  void dispatch(activity);
}

async function dispatch(activity) {
  try {
    if (activity.type === 'message' && shouldRespond(activity)) {
      const n = normalizeTeamsActivity(activity);
      console.log(`[teams] msg @${n.userId} in ${n.tenantId}/${n.channelId}: "${n.text.slice(0, 100)}"`);
      // PR2: echo to prove the loop. Real agent wiring lands in the next PR.
      await replyToActivity(activity, `🔁 ${n.text}`, { appId: MS_APP_ID, appSecret: MS_APP_SECRET });
    } else if (activity.type === 'conversationUpdate') {
      // First contact / install — the conversation-reference capture lands later.
      console.log(`[teams] conversationUpdate in ${activity.conversation?.id}`);
    }
  } catch (e) {
    console.error('[teams] dispatch error:', e.message);
  }
}
