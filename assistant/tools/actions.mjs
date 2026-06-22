// ACTION tools — these mutate state or reach outward, so each is marked
// kind:'action' and is gated by the guardrail policy (see guardrails.mjs). They
// register exactly like read tools; the agent loop enforces the policy.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const REPORTS_DIR = process.env.ASSISTANT_REPORTS_DIR || 'reports';

export const actionTools = [
  {
    name: 'save_freight_report',
    kind: 'action',
    description:
      'Save a freight status report (markdown) to the reports folder. Use when the user asks to save/export/write a report to a file.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'base file name, e.g. "adriatic-congestion"' },
        markdown: { type: 'string', description: 'the full report content in markdown' },
      },
      required: ['filename', 'markdown'],
      additionalProperties: false,
    },
    handler: async ({ filename, markdown }) => {
      // Sanitize: strip path separators / traversal, force .md, keep inside REPORTS_DIR.
      const base = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '');
      const name = base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
      const full = path.join(REPORTS_DIR, name);
      await fs.mkdir(REPORTS_DIR, { recursive: true });
      await fs.writeFile(full, String(markdown), 'utf8');
      return { saved: full, bytes: Buffer.byteLength(String(markdown)) };
    },
  },
  {
    name: 'send_slack_alert',
    kind: 'action',
    description:
      'Post a short alert message to the team Slack channel. Use only when explicitly asked to notify/alert the team. Outward-facing — requires actions to be enabled.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'the message to post' } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async ({ text }) => {
      const url = process.env.SLACK_WEBHOOK_URL || '';
      if (!url) return { error: 'SLACK_WEBHOOK_URL is not configured — cannot post to Slack' };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return { error: `Slack post failed: HTTP ${res.status}` };
      return { posted: true };
    },
  },
];
