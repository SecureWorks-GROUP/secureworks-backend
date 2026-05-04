// T7 Loop 1 — Storage helper contract (DRAFT — Loop 3 implements live writes)
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 4)
//
// This module defines the bucket layout and pointer/hash contract. The
// recordEvidence helper calls writeBody() and computeHash() during Loop 1
// only in dry-run mode (no real bucket writes). Loop 3 wires this to live
// Supabase Storage after the buckets are provisioned.
//
// Bucket layout:
//   evidence-bodies        : full email bodies, full notes
//   evidence-attachments   : email attachments where no job match yet
//   evidence-audio         : call recordings (flag-OFF until Loop 7 ADR)
//   evidence-transcripts   : WhisperFlow transcripts (flag-OFF until Loop 7 ADR)
//
// Pointer pattern:
//   {org_id}/{channel}/{source_id}.{ext}
// Examples:
//   evidence-bodies/abc123/email/inbox-evt-9f8.txt
//   evidence-bodies/abc123/note/job-evt-77a.txt
//   evidence-attachments/abc123/orphan/inbox-evt-9f8/quote-attachment.pdf
//   evidence-audio/abc123/SWP-26090/calls/ghl-call-456.mp3
//   evidence-transcripts/abc123/SWP-26090/calls/ghl-call-456.json
//
// Integrity:
//   body_hash = SHA-256 of canonical body bytes (Uint8Array). For text,
//   canonicalize by trimming trailing whitespace per line and collapsing
//   to LF line endings before hashing. Stored in business_events.body_hash.
//
// Privacy:
//   All evidence buckets are PRIVATE. service-role only for write. Read
//   goes through ops-api?action=get_evidence_body which checks role +
//   per-job RLS.

import { Channel } from "./types.ts";

export interface WriteBodyInput {
  org_id: string;
  channel: Channel;
  source_id: string;
  body_full: string | Uint8Array;
  filename?: string;
  mime?: string;
  bucket?: string;                          // override default bucket
}

export interface WriteBodyResult {
  bucket: string;
  path: string;
  pointer: string;                          // bucket://path
  hash: string;                             // sha256 hex
  bytes: number;
}

export const BUCKET_FOR_CHANNEL: Partial<Record<Channel, string>> = {
  email: "evidence-bodies",
  note: "evidence-bodies",
  sms: "evidence-bodies",                   // rarely used; SMS fits inline
  telegram: "evidence-bodies",
  call: "evidence-audio",                   // audio path
  document: "job-photos",                   // existing bucket
};

/**
 * Compute SHA-256 hex of a body. Canonicalizes text input by collapsing
 * line endings to LF and trimming trailing whitespace per line.
 */
export async function computeHash(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === "string"
    ? new TextEncoder().encode(canonicalizeText(body))
    : body;
  // Slice into a fresh ArrayBuffer to satisfy crypto.subtle.digest's
  // BufferSource type (Uint8Array<ArrayBufferLike> is not assignable to
  // ArrayBufferView<ArrayBuffer> in modern Deno TS lib).
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
}

/**
 * Default extension chooser based on mime / filename.
 */
export function pickExtension(mime: string | undefined, filename: string | undefined): string {
  if (filename) {
    const m = filename.match(/\.[a-z0-9]+$/i);
    if (m) return m[0];
  }
  if (!mime) return ".txt";
  if (mime.startsWith("text/")) return ".txt";
  if (mime === "application/json") return ".json";
  if (mime === "application/pdf") return ".pdf";
  if (mime.startsWith("audio/mpeg")) return ".mp3";
  if (mime.startsWith("audio/")) return ".audio";
  if (mime.startsWith("image/jpeg")) return ".jpg";
  if (mime.startsWith("image/png")) return ".png";
  return ".bin";
}

/**
 * Build the canonical pointer path for a body.
 */
export function buildPointerPath(input: {
  org_id: string;
  channel: Channel;
  source_id: string;
  job_id?: string | null;
  filename?: string;
  mime?: string;
  bucket: string;
}): string {
  const ext = pickExtension(input.mime, input.filename);
  // Audio/transcript paths include the job for organisational clarity.
  if (input.bucket === "evidence-audio" || input.bucket === "evidence-transcripts") {
    const job = input.job_id ?? "unmatched";
    return `${input.org_id}/${job}/${input.channel}/${input.source_id}${ext}`;
  }
  // Attachments without job match go to orphan/.
  if (input.bucket === "evidence-attachments") {
    const subdir = input.job_id ?? "orphan";
    const fname = input.filename ?? `${input.source_id}${ext}`;
    return `${input.org_id}/${subdir}/${input.source_id}/${fname}`;
  }
  // Bodies bucket.
  return `${input.org_id}/${input.channel}/${input.source_id}${ext}`;
}

