import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { completionPackClientSignature } from "./client_signature.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

Deno.test("the completion pack shows only a valid unrevoked client signature", () => {
  assertEquals(
    completionPackClientSignature({
      signoff: {
        method: "on_site",
        signature_media_id: "media-1",
        signed_name: "Alex Client",
        created_at: "2026-10-21T01:00:00Z",
      },
      mediaUrl: PNG,
    }),
    {
      signature_data: PNG,
      signature_name: "Alex Client",
      signed_at: "2026-10-21T01:00:00Z",
    },
  );
  assertEquals(
    completionPackClientSignature({
      signoff: {
        method: "share_link",
        signature_media_id: "media-1",
        signed_name: "Alex Client",
      },
      mediaUrl: "https://example.invalid/signature.png",
    })?.signature_data,
    "https://example.invalid/signature.png",
  );
  for (const method of ["revoked", "office_waiver", "crew_phone", ""]) {
    assertEquals(
      completionPackClientSignature({
        signoff: { method, signature_media_id: "media-1", signed_name: "Alex" },
        mediaUrl: PNG,
      }),
      null,
      method,
    );
  }
  assertEquals(
    completionPackClientSignature({
      signoff: { method: "on_site", signed_name: "Alex" },
      mediaUrl: PNG,
    }),
    null,
  );
  assertEquals(
    completionPackClientSignature({ signoff: null, mediaUrl: PNG }),
    null,
  );
});
