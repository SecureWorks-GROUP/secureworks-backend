// deno-lint-ignore-file no-import-prefix
/** Regression: artifact content hashing must stay inside the worker resource budget.
 *
 * The persist path of `prepare_ses_docket_revision` returned HTTP 546 WORKER_RESOURCE_LIMIT on
 * every docket carrying real photos, while the identical dry run finished in seconds. Cause:
 * `artifactFromBytes` hashed via `sesSha256(Array.from(bytes))`, which expanded each byte into a
 * JS number and then into a decimal JSON string before digesting it. Measured ~20x transient
 * allocation: a 14 MB photo set peaked around 294 MB and aborted V8.
 *
 * These tests fail on that shape and pass on the direct-byte digest.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  artifactFromBytes,
  artifactFromText,
  SES_ARTIFACT_BYTES_DOMAIN,
  sesSha256Bytes,
} from "./ses_docket_envelope.ts";

/** The realistic worst case measured on the live board: SWMS-261109 carries 35 current-cycle
 * photos totalling 14.4 MB. Hash a little more than that so the test has headroom. */
const WORST_CASE_MB = 16;
/** Supabase edge workers abort well below this; the old shape needed ~20x the input. */
const HEAP_CAP_MB = 192;

function buffer(mb: number): Uint8Array {
  const bytes = new Uint8Array(Math.floor(mb * 1024 * 1024));
  // Vary the head so the digest is not trivially the all-zero digest.
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) bytes[i] = (i * 31) % 251;
  return bytes;
}

Deno.test("artifact byte hashing stays inside a constrained worker heap", async () => {
  // A subprocess with a hard old-space cap is the honest reproduction of the worker limit: the
  // pre-fix implementation aborts here, the fixed one completes comfortably.
  const script = `
    import { artifactFromBytes } from "${new URL("./ses_docket_envelope.ts", import.meta.url).href}";
    const bytes = new Uint8Array(${WORST_CASE_MB} * 1024 * 1024);
    for (let i = 0; i < 4096; i++) bytes[i] = (i * 31) % 251;
    const artifact = await artifactFromBytes({
      role: "completion_photo", path: "ARTIFACTS/photos/001-x.jpg",
      media_type: "image/jpeg", bytes,
    });
    if (!artifact.content_hash.startsWith("sha256:")) throw new Error("no hash");
    if (artifact.size_bytes !== bytes.byteLength) throw new Error("size drift");
    console.log("OK");
  `;
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      `--v8-flags=--max-old-space-size=${HEAP_CAP_MB}`,
      "-",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();
  const output = await child.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  assert(
    output.success,
    `hashing ${WORST_CASE_MB} MB aborted under a ${HEAP_CAP_MB} MB heap cap, which is the ` +
      `WORKER_RESOURCE_LIMIT the persist path hit in production:\n${stderr}`,
  );
  assert(stdout.includes("OK"), stdout + stderr);
});

Deno.test("artifact hashing allocates a bounded multiple of the input, not ~20x", async () => {
  const bytes = buffer(WORST_CASE_MB);
  const before = Deno.memoryUsage().heapUsed;
  await artifactFromBytes({
    role: "completion_photo",
    path: "ARTIFACTS/photos/001-x.jpg",
    media_type: "image/jpeg",
    bytes,
  });
  const grew = Deno.memoryUsage().heapUsed - before;
  const budget = bytes.byteLength * 4;
  assert(
    grew < budget,
    `hashing grew the heap by ${(grew / 1048576).toFixed(0)} MB for a ` +
      `${WORST_CASE_MB} MB artifact; budget is ${(budget / 1048576).toFixed(0)} MB`,
  );
});

Deno.test("the artifact content hash is SHA-256 over domain || bytes, verbatim", async () => {
  // Pins the contract so the digest input can never quietly become a re-encoding of the bytes.
  const bytes = buffer(0.25);
  const prefix = new TextEncoder().encode(SES_ARTIFACT_BYTES_DOMAIN);
  const framed = new Uint8Array(prefix.byteLength + bytes.byteLength);
  framed.set(prefix, 0);
  framed.set(bytes, prefix.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", framed));
  const expected = "sha256:" +
    Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(await sesSha256Bytes(bytes), expected);
  const artifact = await artifactFromBytes({
    role: "completion_photo",
    path: "ARTIFACTS/photos/001-x.jpg",
    media_type: "image/jpeg",
    bytes,
  });
  assertEquals(artifact.content_hash, expected);
});

Deno.test("hashing still covers every byte: any single-byte change moves the hash", async () => {
  // The fix must not have bought its budget by sampling or truncating the evidence.
  const bytes = buffer(1);
  const base = await sesSha256Bytes(bytes);
  for (const index of [0, 1, bytes.length >> 1, bytes.length - 2, bytes.length - 1]) {
    const mutated = bytes.slice();
    mutated[index] = mutated[index] ^ 0xff;
    const moved = await sesSha256Bytes(mutated);
    assert(moved !== base, `flipping byte ${index} did not change the artifact hash`);
  }
  assertEquals(await sesSha256Bytes(bytes), base, "hashing must be deterministic");
});

Deno.test("text and byte artifacts agree on identical content", async () => {
  const text = "completion photo proof envelope";
  const fromText = await artifactFromText({
    role: "completion_photo_proof",
    path: "PROOF/photos/001.json",
    media_type: "application/json",
    text,
  });
  const fromBytes = await artifactFromBytes({
    role: "completion_photo",
    path: "ARTIFACTS/photos/001-x.jpg",
    media_type: "image/jpeg",
    bytes: new TextEncoder().encode(text),
  });
  assertEquals(fromText.content_hash, fromBytes.content_hash);
});
