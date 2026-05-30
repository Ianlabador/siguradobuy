/**
 * urlGuard.ts — SSRF protection for the server-side product-check fetcher.
 *
 * The /api/check endpoint fetches user-supplied URLs server-side. Without guarding,
 * an attacker could point it at internal services (localhost, cloud metadata at
 * 169.254.169.254, private LAN ranges) or non-web schemes (file://, ftp://).
 * This validates a URL is a safe, public http(s) marketplace link before fetching.
 */

const MAX_URL_LENGTH = 2048;

// Private / loopback / link-local / metadata ranges that must never be fetched.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Loopback / unspecified
  if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;

  // IPv4 literal checks
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 127) return true;                      // loopback
    if (a === 10) return true;                        // private
    if (a === 0) return true;                         // this-network
    if (a === 169 && b === 254) return true;          // link-local / cloud metadata
    if (a === 192 && b === 168) return true;          // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true;// carrier-grade NAT
  }

  // IPv6 private/loopback prefixes
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique-local
  if (h.startsWith('fe80')) return true;                      // link-local

  return false;
}

export interface UrlCheckResult { ok: boolean; reason?: string }

export function validateCheckUrl(raw: string): UrlCheckResult {
  if (!raw || typeof raw !== 'string') return { ok: false, reason: 'URL is required' };
  if (raw.length > MAX_URL_LENGTH)     return { ok: false, reason: 'URL is too long' };

  let u: URL;
  try { u = new URL(raw.trim()); }
  catch { return { ok: false, reason: 'Invalid URL' }; }

  // Only allow web schemes — blocks file://, ftp://, gopher://, data:, etc.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https links are allowed' };
  }

  if (isBlockedHost(u.hostname)) {
    return { ok: false, reason: 'This URL points to a private or internal address and cannot be checked' };
  }

  // Require a dotted host or known TLD (reject bare hostnames that could resolve internally)
  if (!u.hostname.includes('.')) {
    return { ok: false, reason: 'Invalid host' };
  }

  return { ok: true };
}
