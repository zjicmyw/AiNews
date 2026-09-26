import { isIP } from "node:net";

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const [first, second] = normalized.split(":").map((part) => Number.parseInt(part || "0", 16));
    // Accept global unicast only; exclude special-use and transition networks.
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
  }
  return false;
}

export function isPublicHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host)) return isPublicAddress(host);
  return host.includes(".") && !/(^|\.)(localhost|local|internal|home|test|invalid)$/.test(host);
}

export function xStatus(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/([a-z0-9_]{1,15})\/status\/(\d+)\/?$/i);
    return match ? { account: match[1].toLowerCase(), id: match[2], url: `https://x.com/${match[1].toLowerCase()}/status/${match[2]}` } : null;
  } catch { return null; }
}

export function canonicalSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !isPublicHostname(url.hostname)) return "";
    if (["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) return xStatus(value)?.url || "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return ""; }
}
