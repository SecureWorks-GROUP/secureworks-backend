// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalizeKind,
  extractAnchorTextMap,
  extractBuilderEmailLinks,
  mergeDeterministicAndClaudeLinks,
  mergeIntoExternalLinks,
  normalizeReportExternalLinks,
  stripEmailHtmlForTrade,
  urlIsBuilderPortalLink,
  urlLooksLikeAssetOrTracking,
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
  // Expired share links are still portals — liveness is never a filter input.
  assert(
    urlIsBuilderPortalLink(
      "https://primeeco.tech/share/expired-token-still-a-portal",
    ),
  );
  assertEquals(urlIsBuilderPortalLink("https://www.google.com/maps"), false);
  assertEquals(urlIsBuilderPortalLink("not a url"), false);
});

// F5 — branding images / trackers must never pass the portal predicate or the
// merge boundary (ses-links-truth-audit-v1: 59 image rows + 3 SES trackers).
const F5_LOGO =
  "https://documents.primeeco.tech/15276239-d244-11ee-8228-0a39957d26b4/mlb_new_logo.png";
const F5_COMPANY_JPG =
  "https://s3.ap-southeast-2.amazonaws.com/cdn.primeeco.tech/company/504/brand.jpg";
const F5_SIG_PNG =
  "https://documents.primeeco.tech/15276239-d244-11ee-8228-0a39957d26b4/mlb_sig_image_1.png";
const F5_TRACKER =
  "https://xw2vdtj6.r.ap-southeast-2.awstrack.me/I0/0108019eabcdef/1/1";
const F5_SHARE =
  "https://primeeco.tech/share/7d74ea48-89bc-4e6e-b7b4-8a1e433b7d7c";

Deno.test("F5: urlIsBuilderPortalLink rejects image/CDN asset paths on primeeco hosts", () => {
  // Host alone used to return true — documents.primeeco.tech/.../logo.png.
  assertEquals(urlIsBuilderPortalLink(F5_LOGO), false);
  assertEquals(urlIsBuilderPortalLink(F5_COMPANY_JPG), false);
  assertEquals(urlIsBuilderPortalLink(F5_SIG_PNG), false);
  assert(urlLooksLikeAssetOrTracking(F5_LOGO));
  assert(urlLooksLikeAssetOrTracking(F5_COMPANY_JPG));
});

Deno.test("F5: urlIsBuilderPortalLink rejects SES open/click trackers", () => {
  assertEquals(urlIsBuilderPortalLink(F5_TRACKER), false);
  assert(urlLooksLikeAssetOrTracking(F5_TRACKER));
});

Deno.test("F5: genuine share link still accepted (including aged/expired tokens)", () => {
  assert(urlIsBuilderPortalLink(F5_SHARE));
  assertEquals(urlLooksLikeAssetOrTracking(F5_SHARE), false);
  // A primeeco host WITHOUT a share path is not a portal.
  assertEquals(
    urlIsBuilderPortalLink("https://documents.primeeco.tech/some/uuid/path"),
    false,
  );
  assertEquals(urlIsBuilderPortalLink("https://primeeco.tech/"), false);
});

Deno.test("F5: mergeDeterministicAndClaudeLinks drops Claude image + tracker URLs", () => {
  const merged = mergeDeterministicAndClaudeLinks([], {
    portal_links: [
      { label: "Builder Portal", url: F5_LOGO, kind: "builder_portal" },
      { label: "Builder Portal", url: F5_TRACKER, kind: "builder_portal" },
      { label: "Company", url: F5_COMPANY_JPG, kind: "builder_portal" },
      { label: "Roof report link", url: F5_SHARE, kind: "roof_report" },
    ],
  });
  assertEquals(merged.map((l) => l.url), [F5_SHARE]);
  assertEquals(merged[0].kind, "roof_report");
});

Deno.test("F5: normalizeReportExternalLinks rejects image/tracker portal claims", () => {
  const links = normalizeReportExternalLinks({
    portal_links: [
      { label: "Logo", url: F5_LOGO, kind: "builder_portal" },
      { label: "Track", url: F5_TRACKER, kind: "builder_portal" },
    ],
    portal_link: F5_SIG_PNG,
  });
  assertEquals(links.length, 0);
});