/**
 * Write a body to storage. Two modes:
 *
 *   - With `storage_client` (live mode, Loop 3+): uploads bytes to
 *     Supabase Storage and returns the canonical pointer. Hash always
 *     computed from the canonical body (not from what came back).
 *
 *   - Without `storage_client` (stub mode, Loop 1 tests + dry runs):
 *     returns the would-be pointer + computed hash without touching
 *     Storage.
 *
 * The hash is the SAME in both modes — that's the point. recordEvidence
 * stores body_hash on the spine row regardless of whether the bucket
 * actually accepted the upload, so a later integrity check can detect
 * silent storage failures.
 */
export async function writeBody(
  input: WriteBodyInput,
  // deno-lint-ignore no-explicit-any
  storage_client?: any,
): Promise<WriteBodyResult> {
  const bucket = input.bucket ?? BUCKET_FOR_CHANNEL[input.channel] ?? "evidence-bodies";
  const path = buildPointerPath({
    org_id: input.org_id,
    channel: input.channel,
    source_id: input.source_id,
    filename: input.filename,
    mime: input.mime,
    bucket,
  });
  const bodyBytes = typeof input.body_full === "string"
    ? new TextEncoder().encode(input.body_full)
    : input.body_full;
  const hash = await computeHash(input.body_full);
  const bytes = bodyBytes.byteLength;

  if (storage_client) {
    try {
      const { error } = await storage_client.from(bucket).upload(path, bodyBytes, {
        contentType: input.mime ?? "application/octet-stream",
        upsert: true,
        duplex: "half",
      });
      if (error) {
        // Re-throw with context. recordEvidence catches and downgrades
        // to a warning + spine row without body_pointer if needed.
        throw new Error(`storage upload failed: ${error.message ?? error}`);
      }
    } catch (e) {
      throw new Error(
        `writeBody: ${bucket}/${path}: ${(e as Error).message ?? "unknown"}`,
      );
    }
  }

  return {
    bucket,
    path,
    pointer: `${bucket}://${path}`,
    hash,
    bytes,
  };
}

/**
 * Resolve a `bucket://path` pointer back to its components.
 */
export function parsePointer(pointer: string): { bucket: string; path: string } | null {
  const m = pointer.match(/^([a-z0-9-]+):\/\/(.+)$/i);
  if (!m) return null;
  return { bucket: m[1], path: m[2] };
}

/**
 * Read a body back from storage and verify its hash.
 *
 * Returns the body bytes when verification passes, or throws on:
 *   - malformed pointer
 *   - storage download failure
 *   - hash mismatch
 *
 * Used by ops-api?action=get_evidence_body before signing a URL.
 */
export async function readBodyAndVerify(
  // deno-lint-ignore no-explicit-any
  storage_client: any,
  pointer: string,
  expected_hash: string,
): Promise<Uint8Array> {
  const parts = parsePointer(pointer);
  if (!parts) throw new Error(`readBodyAndVerify: malformed pointer: ${pointer}`);
  const { data, error } = await storage_client.from(parts.bucket).download(parts.path);
  if (error || !data) {
    throw new Error(`readBodyAndVerify: download failed: ${error?.message ?? "no data"}`);
  }
  const buf = new Uint8Array(await (data as Blob).arrayBuffer());
  const actual = await computeHash(buf);
  if (actual !== expected_hash) {
    throw new Error(
      `readBodyAndVerify: hash mismatch (expected ${expected_hash} got ${actual})`,
    );
  }
  return buf;
}

/**
 * Sign a time-limited URL for the body. Caller MUST have done the role
 * check before calling; this only signs.
 */
export async function signBodyUrl(
  // deno-lint-ignore no-explicit-any
  storage_client: any,
  pointer: string,
  ttl_seconds = 300,
): Promise<string> {
  const parts = parsePointer(pointer);
  if (!parts) throw new Error(`signBodyUrl: malformed pointer: ${pointer}`);
  const { data, error } = await storage_client
    .from(parts.bucket)
    .createSignedUrl(parts.path, ttl_seconds);
  if (error || !data?.signedUrl) {
    throw new Error(`signBodyUrl: ${error?.message ?? "no url"}`);
  }
  return data.signedUrl;
}
