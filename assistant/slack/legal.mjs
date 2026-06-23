// Privacy policy + support pages served by the assistant at /privacy and /support.
// Slack public distribution requires public URLs for both. Single source of truth
// (these strings) — kept here rather than a separate host so the URLs exist the
// moment the service is up. Update the SUPPORT_EMAIL / entity here if they change.

const SUPPORT_EMAIL = 'bruno.pais88@gmail.com';
const ENTITY = 'Bruno Pais';
const UPDATED = '2026-06-23';
const RESPONSE_TIME = '2 business days';

function page(title, bodyHtml) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title} — Marco</title>` +
    `<body style="font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:6vh auto;padding:0 24px;color:#1a1a1a;line-height:1.6">` +
    `${bodyHtml}<hr style="margin-top:48px;border:none;border-top:1px solid #ddd">` +
    `<p style="color:#888;font-size:13px">Marco — freight-ops coworker for Slack · Last updated ${UPDATED}</p></body>`;
}

export function privacyHtml() {
  return page('Privacy Policy', `
    <h1>Privacy Policy — Marco</h1>
    <p><em>Last updated: ${UPDATED}</em></p>
    <p>Marco ("the app", "we") is a Slack app that answers questions about live commercial
    freight traffic in Italian ports and sends proactive alerts. This policy explains what
    data Marco processes, why, where it goes, and how to delete it.</p>
    <p><strong>Provider:</strong> ${ENTITY}<br><strong>Contact:</strong> <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>

    <h2>What we process</h2>
    <ul>
      <li><strong>Slack messages directed at Marco</strong> — the text of messages where Marco is @mentioned or messaged directly. We do <strong>not</strong> read other channel messages.</li>
      <li><strong>Slack identifiers</strong> — workspace (team) ID, channel ID, and the user ID of the person interacting, to route replies and enforce who may approve actions.</li>
      <li><strong>Workspace configuration</strong> — your action-approver allowlist and the watches you create.</li>
      <li><strong>Operational metadata</strong> — per-workspace counts of messages and AI tokens used (for capacity and abuse prevention). No message content is stored in these counters.</li>
      <li><strong>Maritime data</strong> — public AIS data about ships (positions, port congestion, ETAs), not personal data about you.</li>
    </ul>
    <p>We do <strong>not</strong> sell your data or use it to train AI models.</p>

    <h2>Sub-processors</h2>
    <ul>
      <li><strong>Anthropic</strong> — the AI model that generates Marco's responses. Message text you send Marco is transmitted to Anthropic for processing.</li>
      <li><strong>Upstash (Redis)</strong> — stores your workspace token, configuration, watches, short-term conversation context, and usage counters.</li>
      <li><strong>Railway</strong> — hosting.</li>
      <li><strong>Marinesia</strong> — source of live AIS / maritime data (no personal data sent).</li>
      <li><strong>Slack</strong> — the platform Marco runs on.</li>
    </ul>

    <h2>Retention</h2>
    <ul>
      <li><strong>Conversation context:</strong> short-term only — auto-deleted after ~1 hour of thread inactivity.</li>
      <li><strong>Watches &amp; configuration:</strong> kept until you cancel the watch or uninstall Marco.</li>
      <li><strong>Workspace token:</strong> kept until you uninstall Marco.</li>
      <li><strong>Usage counters:</strong> daily counters retained ~120 days, then auto-expire.</li>
    </ul>

    <h2>Deleting your data</h2>
    <p>Removing Marco from your Slack workspace (Slack → Manage apps → Remove) triggers an uninstall event;
    Marco then deletes that workspace's stored token and configuration. For any remaining data, email
    <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

    <h2>Security</h2>
    <ul>
      <li>All inbound Slack requests are verified by Slack's request signature.</li>
      <li>Each workspace's bot token is stored separately and used only for that workspace.</li>
      <li>Actions that change anything are never auto-run — they require explicit approval by an authorized user in your workspace.</li>
    </ul>

    <h2>Contact</h2>
    <p>Questions or data requests: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
  `);
}

export function supportHtml() {
  return page('Support', `
    <h1>Marco — Support</h1>
    <p>Marco is your freight-ops coworker in Slack: ask about live Italian-port freight traffic,
    port congestion, vessels and ETAs, and set proactive alerts.</p>

    <h2>Getting started</h2>
    <ol>
      <li>Add Marco to your Slack workspace via <strong>Add to Slack</strong>.</li>
      <li>Marco will DM you to say hello and ask which ports/operators to watch.</li>
      <li><strong>@mention Marco</strong> in any channel, or DM him, to ask a question.</li>
    </ol>

    <h2>Things you can ask</h2>
    <ul>
      <li>"Which ports are congested right now?"</li>
      <li>"Where's the MOBY FANTASY?"</li>
      <li>"Watch Genoa and tell me when it clears."</li>
      <li>"How many trips did you track this week?"</li>
    </ul>

    <h2>Common questions</h2>
    <ul>
      <li><strong>Marco didn't reply.</strong> In channels you must @mention him; thread follow-ups currently need another @mention.</li>
      <li><strong>The numbers changed between answers.</strong> The data is a live feed and shifts between readings — Marco timestamps figures and flags when the feed is still warming up or stale.</li>
      <li><strong>"You're not authorized to approve actions."</strong> Only approvers configured for your workspace can approve actions; the installer is an approver by default.</li>
    </ul>

    <h2>Removing Marco</h2>
    <p>Slack → <strong>Manage apps</strong> → Marco → <strong>Remove</strong>. This deletes your workspace's stored token and configuration.</p>

    <h2>Contact</h2>
    <p>Need help or want to report a problem? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> (typical response within ${RESPONSE_TIME}).</p>
  `);
}
