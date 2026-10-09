// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _googleReviewUrlForTest,
  _reviewRequestMessageForTest,
} from "./index.ts";

const REAL_REVIEW_URL = "https://share.google/AFyfkE7jLfCZcxanV";

Deno.test("review request SMS carries the real Google review link and no placeholder", () => {
  assertEquals(_googleReviewUrlForTest, REAL_REVIEW_URL);
  const message = _reviewRequestMessageForTest("Jane Citizen");
  assertStringIncludes(message, REAL_REVIEW_URL);
  assertStringIncludes(message, "Hi Jane,");
  assert(!/placeholder/i.test(message), "review SMS must not contain PLACEHOLDER");
  assert(!message.includes("g.page/r/"), "review SMS must not use the old g.page link");
});

Deno.test("review request SMS still greets a job with no client name", () => {
  const message = _reviewRequestMessageForTest(null);
  assertStringIncludes(message, "Hi there,");
  assertStringIncludes(message, REAL_REVIEW_URL);
});
