/**
 * URL normalization for same-link deduplication.
 * Removes tracking params, normalizes hostname, preserves item IDs.
 */

const STRIP_PARAMS = new Set([
  'fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'spm', 'aff', 'ref', 'referrer', 'affiliate_id', 'source',
  '_ga', 'gclid', 'msclkid', 'yclid',
]);

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());

    // Lowercase hostname
    u.hostname = u.hostname.toLowerCase();

    // Remove www. prefix for consistency
    u.hostname = u.hostname.replace(/^www\./, '');

    // Strip tracking query params
    const keysToDelete: string[] = [];
    u.searchParams.forEach((_v, k) => {
      if (STRIP_PARAMS.has(k.toLowerCase())) keysToDelete.push(k);
    });
    keysToDelete.forEach(k => u.searchParams.delete(k));

    // Sort remaining params for consistency
    u.searchParams.sort();

    // Remove trailing slash from path
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';

    // Remove fragment
    u.hash = '';

    // Remove default ports
    if ((u.protocol === 'https:' && u.port === '443') ||
        (u.protocol === 'http:'  && u.port === '80')) {
      u.port = '';
    }

    return u.toString();
  } catch {
    // Invalid URL — return cleaned raw string as fallback
    return raw.trim().toLowerCase().replace(/\/+$/, '');
  }
}
