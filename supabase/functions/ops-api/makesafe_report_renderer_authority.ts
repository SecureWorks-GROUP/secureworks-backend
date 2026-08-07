// The append-only register of authorised make-safe report renderers.
//
// A curated bind stamps the renderer identity that was authoritative WHEN THE
// BIND WAS MADE (`index.ts` writes `report_renderer_*` straight from the
// `makesafe_report_render.ts` constants). Both readers of that stamp used to
// compare it against the constants as they stand NOW, which asks a different
// and wrong question: "was this produced by the renderer authorised today".
// Re-pinning the wiki renderer therefore un-trusted every bind made under the
// previous pin, all at once, without a single bind record changing. That is the
// validator becoming wrong about the past, not the binds becoming false.
//
// The honest question is bind-time: identity I is authoritative for a bind made
// at T when T falls inside I's validity window. This module is that window
// record. It is APPEND-ONLY. A re-pin adds an entry and closes the previous
// one; it never edits or deletes a past entry, because a past entry is a
// statement about what production was actually running, and that never changes.
//
// Window instants are the DEPLOY instant, not the merge instant. The deployed
// function is what stamps a bind, so between a pin merging and that build going
// live production still stamps the OLD identity, and those binds are legitimate.
// Each entry records exactly where its instant was measured.
//
// A re-pin is therefore a THREE-part change, all in one commit:
//   1. move both constants in `makesafe_report_render.ts` (they move together),
//   2. close the outgoing entry here at the measured deploy instant,
//   3. append the new entry with `authorised_until: null`.
// `assertMakesafeRendererRegisterMatchesPin()` fails loudly if step 2/3 is
// skipped, so the register cannot silently fall behind the pin again.

import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
} from "./makesafe_report_render.ts";

export interface MakesafeRendererAuthorityEntry {
  /** Wiki commit the renderer script was taken from. */
  readonly source_revision: string;
  /** SHA-256 of that commit's own `render_makesafe_report.py` bytes. */
  readonly script_sha256: string;
  /** First instant this identity was live in production, inclusive. */
  readonly authorised_from: string;
  /** Instant its successor went live, exclusive. `null` means current. */
  readonly authorised_until: string | null;
  /** Where the window instants were measured. Never a guess. */
  readonly provenance: string;
}

/**
 * Ordered oldest first. Windows are contiguous: each entry's `authorised_until`
 * is its successor's `authorised_from`, so exactly one identity is authoritative
 * at any instant and no bind can fall in a gap.
 *
 * Instants are the completion of the "Deploy changed edge functions" step of the
 * `Deploy Edge Functions` run for the commit that moved the pin — the first
 * moment the new build is definitely serving. Ending the window at the step's
 * completion rather than its start is deliberately the safe rounding: a bind
 * carrying the OLD identity cannot exist after the new build is live (the server
 * stamps its own constants), so a boundary a few seconds late admits nothing,
 * while a boundary a few seconds early would refuse a true bind.
 */
export const MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER:
  readonly MakesafeRendererAuthorityEntry[] = [
    {
      source_revision: "8348325bee364b2ddeddd7d853eb28d3178cde5e",
      script_sha256:
        "b4fb6350fce8a89eef726e3d87628a32cd5dc5fa612936974e133e56b13dbf6f",
      authorised_from: "2026-08-03T14:18:07Z",
      authorised_until: "2026-08-03T16:13:04Z",
      provenance:
        "repo 16cc2dc9 (#529) deployed by run 30821985145; superseded by 9e733e12 (#536) deployed by run 30830398249. Zero live binds carry this identity (measured 2026-08-07): it is recorded because the register is the history, not only the part of it that is load-bearing today.",
    },
    {
      source_revision: "915e9b423fc597d656c7cb090671bf206138114b",
      script_sha256:
        "fda63bcffa0177b702089e67b5719ae50642a9972aa3628c516fcedb1cfe42dc",
      authorised_from: "2026-08-03T16:13:04Z",
      authorised_until: "2026-08-07T08:36:29Z",
      provenance:
        "repo 9e733e12 (#536) deployed by run 30830398249; superseded by 0caad8fe (#649) deployed by run 31162359402. 34 live curated binds carry this identity, every one of them made inside this window (earliest 2026-08-04T04:38:11Z, latest 2026-08-07T08:00:25Z).",
    },
    {
      source_revision: "2cb60bf05f0aecf24d8b6c0a54181de3a8aa3dfb",
      script_sha256:
        "c3e48d4fac7f040c68296bb3b6d6676535fc464d67fedfd10b07b7d7232b54a7",
      authorised_from: "2026-08-07T08:36:29Z",
      authorised_until: null,
      provenance:
        "repo 0caad8fe (#649) deployed by run 31162359402, wiki PR #325 squash on secureworks-wiki main. Current pin.",
    },
  ];

