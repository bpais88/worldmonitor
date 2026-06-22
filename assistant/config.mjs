// Shared config for the Italy Freight assistant (interactive agent).
export const RELAY_URL = (process.env.RELAY_URL || 'http://localhost:3004').replace(/\/$/, '');
export const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET || '';
export const RELAY_AUTH_HEADER = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// Sonnet 4.6 — fast + capable, the sweet spot for tool-use chat. Override via env.
export const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL || 'claude-sonnet-4-6';
