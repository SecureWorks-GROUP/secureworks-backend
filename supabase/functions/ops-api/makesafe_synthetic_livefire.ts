// Cryptographic admission boundary for the production SES synthetic live-fire
// lab. The token authorises one short-lived fixture from the one controlled
// SecureWorks sender; it is not a general own-domain bypass.

export const SYNTHETIC_LIVEFIRE_MARKER_PREFIX = "SWG-SES-LIVEFIRE-TEST-ONLY-";
export const SYNTHETIC_LIVEFIRE_SENDER = "marnin@secureworkswa.com.au";
export const SYNTHETIC_LIVEFIRE_MAILBOX = "ses@secureworkswa.com.au";

const TOKEN_VERSION = "V1";
const MAX_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const SAFE_PART_RE = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const SYNTHETIC_REF_RE = /^SYNTHLIVE-[A-Z0-9][A-Z0-9-]{0,63}$/;
const TOKEN_RE = new RegExp(
  String
    .raw`\b(${SYNTHETIC_LIVEFIRE_MARKER_PREFIX}[A-Z0-9][A-Z0-9-]{0,63}~[A-Z0-9][A-Z0-9-]{0,63}~SYNTHLIVE-[A-Z0-9][A-Z0-9-]{0,63}~\d{13}~${TOKEN_VERSION}~[0-9a-f]{64})\b`,
);

export interface SyntheticLivefireMarker {
  token: string;
  marker: string;
  runId: string;
  fixtureId: string;
  ref: string;
  expiresAtMs: number;
}

export interface SignSyntheticLivefireMarkerInput {
  runId: string;
  fixtureId: string;
  ref: string;
  expiresAtMs: number;
  secret: string;
}

export interface VerifySyntheticLivefireMarkerInput {
  value: string | null | undefined;
  sender: string | null | undefined;
  mailbox: string | null | undefined;
  nowMs: number;
  secret: string;
}

function canonicalPart(value: string, label: string): string {
  const canonical = String(value || "").trim().toUpperCase();
  if (!SAFE_PART_RE.test(canonical)) {
    throw new Error(
      `${label} must contain only 1-64 uppercase ASCII letters, digits or hyphens`,
    );
  }
  return canonical;
}

function canonicalRef(value: string): string {
  const canonical = String(value || "").trim().toUpperCase();
  if (!SYNTHETIC_REF_RE.test(canonical)) {
    throw new Error(
      "ref must use the reserved SYNTHLIVE- prefix and safe ASCII characters",
    );
  }
  return canonical;
}

function assertExpiresAt(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    String(value).length !== 13 ||
    value <= 0
  ) {
    throw new Error(
      "expiresAtMs must be a positive 13-digit epoch millisecond",
    );
  }
  return value;
}

function payload(
  marker: string,
  fixtureId: string,
  ref: string,
  expiresAtMs: number,
): string {
  return [
    TOKEN_VERSION,
    marker,
    fixtureId,
    ref,
    String(expiresAtMs),
    SYNTHETIC_LIVEFIRE_SENDER,
    SYNTHETIC_LIVEFIRE_MAILBOX,
  ].join("\n");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  return new Uint8Array(
    value.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  if (!String(secret || "").trim()) {
    throw new Error("synthetic live-fire signing secret is required");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
}

export async function signSyntheticLivefireMarker(
  input: SignSyntheticLivefireMarkerInput,
): Promise<string> {
  const runId = canonicalPart(input.runId, "runId");
  const fixtureId = canonicalPart(input.fixtureId, "fixtureId");
  const ref = canonicalRef(input.ref);
  const expiresAtMs = assertExpiresAt(input.expiresAtMs);
  const marker = `${SYNTHETIC_LIVEFIRE_MARKER_PREFIX}${runId}`;
  const signature = hex(
    await hmac(
      input.secret,
      payload(marker, fixtureId, ref, expiresAtMs),
    ),
  );
  return [
    marker,
    fixtureId,
    ref,
    String(expiresAtMs),
    TOKEN_VERSION,
    signature,
  ].join("~");
}

export function extractSyntheticLivefireMarker(
  value: string | null | undefined,
): SyntheticLivefireMarker | null {
  const token = String(value || "").match(TOKEN_RE)?.[1] || null;
  if (!token) return null;
  const [marker, fixtureId, ref, expiresRaw, version] = token.split("~");
  if (version !== TOKEN_VERSION) return null;
  const runId = marker.slice(SYNTHETIC_LIVEFIRE_MARKER_PREFIX.length);
  const expiresAtMs = Number(expiresRaw);
  if (
    !SAFE_PART_RE.test(runId) ||
    !SAFE_PART_RE.test(fixtureId) ||
    !SYNTHETIC_REF_RE.test(ref) ||
    !Number.isSafeInteger(expiresAtMs)
  ) return null;
  return { token, marker, runId, fixtureId, ref, expiresAtMs };
}

export async function verifySyntheticLivefireMarker(
  input: VerifySyntheticLivefireMarkerInput,
): Promise<SyntheticLivefireMarker | null> {
  if (
    String(input.sender || "").trim().toLowerCase() !==
      SYNTHETIC_LIVEFIRE_SENDER ||
    String(input.mailbox || "").trim().toLowerCase() !==
      SYNTHETIC_LIVEFIRE_MAILBOX ||
    !Number.isFinite(input.nowMs)
  ) return null;
  const parsed = extractSyntheticLivefireMarker(input.value);
  if (!parsed) return null;
  const remaining = parsed.expiresAtMs - input.nowMs;
  if (remaining <= 0 || remaining > MAX_TOKEN_LIFETIME_MS) return null;
  const actual = fromHex(parsed.token.split("~").at(-1) || "");
  if (!actual) return null;
  let expected: Uint8Array;
  try {
    expected = await hmac(
      input.secret,
      payload(
        parsed.marker,
        parsed.fixtureId,
        parsed.ref,
        parsed.expiresAtMs,
      ),
    );
  } catch {
    return null;
  }
  return constantTimeEqual(actual, expected) ? parsed : null;
}

export function stripSyntheticLivefireSignature(
  value: string | null | undefined,
): string {
  return String(value || "").replace(
    TOKEN_RE,
    (token) => token.split("~", 1)[0],
  ).replace(/[ \t]{2,}/g, " ").trim();
}
