# Privacy Policy — Marco (freight-ops Slack app)

_Last updated: 2026-06-22 · Draft for review — fill the **{{PLACEHOLDERS}}** and host
at a public URL before activating Slack public distribution._

Marco ("the app", "we") is a Slack app that answers questions about live commercial
freight traffic in Italian ports and sends proactive alerts. This policy explains what
data Marco processes, why, where it goes, and how to delete it.

**Provider:** {{LEGAL_ENTITY / YOUR NAME}}
**Contact:** {{SUPPORT_EMAIL}}

## What we process

- **Slack messages directed at Marco** — the text of messages where Marco is
  @mentioned or messaged directly. We do **not** read other channel messages.
- **Slack identifiers** — workspace (team) ID, channel ID, and the user ID of the
  person interacting, used to route replies and enforce who may approve actions.
- **Workspace configuration** — your action-approver allowlist and the watches you
  create (e.g. "alert when Genoa clears").
- **Operational metadata** — per-workspace counts of messages and AI tokens used
  (for capacity and abuse prevention). No message content is stored in these counters.
- **Maritime data** — vessel positions, port congestion and ETAs. This is public AIS
  data about ships, not personal data about you.

We do **not** sell your data or use it to train AI models.

## How we use it

- To understand your question and generate an answer.
- To send proactive alerts you asked for (watches).
- To gate actions (e.g. posting a report) behind per-workspace approval.
- To meter usage for capacity and abuse prevention.

## Sub-processors

Marco relies on these services to operate:

- **Anthropic** — the AI model that generates Marco's responses. Message text you send
  Marco is transmitted to Anthropic for processing.
- **Upstash (Redis)** — stores your workspace token, configuration, watches, short-term
  conversation context, and usage counters.
- **Railway** — hosting for the Marco service.
- **Marinesia** — source of the live AIS / maritime data (no personal data sent).
- **Slack** — the platform Marco runs on.

## Retention

- **Conversation context:** short-term only — automatically deleted after ~1 hour of
  thread inactivity.
- **Watches & configuration:** kept until you cancel the watch or uninstall Marco.
- **Workspace token:** kept until you uninstall Marco.
- **Usage counters:** daily counters retained ~40 days, then auto-expire.

## Deleting your data

Removing Marco from your Slack workspace (Slack → Manage apps → Remove) triggers an
uninstall event; Marco then **deletes that workspace's stored token and configuration**.
To request deletion of any remaining data, email {{SUPPORT_EMAIL}}.

## Security

- All inbound Slack requests are verified by Slack's request signature.
- Each workspace's bot token is stored separately and used only for that workspace.
- Actions that change anything are never auto-run — they require explicit approval by an
  authorized user in your workspace.

## Changes

We may update this policy; material changes will be reflected by the "Last updated"
date above.

## Contact

Questions or data requests: **{{SUPPORT_EMAIL}}**.
