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
  // Slack posting lives in the Slack surface (post_report_to_channel) where the
  // live channel context + bot token are available — not as a webhook tool here.
];
