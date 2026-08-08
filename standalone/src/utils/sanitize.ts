// Clean-room HTML/URL sanitizers for the standalone freight app (interface-compatible
// with the two functions the freight components import; implementation is original).

/** Escape a string for safe interpolation into HTML text/attribute positions. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Allow only http(s) (and same-origin relative) URLs for href/src positions.
 * Anything else — javascript:, data:, vbscript:, malformed — collapses to ''.
 */
export function sanitizeUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw; // same-origin relative
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}
