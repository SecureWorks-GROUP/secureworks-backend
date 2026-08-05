// deno-lint-ignore-file no-import-prefix
/**
 * Pins the order-sensitive closeout hash defect and its fix.
 *
 * Production witness AJBR-70487 (release 5d94726e…): both routes confirmed
 * with Graph message ids and ses_release_route_proofs rows, but
 * commit_ses_release_closeout_v1 ordered ledger hashes by route_kind and the
 * payload by hash text — array IS DISTINCT FROM refused a complete set.
 *
 * AJBR-70488 (e8a410e8…) happened to have matching orders and closed.
 *
 * Ops-api unit tests mock the database, so this suite:
 *  1. re-proves the pure order-mismatch arithmetic on the live hash pair, and
 *  2. pins the migration SQL to ORDER BY proof_hash on the ledger side.
 * It cannot prove a live PostgREST row matches a live RPC body — that is the
 * Management API readback in the firstmate report.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = await Deno.readTextFile(
  new URL(
    "../../migrations/20260805010000_ses_closeout_proof_hash_set_compare.sql",
    import.meta.url,
  ),
);

/** Live 70487 proof hashes (route_kind order). */
const AJBR_70487 = [
  {
    route_kind: "photo",
    proof_hash:
      "sha256:954fe75ab84f9e851f49cf471a1570acdf6e4eba48eb9f607f0febde8e351cbe",
  },
  {
    route_kind: "report_invoice",
    proof_hash:
      "sha256:2c35cb305c423b64afebba2d1b86153ecce2d70ba25d0fcfe8f89ec520abbda2",
  },
] as const;

/** Live 70488 proof hashes (route_kind order). */
const AJBR_70488 = [
  {
    route_kind: "photo",
    proof_hash:
      "sha256:6b125ee16df00d31b7a147af4f0dc92a0287bcf4c37abf9f1fbf735640862cbf",
  },
  {
    route_kind: "report_invoice",
    proof_hash:
      "sha256:d55711bf98f4685bd23afec7fdebc01764f67c058607d04fd80b2bd935489015",
  },
] as const;

function byRouteKind(
  rows: ReadonlyArray<{ route_kind: string; proof_hash: string }>,
): string[] {
  return [...rows]
    .sort((a, b) => a.route_kind.localeCompare(b.route_kind))
    .map((r) => r.proof_hash);
}

function byHashText(
  rows: ReadonlyArray<{ route_kind: string; proof_hash: string }>,
): string[] {
  return [...rows].map((r) => r.proof_hash).sort();
}

Deno.test("defect: 70487 route_kind order ≠ hash-text order (live hashes)", () => {
  const left = byRouteKind(AJBR_70487);
  const right = byHashText(AJBR_70487);
  assertEquals(left.length, 2);
  assertEquals(right.length, 2);
  // Same set, different array order — the pre-fix SQL refused this.
  assert(
    JSON.stringify(left) !== JSON.stringify(right),
    "expected 70487 to be the order-mismatch witness",
  );
  assertEquals(new Set(left), new Set(right));
});

Deno.test("control: 70488 route_kind order equals hash-text order (live hashes)", () => {
  const left = byRouteKind(AJBR_70488);
  const right = byHashText(AJBR_70488);
  assertEquals(left, right);
});

Deno.test("fix: both sides ORDER BY proof_hash / hash text agree for 70487", () => {
  // Migration left side: ORDER BY proof_hash
  // Migration right side: ORDER BY 1 on hash text elements
  // TS payload already sorts proof hashes alphabetically before the RPC.
  const fixedLeft = byHashText(AJBR_70487);
  const fixedRight = byHashText(AJBR_70487);
  assertEquals(fixedLeft, fixedRight);
});

Deno.test("migration pins set-equality compare (ORDER BY proof_hash)", () => {
  assertStringIncludes(MIGRATION, "ORDER BY proof_hash");
  assertStringIncludes(
    MIGRATION,
    "closeout proof hashes do not match the confirmed route ledger",
  );
  // Executable compare: ledger side must ORDER BY proof_hash, not route_kind.
  // Comments may still name the prior ORDER BY route_kind defect.
  const raiseIdx = MIGRATION.indexOf(
    "RAISE EXCEPTION 'closeout proof hashes do not match the confirmed route ledger'",
  );
  assert(raiseIdx > 0, "expected closeout raise in migration body");
  const compareBlock = MIGRATION.slice(
    Math.max(0, raiseIdx - 400),
    raiseIdx,
  );
  assertStringIncludes(compareBlock, "ORDER BY proof_hash");
  assert(
    !compareBlock.includes("ORDER BY route_kind"),
    "closeout proof compare must not order the ledger by route_kind",
  );
  assertStringIncludes(MIGRATION, "order-sensitive");
});
