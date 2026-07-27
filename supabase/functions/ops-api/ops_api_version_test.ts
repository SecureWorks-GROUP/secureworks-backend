// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildOpsApiVersion } from "./ops_api_version.ts";

Deno.test("ops-api version uses bundled deploy metadata and ignores stale runtime env", () => {
  const payload = buildOpsApiVersion({
    commit_sha: "abcdef0123456789abcdef0123456789abcdef01",
    deployed_at: "2026-07-27T10:11:12Z",
  }, {
    COMMIT_SHA: "stale-runtime-secret",
    DEPLOYED_AT: "2026-07-26T15:42:09Z",
  });
  assertEquals(
    payload.commit_sha,
    "abcdef0123456789abcdef0123456789abcdef01",
  );
  assertEquals(payload.deployed_at, "2026-07-27T10:11:12Z");
  assertEquals(payload.metadata_status, "bundled");
});

Deno.test("unstamped source reports unavailable instead of stale deploy truth", () => {
  const payload = buildOpsApiVersion({
    commit_sha: null,
    deployed_at: null,
  }, {
    COMMIT_SHA: "stale-runtime-secret",
    DEPLOYED_AT: "2026-07-26T15:42:09Z",
  });
  assertEquals(payload.commit_sha, null);
  assertEquals(payload.deployed_at, null);
  assertEquals(payload.metadata_status, "unavailable");
  assertStringIncludes(payload.canonical_note, "bundled");
});
