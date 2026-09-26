import crypto from "node:crypto";
import { canonicalSourceUrl } from "./sourceUrls.js";

const hash = (parts) => crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const normalize = (value) => String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
export function securitySourceKey(item, source = item.source_url) {
  return hash([normalize(item.project), normalize(item.incident_type), canonicalSourceUrl(source)]);
}
export function securityEventIdentity(item) {
  const reference = canonicalSourceUrl(item.event_reference_url);
  const eventTime = item.event_time ? new Date(item.event_time).toISOString() : "";
  return hash([normalize(item.project), normalize(item.incident_type),
    reference ? `reference:${reference}` : eventTime ? `time:${eventTime}` : `source:${canonicalSourceUrl(item.source_url)}`]);
}
