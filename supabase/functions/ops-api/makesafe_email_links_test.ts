// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractBuilderEmailLinks,
  mergeDeterministicAndClaudeLinks,
  mergeIntoExternalLinks,
  normalizeReportExternalLinks,
  stripEmailHtmlForTrade,
  urlIsBuilderPortalLink,
} from "./makesafe_email_links.ts";

// ── Intake item 4 (nudge-email pattern) — idempotent add-only link merge ──────

const PRIME_LINK = {
  label: "Roof report link",
  url: "https://primeeco.tech/share/abc",
  kind: "roof_report",
  source: "email_body" as const,
};

Deno.test("nudge merge: adds a new link to an empty job", () => {
  const { links, added } = mergeIntoExternalLinks([], [PRIME_LINK]);
  assertEquals(added.length, 1);
  assertEquals(links.length, 1);
  assertEquals(links[0].url, "https://primeeco.tech/share/abc");
});

Deno.test("nudge merge: re-scanning the same nudge is a no-op (idempotent)", () => {
  const existing = [{
    label: "Roof report link",
    url: "https://primeeco.tech/share/abc",
    kind: "roof_report",
  }];
  const { added, links } = mergeIntoExternalLinks(existing, [PRIME_LINK]);
  assertEquals(added.length, 0);
  assertEquals(links.length, 1);
});

Deno.test("nudge merge: never clobbers an operator's existing link, appends the new one", () => {
  const existing = [{
    label: "Operator's own note link",
    url: "https://ops.example/manual",
    kind: "builder_portal",
  }];
  const { added, links } = mergeIntoExternalLinks(existing, [PRIME_LINK]);
  assertEquals(added.length, 1);
  assertEquals(links.length, 2);
  assertEquals(links[0].url, "https://ops.example/manual"); // existing kept first
  assertEquals(links[1].url, "https://primeeco.tech/share/abc");
});

Deno.test("nudge merge: tolerates a bare-string or null current value", () => {
  assertEquals(mergeIntoExternalLinks(null, [PRIME_LINK]).added.length, 1);
  const fromString = mergeIntoExternalLinks("https://primeeco.tech/share/abc", [
    PRIME_LINK,
  ]);
  assertEquals(fromString.added.length, 0); // same URL already present as a string
});

// ── Intake item 4 — portal/report link capture hardening ─────────────────────

Deno.test("item4: urlIsBuilderPortalLink recognises primeeco + share-path links", () => {
  assert(urlIsBuilderPortalLink("https://primeeco.tech/share/a3c98fd6-b45d"));
  assert(urlIsBuilderPortalLink("https://documents.primeeco.tech/r/abc"));
  assert(urlIsBuilderPortalLink("https://portal.example.com/share/xyz"));
  assertEquals(urlIsBuilderPortalLink("https://www.google.com/maps"), false);
  assertEquals(urlIsBuilderPortalLink("not a url"), false);
});

Deno.test("item4: a primeeco share link is captured even on a footer-ish line", () => {
  // The recon failure shape (SWMS-26632): the only report link sits in the body,
  // near signature/footer text that would drop an ordinary link.
  const body = "Please complete the roof report\n" +
    "https://primeeco.tech/share/a3c98fd6-b45d-4d2e-b444-dca8cada393e\n" +
    "Unsubscribe | Privacy | facebook.com/mlbuilders";
  const links = extractBuilderEmailLinks(body);
  const urls = links.map((l) => l.url);
  assert(
    urls.some((u) => u.includes("primeeco.tech/share/")),
    `expected the primeeco link; got ${JSON.stringify(urls)}`,
  );
  const primeLink = links.find((l) => l.url.includes("primeeco.tech"))!;
  assertEquals(primeLink.kind, "roof_report"); // "roof report" context wins
});

Deno.test("item4: portal links are also mined from attachment/PDF text", () => {
  const links = extractBuilderEmailLinks(
    "Hi team, you've been assigned a work order.", // body: no link
    "Work Order\nSubmit via the sharelink: https://primeeco.tech/share/deadbeef\n5 photos min",
  );
  const prime = links.find((l) => l.url.includes("primeeco.tech"));
  assert(
    prime,
    `expected a link from attachment text; got ${JSON.stringify(links)}`,
  );
  assertEquals(prime!.source, "attachment_text");
});

Deno.test("item4: a plain footer/tracking link is still dropped (no regression)", () => {
  const links = extractBuilderEmailLinks(
    "Regards\nhttps://click.mailer.example.com/track?utm_medium=email_signature",
  );
  assertEquals(links.length, 0);
});

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
