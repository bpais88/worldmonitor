// Watch tools — let the agent set/list/cancel proactive alerts. Read-class (no
// approval gate): creating a watch is benign (just a reminder). They need the
// live channel context, which the agent loop now passes to every handler.
import { createWatch, listWatches, cancelWatch } from '../watches.mjs';

export const watchTools = [
  {
    name: 'create_watch',
    description:
      'Create a proactive watch that alerts THIS channel when a condition occurs. type "port_congestion" (target = port name) with condition: "clears" (alert only when it becomes clear), "busy" (only when it turns busy/congested), or "any" (any change). type "vessel_delay" (target = vessel name) alerts when that vessel becomes delayed. Map the user\'s wording: "when X clears" → condition "clears"; "when X is busy/congested" → "busy"; otherwise "any".',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['port_congestion', 'vessel_delay'] },
        target: { type: 'string', description: 'port name (for port_congestion) or vessel name (for vessel_delay)' },
        condition: { type: 'string', enum: ['clears', 'busy', 'any'], description: 'port_congestion only; which transition to alert on (default any)' },
      },
      required: ['type', 'target'],
      additionalProperties: false,
    },
    handler: async ({ type, target, condition = 'any' }, ctx = {}) => {
      if (!ctx.channel) return { error: 'no channel context to attach the watch to' };
      const w = await createWatch({ type, target, condition, channel: ctx.channel, thread: ctx.thread, createdBy: ctx.user });
      return { created: true, id: w.id, type: w.type, target: w.target, condition: w.condition };
    },
  },
  {
    name: 'list_watches',
    description: 'List active proactive watches (id, type, target). Use for "what am I watching", "list alerts".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const ws = await listWatches();
      return { count: ws.length, watches: ws.map((w) => ({ id: w.id, type: w.type, target: w.target })) };
    },
  },
  {
    name: 'cancel_watch',
    description: 'Cancel a proactive watch by id (get ids from list_watches). Use for "stop watching X", "cancel that alert".',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async ({ id }) => ({ cancelled: await cancelWatch(id), id }),
  },
];
