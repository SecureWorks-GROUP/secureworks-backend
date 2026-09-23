// Unit tests for the receiver's proof rules (slice C1b): key formats the
// GHL_WEBHOOK_PUBLIC_KEY env may hold, mode parsing, and proof classes.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acceptedProofsForType,
  importEd25519PublicKey,
  resolveAuthMode,
  safeId,
  timingSafeEqual,
  verifyEd25519Signature,
} from "./receiver_auth.ts";

const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const spki = b64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
const raw = b64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const message = '{"type":"InboundMessage","messageId":"pffXnIL1v2FTaKnz4DHm"}';
const signature = b64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(message))));

Deno.test("the public key is accepted as PEM, PEM with escaped newlines, bare SPKI or raw 32 bytes", async () => {
  const forms = [
    `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`,
    `-----BEGIN PUBLIC KEY-----\\n${spki}\\n-----END PUBLIC KEY-----`,
    spki,
    raw,
  ];
  for (const form of forms) {
    const key = await importEd25519PublicKey(form);
    assert(key, `key form not imported: ${form.slice(0, 30)}`);
    assert(await verifyEd25519Signature(key, signature, message));
    assertFalse(await verifyEd25519Signature(key, signature, message + " "));
  }
});

Deno.test("an unusable key text or signature is refused, never thrown", async () => {
  assertEquals(await importEd25519PublicKey("not a key"), null);
  const key = (await importEd25519PublicKey(spki))!;
  assertFalse(await verifyEd25519Signature(key, "short", message));
  assertFalse(await verifyEd25519Signature(key, "%%%", message));
});

Deno.test("mode is observe unless explicitly enforce", () => {
  assertEquals(resolveAuthMode(undefined), "observe");
  assertEquals(resolveAuthMode(""), "observe");
  assertEquals(resolveAuthMode("observe"), "observe");
  assertEquals(resolveAuthMode("yes"), "observe");
  assertEquals(resolveAuthMode("enforce"), "enforce");
  assertEquals(resolveAuthMode(" ENFORCING "), "enforce");
});

Deno.test("proof classes by event type", () => {
  assertEquals(acceptedProofsForType("InboundMessage"), ["app_signature"]);
  assertEquals(acceptedProofsForType("OutboundMessage"), ["app_signature"]);
  assertEquals(acceptedProofsForType("NoteCreate"), ["app_signature"]);
  assertEquals(acceptedProofsForType("AppointmentUpdate"), ["app_signature"]);
  assertEquals(acceptedProofsForType("CallCompleted"), ["workflow_secret"]);
  assertEquals(acceptedProofsForType("Voicemail"), ["workflow_secret"]);
  assertEquals(acceptedProofsForType("ContactStageChanged"), ["workflow_secret"]);
  assertEquals(acceptedProofsForType("ContactCreate"), ["app_signature", "workflow_secret"]);
  assertEquals(acceptedProofsForType(null), ["app_signature", "workflow_secret"]);
});

Deno.test("timing-safe compare and id filter", () => {
  assert(timingSafeEqual("abc", "abc"));
  assertFalse(timingSafeEqual("abc", "abd"));
  assertFalse(timingSafeEqual("abc", "abcd"));
  assertEquals(safeId("pffXnIL1v2FTaKnz4DHm"), "pffXnIL1v2FTaKnz4DHm");
  assertEquals(safeId("ghl:abc-1.2"), "ghl:abc-1.2");
  assertEquals(safeId("has space"), null);
  assertEquals(safeId({}), null);
  assertEquals(safeId("x".repeat(129)), null);
});