/** The renderer version string derived from an entry's source revision. */
export function makesafeRendererAuthorityVersion(
  entry: MakesafeRendererAuthorityEntry,
): string {
  return `secureworks.wiki-python/${entry.source_revision}`;
}

/** The renderer identity a bind stamped, as read off a provenance record. */
export interface MakesafeRendererStamp {
  version: unknown;
  source_revision: unknown;
  script_sha256: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function instant(value: unknown): number {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * The register entry a stamp names, or `null`. All three fields must agree with
 * one entry: the version string is derived from the source revision, so a stamp
 * whose version and revision disagree describes no renderer that ever ran and is
 * refused rather than resolved in favour of either half.
 */
export function makesafeRendererAuthorityEntryForStamp(
  stamp: MakesafeRendererStamp,
): MakesafeRendererAuthorityEntry | null {
  const revision = text(stamp.source_revision);
  const sha = text(stamp.script_sha256);
  const version = text(stamp.version);
  return MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER.find((entry) =>
    entry.source_revision === revision &&
    entry.script_sha256 === sha &&
    makesafeRendererAuthorityVersion(entry) === version
  ) || null;
}

/** The entry with an open window, i.e. the identity a bind made now must carry. */
export function makesafeCurrentRendererAuthorityEntry(): MakesafeRendererAuthorityEntry {
  const current = MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER.find((entry) =>
    entry.authorised_until === null
  );
  if (!current) {
    throw new Error(
      "makesafe renderer authority register has no open entry; a re-pin closed a window without appending its successor",
    );
  }
  return current;
}

/**
 * Was this stamp authoritative for a bind made at `boundAt`?
 *
 * The current entry is accepted with no timestamp at all, which is EXACTLY the
 * behaviour these two call sites had before bind-time validity existed — a new
 * bind must still match the current pin and nothing about that path is relaxed.
 *
 * A superseded entry needs the bind's own instant, and that instant must fall
 * inside the entry's closed window. So an old identity carrying a current
 * timestamp is refused (the fence this whole change must not open), and so is an
 * old identity with no instant at all: an unproved bind time is not a licence,
 * it is the pre-existing refusal.
 */
export function makesafeRendererStampAuthorisedAtBind(
  stamp: MakesafeRendererStamp,
  boundAt: unknown,
): boolean {
  const entry = makesafeRendererAuthorityEntryForStamp(stamp);
  if (!entry) return false;
  if (entry.authorised_until === null) return true;
  const bound = instant(boundAt);
  if (!Number.isFinite(bound)) return false;
  return bound >= instant(entry.authorised_from) &&
    bound < instant(entry.authorised_until);
}

/**
 * Fails when the register has fallen behind the pin. Called by the register's
 * own test suite, which is what makes the next re-pin append here instead of
 * silently un-trusting every bind made under the outgoing pin.
 */
export function assertMakesafeRendererRegisterMatchesPin(
  register: readonly MakesafeRendererAuthorityEntry[] =
    MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER,
  pin: { source_revision: string; script_sha256: string } = {
    source_revision: MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
    script_sha256: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  },
): void {
  if (register.length === 0) throw new Error("register is empty");
  for (const [index, entry] of register.entries()) {
    if (!/^[0-9a-f]{40}$/.test(entry.source_revision)) {
      throw new Error(`entry ${index} source_revision is not a git sha`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.script_sha256)) {
      throw new Error(`entry ${index} script_sha256 is not a sha-256`);
    }
    if (!Number.isFinite(instant(entry.authorised_from))) {
      throw new Error(`entry ${index} authorised_from is not an instant`);
    }
    const open = entry.authorised_until === null;
    if (open !== (index === register.length - 1)) {
      throw new Error(
        `entry ${index} window is ${
          open ? "open" : "closed"
        }; only the last entry may be open`,
      );
    }
    if (!open) {
      if (
        !(instant(entry.authorised_until) > instant(entry.authorised_from))
      ) {
        throw new Error(`entry ${index} window does not move forward`);
      }
      if (register[index + 1].authorised_from !== entry.authorised_until) {
        throw new Error(
          `entry ${index} does not hand over to its successor; windows must be contiguous`,
        );
      }
    }
  }
  const uniqueRevisions = new Set(
    register.map((entry) => entry.source_revision),
  );
  const uniqueShas = new Set(register.map((entry) => entry.script_sha256));
  if (
    uniqueRevisions.size !== register.length ||
    uniqueShas.size !== register.length
  ) {
    throw new Error("register repeats a renderer identity");
  }
  const current = register[register.length - 1];
  if (
    current.source_revision !== pin.source_revision ||
    current.script_sha256 !== pin.script_sha256
  ) {
    throw new Error(
      "the open register entry is not the current pin: a re-pin moved makesafe_report_render.ts without closing the outgoing window and appending the new identity here",
    );
  }
}