Deno.test("F5: extractBuilderEmailLinks never captures img/CDN/tracker URLs", () => {
  const body = `
    Please complete the roof report
    ${F5_SHARE}
    <img src="${F5_LOGO}">
    ${F5_COMPANY_JPG}
    ${F5_TRACKER}
  `;
  const links = extractBuilderEmailLinks(body);
  assertEquals(links.map((l) => l.url), [F5_SHARE]);
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
    Roof report https://primeeco.tech/share/roof-123
    Quote https://primeeco.tech/share/quote-123
  `);
  const merged = mergeDeterministicAndClaudeLinks(deterministic, {
    portal_links: [{
      label: "Roof report from Prime",
      url: "https://primeeco.tech/share/roof-123",
      kind: "roof_report",
    }],
  });

  assertEquals(merged.length, 2);
  assertEquals(merged[0].label, "Roof report from Prime");
  assertEquals(merged[1].url, "https://primeeco.tech/share/quote-123");
});

Deno.test("normalizeReportExternalLinks supports new arrays and legacy portal_link", () => {
  const links = normalizeReportExternalLinks({
    portal_links: [{
      label: "Assessment",
      url: "https://primeeco.tech/share/assessment-1",
      kind: "assessment_report",
    }],
    portal_link: "https://primeeco.tech/share/assessment-1",
  });

  assertEquals(links, [{
    label: "Assessment",
    url: "https://primeeco.tech/share/assessment-1",
    kind: "assessment_report",
    source: "claude",
  }]);
});

// ── W3-F — link-typing capture hardening ─────────────────────────────────────
// Reconstructions keyed to the REAL primeeco share URLs of the four cards that
// degraded to a single generic builder_portal link (SWMS-26846/47/48/49), plus the
// triad, canon and idempotent-upgrade behaviours. The bug: a primeeco …/share/<uuid>
// link carries no descriptive path, so with only the wide-window keyword scan the type
// (assessment_report / photos / quote) was lost and every link fell to generic.

const U_2684 = {
  report46: "https://primeeco.tech/share/3aa4a68c-3b5b-495c-9918-808926a47713",
  report47: "https://primeeco.tech/share/6ce66bfb-02ed-41c3-b782-2a1e243be56d",
  report48:
    "https://www.primeeco.tech/share/728fb9be-8582-451d-9b0b-09164312bf57",
  report49: "https://primeeco.tech/share/8b6f70ac-fafe-4d51-8ff3-c1f75c04f6c6",
};

Deno.test("W3-F SWMS-26846: anchor-text labels type the whole prime triad (was 1 generic link)", () => {
  // Prime's report email presents each artifact as a labelled <a>; the anchor text names
  // the artifact even though every href is an indistinguishable /share/<uuid> link.
  const html = `<html><body>
    <p>Hi team, the assessment for MLB-25898 (19 Stuart Ct, Bateman) is complete.</p>
    <p><a href="${U_2684.report46}">View Assessment Report</a></p>
    <p><a href="https://primeeco.tech/share/aa11bb22-photos-4d24-c2b6-92050e12abcd">View Photos</a></p>
    <p><a href="https://primeeco.tech/share/cc33dd44-quote-4d24-c2b6-92050e34efgh">View Quote</a></p>
  </body></html>`;
  const links = extractBuilderEmailLinks(html);
  const byUrl = new Map(links.map((l) => [l.url, l]));
  assertEquals(byUrl.get(U_2684.report46)!.kind, "assessment_report");
  assertEquals(
    byUrl.get(
      "https://primeeco.tech/share/aa11bb22-photos-4d24-c2b6-92050e12abcd",
    )!.kind,
    "photos",
  );
  assertEquals(
    byUrl.get(
      "https://primeeco.tech/share/cc33dd44-quote-4d24-c2b6-92050e34efgh",
    )!.kind,
    "quote",
  );
  // No link left generic and nothing flagged — the triad is fully typed.
  assert(links.every((l) => l.kind !== "builder_portal"));
  assert(links.every((l) => l.evidence_gap === undefined));
});

Deno.test("W3-F SWMS-26847: a heading line above a bare share link types it", () => {
  const body = "Report ready for MLB-26060, 37 Willshire Way.\n" +
    "Assessment Report\n" +
    `${U_2684.report47}\n` +
    "Regards, Prime Eco";
  const links = extractBuilderEmailLinks(body);
  const prime = links.find((l) => l.url === U_2684.report47)!;
  assertEquals(prime.kind, "assessment_report");
  assertEquals(prime.evidence_gap, undefined);
});

Deno.test("W3-F SWMS-26848: www.primeeco host is a portal link and its own line types it", () => {
  assert(urlIsBuilderPortalLink(U_2684.report48));
  const body = `Photos: ${U_2684.report48}`;
  const links = extractBuilderEmailLinks(body);
  const prime = links.find((l) => l.url === U_2684.report48)!;
  assertEquals(prime.kind, "photos");
});

Deno.test("W3-F SWMS-26849: a lone unlabelled share link stays generic BUT is flagged, never guessed", () => {
  // The honest degraded shape: one share link, no anchor/heading/path/sibling signal.
  const body = "Please see the builder portal for the submitted report.\n" +
    `${U_2684.report49}`;
  const links = extractBuilderEmailLinks(body);
  assertEquals(links.length, 1);
  assertEquals(links[0].url, U_2684.report49);
  assertEquals(links[0].kind, "builder_portal"); // not guessed
  assert(
    typeof links[0].evidence_gap === "string" &&
      links[0].evidence_gap.length > 0,
    `expected an evidence-gap flag; got ${JSON.stringify(links[0])}`,
  );
});

Deno.test("W3-F triad completion: a bare middle link between typed report+quote is inferred as photos", () => {
  const body = "Assessment Report: https://primeeco.tech/share/rep-0000\n" +
    "https://primeeco.tech/share/mid-0000\n" +
    "Quote: https://primeeco.tech/share/quo-0000";
  const links = extractBuilderEmailLinks(body);
  const mid = links.find((l) =>
    l.url === "https://primeeco.tech/share/mid-0000"
  )!;
  assertEquals(mid.kind, "photos"); // determined by elimination, not position-guessed
  assertEquals(mid.evidence_gap, undefined); // resolved
  assertEquals(
    links.find((l) => l.url === "https://primeeco.tech/share/rep-0000")!.kind,
    "assessment_report",
  );
  assertEquals(
    links.find((l) => l.url === "https://primeeco.tech/share/quo-0000")!.kind,
    "quote",
  );
});

Deno.test("W3-F triad guard: three bare share links (none typed) are NOT positionally guessed", () => {
  const body = "Reports are ready:\n" +
    "https://primeeco.tech/share/a-0000\n" +
    "https://primeeco.tech/share/b-0000\n" +
    "https://primeeco.tech/share/c-0000";
  const links = extractBuilderEmailLinks(body);
  assertEquals(links.length, 3);
  // All stay generic and flagged — a wrong type is worse than a flagged generic.
  assert(links.every((l) => l.kind === "builder_portal"));
  assert(links.every((l) => typeof l.evidence_gap === "string"));
});

Deno.test("W3-F prev-line guard: a stacked sibling link never bleeds its type onto the link below", () => {
  // "Quote:" sits on the line above a DIFFERENT bare link; that bare link must not become
  // a quote just because the sibling link-line mentions one.
  const body = "Quote: https://primeeco.tech/share/quote-xyz\n" +
    "https://primeeco.tech/share/bare-xyz";
  const links = extractBuilderEmailLinks(body);
  const bare = links.find((l) =>
    l.url === "https://primeeco.tech/share/bare-xyz"
  )!;
  assertEquals(bare.kind, "builder_portal");
  assert(typeof bare.evidence_gap === "string");
});

Deno.test("W3-F canon: kinds are normalised to the extractor's vocabulary at write time", () => {
  assertEquals(canonicalizeKind("photo_schedule"), "photos");
  assertEquals(canonicalizeKind("Photo Schedule"), "photos");
  assertEquals(canonicalizeKind("photos"), "photos");
  assertEquals(canonicalizeKind("quotation"), "quote");
  assertEquals(canonicalizeKind("scope"), "quote");
  assertEquals(canonicalizeKind("Scope of Works"), "quote");
  assertEquals(canonicalizeKind("roof-report"), "roof_report");
  assertEquals(
    canonicalizeKind("assessment_report_quote"),
    "assessment_report",
  );
  assertEquals(canonicalizeKind(""), "builder_portal");
  assertEquals(canonicalizeKind("unknown_report"), "builder_portal");
  // A Claude link carrying the legacy photo_schedule alias is stored as `photos`.
  const merged = mergeDeterministicAndClaudeLinks([], {
    portal_links: [{
      label: "Photo schedule",
      url: "https://primeeco.tech/share/ph-1",
      kind: "photo_schedule",
    }],
  });
  assertEquals(merged[0].kind, "photos");
});

Deno.test("assessment triad: Prime's Scope label is stored as the quote member", () => {
  const links = extractBuilderEmailLinks(`
    <a href="https://primeeco.tech/share/assessment-1">Assessment Report</a>
    <a href="https://primeeco.tech/share/photos-1">Photo Schedule</a>
    <a href="https://primeeco.tech/share/scope-1">Scope of Works</a>
  `);
  assertEquals(links.map((link) => link.kind), [
    "assessment_report",
    "photos",
    "quote",
  ]);
  assertEquals(links[2].label, "Scope / quote link");
});

Deno.test("W3-F upgrade-on-rescan: a stored generic link is retyped in place (idempotent, no duplicate)", () => {
  // The live defect state: the job already carries the degraded generic capture.
  const stored = [{
    label: "Builder portal link",
    url: U_2684.report46,
    kind: "builder_portal",
    source: "email_body",
    evidence_gap: "portal link captured but type undetermined",
  }];
  // A re-scan by the hardened extractor now knows it is the assessment report.
  const rescan = [{
    label: "Assessment report link",
    url: U_2684.report46,
    kind: "assessment_report",
    source: "email_body" as const,
  }];
  const { links, added, upgraded } = mergeIntoExternalLinks(stored, rescan);
  assertEquals(links.length, 1); // no duplicate
  assertEquals(added.length, 0);
  assertEquals(upgraded.length, 1);
  assertEquals(links[0].kind, "assessment_report");
  assertEquals(links[0].evidence_gap, undefined); // flag cleared on upgrade
  // Re-running the same re-scan is now a no-op (typed entry not re-upgraded).
  const again = mergeIntoExternalLinks(links, rescan);
  assertEquals(again.added.length, 0);
  assertEquals(again.upgraded.length, 0);
});

Deno.test("W3-F upgrade-on-rescan: an operator's custom label survives the kind upgrade", () => {
  const stored = [{
    label: "Prime portal (see Hugo's note)",
    url: U_2684.report49,
    kind: "builder_portal",
  }];
  const rescan = [{
    label: "Quote link",
    url: U_2684.report49,
    kind: "quote",
    source: "email_body" as const,
  }];
  const { links, upgraded } = mergeIntoExternalLinks(stored, rescan);
  assertEquals(upgraded.length, 1);
  assertEquals(links[0].kind, "quote"); // kind sharpened
  assertEquals(links[0].label, "Prime portal (see Hugo's note)"); // operator prose kept
});

Deno.test("W3-F regression: an already-working labelled triad still types cleanly", () => {
  // SWMS-26716-class: report/photos/quote each on their own labelled line.
  const links = extractBuilderEmailLinks(
    "Assessment report https://primeeco.tech/share/r16\n" +
      "Photos https://primeeco.tech/share/p16\n" +
      "Quote https://primeeco.tech/share/q16",
  );
  assertEquals(links.map((l) => l.kind), [
    "assessment_report",
    "photos",
    "quote",
  ]);
  assert(links.every((l) => l.evidence_gap === undefined));
});

Deno.test("W3-F extractAnchorTextMap: maps hrefs to anchor text, stripping nested tags", () => {
  const map = extractAnchorTextMap(
    `<a href="https://primeeco.tech/share/x1"><span>View </span><b>Assessment Report</b></a>`,
  );
  assertEquals(
    map.get("https://primeeco.tech/share/x1"),
    "View Assessment Report",
  );
});
