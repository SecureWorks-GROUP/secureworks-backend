// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildFixtureRun, renderFixturePdf } from "./fixtures.ts";

const RUN_ID = "018f7f2c-4db4-7c61-92c7-2b2b97e0a111";

Deno.test("fixture set covers the seven Captain-ordered traffic shapes", async () => {
  const run = await buildFixtureRun({
    runId: RUN_ID,
    expiresAtMs: Date.now() + 60_000,
    secret: "fixture-test-secret",
  });
  assertEquals(run.fixtures.length, 7);
  assertEquals(
    run.fixtures.map((fixture) => fixture.kind),
    [
      "physical_makesafe",
      "portal_roof_report",
      "assessment_quote",
      "temporary_fence",
      "reattendance",
      "correction",
      "accounted_non_work",
    ],
  );
  assertEquals(run.fixtures.filter((fixture) => fixture.attachment).length, 6);
  assertEquals(
    run.fixtures.find((fixture) => fixture.kind === "assessment_quote")
      ?.expected.portalRoles,
    ["assessment", "photos", "scope"],
  );
});

Deno.test("fixtures contain only reserved identities and owned routing addresses", async () => {
  const run = await buildFixtureRun({
    runId: RUN_ID,
    expiresAtMs: Date.now() + 60_000,
    secret: "fixture-test-secret",
  });
  for (const fixture of run.fixtures) {
    assertStringIncludes(fixture.subject, run.marker);
    assertStringIncludes(fixture.ref, "SYNTHLIVE-");
    assertStringIncludes(
      fixture.htmlBody,
      "SYNTHETIC LIVE-FIRE BUILDER - TEST ONLY",
    );
    assertStringIncludes(fixture.htmlBody, "synthetic-livefire.invalid");
    assertStringIncludes(fixture.htmlBody, "ses@secureworkswa.com.au");
    assert(
      !/@(?:mlbuilders|ajs|westernbuild|primeeco)\b/i.test(fixture.htmlBody),
    );
  }
});

Deno.test("every fixture phone is an ACMA fiction-only number", async () => {
  const run = await buildFixtureRun({
    runId: RUN_ID,
    expiresAtMs: Date.now() + 60_000,
    secret: "fixture-test-secret",
  });
  const allowed = new Set([
    "0491 570 006",
    "0491 570 156",
    "0491 570 157",
    "0491 570 158",
  ]);
  const phones: string[] = [];
  for (const fixture of run.fixtures) {
    phones.push(...(fixture.htmlBody.match(/0491 570 \d{3}/g) || []));
  }
  assertEquals(phones.length, 6);
  assert(phones.every((phone) => allowed.has(phone)));
});

Deno.test("fixture PDF is a deterministic parseable text PDF", () => {
  const first = renderFixturePdf([
    "marker",
    "Work Order Number: SYNTHLIVE-001",
  ]);
  const second = renderFixturePdf([
    "marker",
    "Work Order Number: SYNTHLIVE-001",
  ]);
  assertEquals(first, second);
  assertStringIncludes(new TextDecoder().decode(first), "%PDF-1.4");
  assertStringIncludes(new TextDecoder().decode(first), "SYNTHLIVE-001");
});
