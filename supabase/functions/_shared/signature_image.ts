// A drawn signature is a PNG or JPEG data URL. SVG and any other payload
// are refused. An https storage URL may be shown, escaped, because the
// service-report and completion-pack pages store the drawing in storage
// and then point at that URL. Anything else is omitted from HTML.

export const SIGNATURE_DECODED_MAX = 150000;

const DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const HTTPS_URL = /^https:\/\/[^\s"'<>]+$/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A PNG or JPEG data URL whose decoded bytes are within the cap, or null. */
export function signatureDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || !DATA_URL.test(value)) return null;
  const payload = value.slice(value.indexOf("base64,") + "base64,".length);
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  if (binary.length < 3 || binary.length > SIGNATURE_DECODED_MAX) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (value.startsWith("data:image/png;")) {
    if (
      bytes.length < 4 || bytes[0] !== 0x89 || bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e || bytes[3] !== 0x47
    ) {
      return null;
    }
    return value;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return value;
}

/**
 * A src value safe to place in HTML. A validated data URL is returned as
 * stored (its alphabet has no quotes or markup). An https URL is escaped.
 * SVG, script, and any other scheme are null.
 */
export function safeSignatureImageSrc(value: unknown): string | null {
  const data = signatureDataUrl(value);
  if (data) return data;
  if (typeof value !== "string" || !HTTPS_URL.test(value)) return null;
  return escapeHtml(value);
}

/** An img tag, or an empty string when the source is not a safe signature. */
export function signatureImageTag(value: unknown, alt: string): string {
  const src = safeSignatureImageSrc(value);
  if (!src) return "";
  return `<img src="${src}" alt="${escapeHtml(alt)}">`;
}
