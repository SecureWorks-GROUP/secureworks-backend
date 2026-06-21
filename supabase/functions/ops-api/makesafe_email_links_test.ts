// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractBuilderEmailLinks,
  mergeDeterministicAndClaudeLinks,
  normalizeReportExternalLinks,
  stripEmailHtmlForTrade,
} from "./makesafe_email_links.ts";

Deno.test("stripEmailHtmlForTrade removes scripts/styles/tags and keeps readable links", () => {
  const text = stripEmailHtmlForTrade(`
    <style>.x{}</style><script>alert(1)</script>
    <p>Please complete the roof report<br>Open https://prime.example/jobs/MLB-1?x=1&amp;y=2</p>
  `);

  assert(!text.includes("<script"));
  assert(!text.includes("alert(1)"));
  assert(text.includes("Please complete the roof report"));
  assert(text.includes("https://prime.example/jobs/MLB-1?x=1&y=2"));
});

Deno.test("extractBuilderEmailLinks captures multiple report email-body URLs and filters footer links", () => {
  const links = extractBuilderEmailLinks(`
    Roof report link: https://prime.example/roof/123.
    Assessment report: <a href="https://prime.example/assess/123">open</a>
    Quote portal https://prime.example/quote/123)
    Unsubscribe https://mail.example/unsubscribe?id=abc
  `);

  assertEquals(links.map((l) => l.url), [
    "https://prime.example/roof/123",
    "https://prime.example/assess/123",
    "https://prime.example/quote/123",
  ]);
  assertEquals(links.map((l) => l.kind), [
    "roof_report",
    "assessment_report",
    "quote",
  ]);
  assertEquals(links.every((l) => l.source === "email_body"), true);
});

Deno.test("mergeDeterministicAndClaudeLinks keeps deterministic URLs when Claude omits them", () => {
  const deterministic = extractBuilderEmailLinks(`
    Roof report https://prime.example/roof/123
    Quote https://prime.example/quote/123
  `);
  const merged = mergeDeterministicAndClaudeLinks(deterministic, {
    portal_links: [{
      label: "Roof report from Prime",
      url: "https://prime.example/roof/123",
      kind: "roof_report",
    }],
  });

  assertEquals(merged.length, 2);
  assertEquals(merged[0].label, "Roof report from Prime");
  assertEquals(merged[1].url, "https://prime.example/quote/123");
});

Deno.test("normalizeReportExternalLinks supports new arrays and legacy portal_link", () => {
  const links = normalizeReportExternalLinks({
    portal_links: [{
      label: "Assessment",
      url: "https://prime.example/assessment/1",
      kind: "assessment_report",
    }],
    portal_link: "https://prime.example/assessment/1",
  });

  assertEquals(links, [{
    label: "Assessment",
    url: "https://prime.example/assessment/1",
    kind: "assessment_report",
    source: "claude",
  }]);
});
