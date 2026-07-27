// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const SQL = await Deno.readTextFile(
  new URL(
    "../../migrations/20260728020000_makesafe_ses_invoice_release_u5_u6.sql",
    import.meta.url,
  ),
);

Deno.test("U5 migration enforces one create effect per obligation revision", () => {
  assertStringIncludes(
    SQL,
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_invoice_create",
  );
  assertStringIncludes(
    SQL,
    "ON public.ses_external_effects (invoice_obligation_revision_id)",
  );
  assertStringIncludes(SQL, "WHERE effect_kind = 'invoice_create'");
  assertStringIncludes(
    SQL,
    "claim_mode', CASE",
  );
  assertStringIncludes(
    SQL,
    "ELSE 'reconcile'",
  );
});

Deno.test("U6R migration enforces one send per release route", () => {
  assertStringIncludes(
    SQL,
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_external_route_send",
  );
  assertStringIncludes(
    SQL,
    "ON public.ses_external_effects (release_revision_id, route_kind)",
  );
  assertStringIncludes(SQL, "WHERE effect_kind = 'route_send'");
});

Deno.test("release route commit binds one attachment array to one column", () => {
  assertStringIncludes(
    SQL,
    "body, body_hash, attachment_hashes, envelope_hash, required",
  );
  assertEquals(
    (
      SQL.match(
        /ARRAY\(SELECT jsonb_array_elements_text\(COALESCE\(route->'attachment_hashes'/g,
      ) || []
    ).length,
    1,
  );
});

Deno.test("cycle ownership and mutable revision are database constrained", () => {
  assertStringIncludes(
    SQL,
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_invoice_cycle_active",
  );
  assertStringIncludes(
    SQL,
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_invoice_revision_active",
  );
  assertStringIncludes(
    SQL,
    "released or Xero-bound work cannot be superseded",
  );
});

Deno.test("approval RPC rechecks current readiness and identified operator", () => {
  assertStringIncludes(SQL, "record_ses_revision_approval_v1");
  assertStringIncludes(SQL, "operator is not on the SES release allowlist");
  assertStringIncludes(
    SQL,
    "new evidence landed; review the current docket revision again",
  );
  assert(
    !SQL.includes("INSERT INTO public.ses_release_operators ("),
    "migration must not hardcode Shaun or Captain user ids",
  );
});

Deno.test("execute reservations lock and recheck current approval bindings", () => {
  assertStringIncludes(SQL, "begin_ses_invoice_execution_v1");
  assertStringIncludes(SQL, "begin_ses_release_execution_v1");
  assertStringIncludes(
    SQL,
    "'ses-invoice-execute:' || p_invoice_obligation_revision_id::text",
  );
  assertStringIncludes(
    SQL,
    "'ses-release-execute:' || p_release_revision_id::text",
  );
  assertStringIncludes(
    SQL,
    "new evidence landed; review the current release revision again",
  );
  assertStringIncludes(
    SQL,
    "human SEND IT approval does not cover the exact release member set",
  );
  assertStringIncludes(SQL, "UNIQUE (release_revision_id, job_id)");
});

Deno.test("blocked proposal refusals retain concrete facts on the revision", () => {
  assertStringIncludes(
    SQL,
    "blockers jsonb NOT NULL DEFAULT '[]'::jsonb",
  );
  assertStringIncludes(
    SQL,
    "COALESCE(p_revision->'blockers', '[]'::jsonb)",
  );
  assert(
    !SQL.includes(
      "The current invoice proposal still has a concrete money or duplicate blocker.",
    ),
    "generic refusal text must not replace the concrete proposal blockers",
  );
});

Deno.test("document-only closeout is explicit and never implies a Xero invoice", () => {
  assertStringIncludes(
    SQL,
    "obligation_revision.pricing_disposition =",
  );
  assertStringIncludes(SQL, "'no_additional_charge'");
  assertStringIncludes(
    SQL,
    "release member lacks either an AUTHORISED invoice or an explicit no-additional-charge obligation",
  );
});

Deno.test("release closeout writes terminal proof and compatibility marker", () => {
  assertStringIncludes(SQL, "INSERT INTO public.makesafe_terminal_proofs");
  assertStringIncludes(SQL, "'MAKESAFE_PACK_SENT | main | SES release '");
  assertStringIncludes(SQL, "required_proof_hashes");
});

Deno.test("all new public tables are RLS service-role only", () => {
  assertStringIncludes(SQL, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(SQL, "FOR ALL TO service_role");
  assertStringIncludes(
    SQL,
    "REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated",
  );
});
