// Teams Adaptive Card approval flow — the Teams analog of Slack's Block Kit approve/reject.
// The agent PROPOSES an action (dry-run); we post this card; on click the buttons round-trip
// the pending-action id back as `activity.value` (object-data Action.Submit, which arrives as
// a `message` with `value` set and `text` empty — per the Teams docs). Teams renders Adaptive
// Cards 1.5 but does NOT support positive/destructive button colour, so the decision rides in
// `data`, not styling.

const CARD_KIND = 'approval'; // marks OUR submits so the router can tell them from typed messages

const summarizeInput = (input) => {
  const s = JSON.stringify(input ?? {});
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

/** The proposal card content (send() wraps it in an adaptive-card attachment). actionId = pending id. */
export function approvalCard(actionId, tool, input) {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: `🔧 Proposed action: **${tool}**`, wrap: true },
      { type: 'TextBlock', text: summarizeInput(input), wrap: true, isSubtle: true, spacing: 'small' },
      { type: 'TextBlock', text: 'Approve to run it, or reject.', wrap: true, spacing: 'small' },
    ],
    actions: [
      { type: 'Action.Submit', title: '✅ Approve', data: { kind: CARD_KIND, decision: 'approve', actionId } },
      { type: 'Action.Submit', title: '❌ Reject', data: { kind: CARD_KIND, decision: 'reject', actionId } },
    ],
  };
}

/**
 * True when an inbound activity is one of OUR card button submits (not a typed message).
 * An object-data Action.Submit arrives as a `message` with `value` set and `text` empty; the
 * `kind` marker guards against unrelated cards' submits. The router routes these to the
 * approval handler instead of the agent.
 */
export function isCardSubmit(activity = {}) {
  const v = activity.value;
  return activity.type === 'message' && !!v && typeof v === 'object' && v.kind === CARD_KIND
    && (activity.text == null || activity.text === '');
}
