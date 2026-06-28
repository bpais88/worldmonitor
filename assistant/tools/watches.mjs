// Watch tools — let the agent set/list/cancel proactive alerts. Read-class (no
// approval gate): creating a watch is benign (just a reminder). They need the
// live channel context, which the agent loop now passes to every handler.
import { createWatch, listWatches, cancelWatch, cancelWatchesByTarget } from '../watches.mjs';

export const watchTools = [
  {
    name: 'create_watch',
    description:
      'Create a proactive watch that alerts THIS channel when a condition occurs. type "port_congestion" (target = port name) with condition: "clears" (alert only when it becomes clear), "busy" (only when it turns busy/congested), or "any" (any change). type "vessel_delay" (target = vessel name) alerts when that vessel becomes delayed. Map the user\'s wording: "when X clears" → condition "clears"; "when X is busy/congested" → "busy"; otherwise "any". After creating the watch, tell the user they can say "stop watching <target>" (or "stop alerting me about <target>") at any time to cancel it.',
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
      const w = await createWatch({ type, target, condition, channel: ctx.channel, thread: ctx.thread, createdBy: ctx.user, team: ctx.team, platform: ctx.platform, deliver: ctx.deliver });
      return {
        created: true, id: w.id, type: w.type, target: w.target, condition: w.condition,
        stopHint: `To stop these alerts, say "stop watching ${w.target}".`,
      };
    },
  },
  {
    name: 'list_watches',
    description: 'List THIS workspace\'s active proactive watches (id, type, target, condition). Use for "what am I watching", "list alerts".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_input, ctx = {}) => {
      const ws = await listWatches({ team: ctx.team });
      return { count: ws.length, watches: ws.map((w) => ({ id: w.id, type: w.type, target: w.target, condition: w.condition })) };
    },
  },
  {
    name: 'cancel_watch',
    description: 'Stop/cancel a proactive watch in THIS workspace. Preferred: pass `target` = the port or vessel name (e.g. "Porto Marghera") when the user says "stop watching X" / "stop alerting me about X" — it cancels every matching watch by name, no id needed. Alternatively pass `id` (from list_watches). Only affects this workspace\'s watches.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'port or vessel name to stop watching; cancels all matching watches in this workspace' },
        id: { type: 'string', description: 'watch id from list_watches (alternative to target)' },
      },
      additionalProperties: false,
    },
    handler: async ({ target, id } = {}, ctx = {}) => {
      if (target) {
        const cancelled = await cancelWatchesByTarget({ team: ctx.team, target });
        return { cancelled: cancelled.length, watches: cancelled.map((w) => ({ id: w.id, type: w.type, target: w.target })) };
      }
      if (id) return { cancelled: (await cancelWatch(id, { team: ctx.team })) ? 1 : 0, id };
      return { error: 'provide a target name or an id to cancel' };
    },
  },
];
