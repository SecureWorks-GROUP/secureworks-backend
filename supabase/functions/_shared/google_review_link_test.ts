// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { opsAiReviewRequestMessage } from "../ops-ai/review_request.ts";
import {
  completionPackReviewPdfLine,
  completionPackReviewVisitHtml,
} from "../completion-pack/review_cta.ts";
import { GOOGLE_REVIEW_URL } from "./google_review_link.ts";

const REAL_REVIEW_URL = "https://share.google/AFyfkE7jLfCZcxanV";

function assertRealReviewLink(text: string) {
  assertStringIncludes(text, REAL_REVIEW_URL);
  assert(!/placeholder/i.test(text), "review text must not contain PLACEHOLDER");
  assert(!text.includes("g.page/r/"), "review text must not use a g.page link");
}

Deno.test("shared review link is Shaun's real Google link", () => {
  assertEquals(GOOGLE_REVIEW_URL, REAL_REVIEW_URL);
});

Deno.test("ops-ai review request message carries the real Google review link", () => {
  const message = opsAiReviewRequestMessage("Jane Citizen");
  assertStringIncludes(message, "Hi Jane,");
  assertRealReviewLink(message);
});

Deno.test("completion pack review CTA prints the real Google review link", () => {
  assertRealReviewLink(completionPackReviewVisitHtml());
  assertRealReviewLink(completionPackReviewPdfLine());
});
