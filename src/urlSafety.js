const dns = require('dns').promises;
const ipaddr = require('ipaddr.js');

/**
 * Reject URLs that would let the audit pipeline reach internal infrastructure:
 *   - non-http(s) schemes (file://, ftp://, gopher://, ...)
 *   - hostnames that resolve to loopback (127.0.0.0/8, ::1)
 *   - hostnames that resolve to private ranges (10/8, 172.16/12, 192.168/16, fc00::/7)
 *   - hostnames that resolve to link-local (169.254/16, fe80::/10) — AWS/GCP metadata lives here
 *   - hostnames that don't resolve at all
 *
 * This is the standard SSRF defense for any service that fetches user-supplied URLs.
 */
async function isUrlSafe(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https URLs are allowed' };
  }

  // Explicitly reject literal IPs that are private / loopback / link-local before DNS,
  // so we also catch URLs like http://127.0.0.1 or http://169.254.169.254 directly.
  if (ipaddr.isValid(parsed.hostname)) {
    const range = ipaddr.parse(parsed.hostname).range();
    if (range !== 'unicast') {
      return { ok: false, reason: `URL points at a non-public network (${range})` };
    }
    return { ok: true };
  }

  // Hostname — resolve and check every A/AAAA record.
  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch {
    return { ok: false, reason: 'Hostname could not be resolved' };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'Hostname has no DNS records' };
  }

  for (const { address } of addresses) {
    let parsedIp;
    try { parsedIp = ipaddr.parse(address); } catch { continue; }
    const range = parsedIp.range();
    // ipaddr.js: 'unicast' = public routable; anything else is unsafe.
    if (range !== 'unicast') {
      return { ok: false, reason: `URL resolves to a non-public network (${range})` };
    }
  }

  return { ok: true };
}

module.exports = { isUrlSafe };
