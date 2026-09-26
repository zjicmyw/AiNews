import https from "node:https";
import { lookup } from "node:dns/promises";
import { isPublicAddress, isPublicHostname } from "./sourceUrls.js";

export function publicHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && isPublicHostname(url.hostname);
  } catch { return false; }
}

export async function fetchPublicPage(value, { signal, lookupFn = lookup, requestFn = https.request, headers = {} } = {}) {
  if (!publicHttpsUrl(value)) throw new Error("invalid_public_https_url");
  const url = new URL(value);
  signal?.throwIfAborted();
  const addresses = await new Promise((resolve, reject) => {
    const abort = () => reject(new Error("official_dns_aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => lookupFn(url.hostname.replace(/^\[|\]$/g, ""), { all: true, verbatim: true }))
      .then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("non_public_dns_address");
  signal?.throwIfAborted();
  const selected = addresses[0];
  // Pin the validated address at connection time; TLS still verifies the original hostname.
  return new Promise((resolve, reject) => {
    const request = requestFn(url, {
      agent: false, signal, headers,
      lookup: (_host, options, callback) => options.all
        ? callback(null, [selected]) : callback(null, selected.address, selected.family)
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("error", reject);
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          request.destroy(new Error("official_page_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode, url: url.href,
        headers: { get: (name) => response.headers[name.toLowerCase()] || null },
        text: async () => Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end();
  });
}
