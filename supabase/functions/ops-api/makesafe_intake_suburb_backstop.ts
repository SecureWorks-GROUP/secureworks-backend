// deno-lint-ignore-file no-explicit-any

/**
 * Backstop for the one intake fact whose absence is silent: the site suburb.
 *
 * The Ops board renders `jobs.site_suburb` alone, so a card minted with an
 * empty suburb is present in the system and effectively unfindable by the
 * normal suburb-keyed route. Nothing on the commit path required the field, so
 * a parsing defect upstream produced an invisible card and no signal.
 *
 * This is a FLAG, never a block. Intake still commits the case and mints the
 * job - a genuinely suburb-less work order must remain visible and actionable,
 * and refusing intake would trade a quiet card for a lost one. The guard's only
 * job is to make sure a human is told, through the same source-issue mechanism
 * every other open intake fact already uses
 * (`makesafe_intake_source_issues.ts` -> `email_events_raw` ->
 * `buildIntakeExceptionProjection` / `buildSourceIssueOperationalFact`).
 *
 * It lives at the ONE seam every mint path converges on, `approveIntakeDraft`,
 * so the deterministic runtime, the clean-draft backlog sweep and the manual
 * review button are all covered by this single guard.
 *
 * Scope is deliberately suburb-only. Do not widen it to other fields here.
 */

import {
  type IntakeSourceIssueReason,
  persistIntakeSourceIssue,
} from "./makesafe_intake_source_issues.ts";

export const INTAKE_MISSING_SUBURB_REASON: IntakeSourceIssueReason =
  "committed_without_site_suburb";

/**
 * True when a commit that produced a live job carries no usable site suburb.
 *
 * `jobCreated` is the commit itself: a run that merely re-links an already-live
 * job did not commit that card and must not re-flag it. Whitespace is not a
 * suburb, matching `createMakesafeJob`'s own `suburb || null` write, which
 * stores a blank string as-is and renders as the board's "Suburb TBC".
 */
export function intakeCommittedWithoutSiteSuburb(args: {
  jobCreated: boolean;
  jobId: string | null | undefined;
  siteSuburb: string | null | undefined;
}): boolean {
  if (!args.jobCreated) return false;
  if (!args.jobId) return false;
  return String(args.siteSuburb ?? "").trim().length === 0;
}

export interface IntakeSuburbBackstopArgs {
  jobCreated: boolean;
  jobId: string | null | undefined;
  siteSuburb: string | null | undefined;
  orgId: string;
  mailbox: string;
  sourcePostIds: readonly string[];
  instructionKey?: string | null;
  caseId?: string | null;
  syntheticLivefireMarker?: string | null;
}

/**
 * Writes the open source issue for a suburb-less commit.
 *
 * The flag is purely informational, so a failed write must never convert a
 * successful mint into a failed commit: every persist is caught per source and
 * accounted, and the caller continues. `flagged` is true only once a write has
 * actually landed, so a counter driven by it can never over-count a throw.
 */
export async function flagIntakeCommitWithoutSiteSuburb(
  client: any,
  args: IntakeSuburbBackstopArgs,
): Promise<{ flagged: boolean; writeFailures: number }> {
  if (!intakeCommittedWithoutSiteSuburb(args)) {
    return { flagged: false, writeFailures: 0 };
  }
  let flagged = false;
  let writeFailures = 0;
  for (const postId of args.sourcePostIds) {
    if (!postId) continue;
    try {
      await persistIntakeSourceIssue(client, {
        orgId: args.orgId,
        mailbox: args.mailbox,
        postId,
        reason: INTAKE_MISSING_SUBURB_REASON,
        instructionKey: args.instructionKey ?? null,
        caseId: args.caseId ?? null,
        syntheticLivefireMarker: args.syntheticLivefireMarker ?? null,
      });
      flagged = true;
    } catch (error) {
      writeFailures++;
      console.error(
        `[ops-api] intake suburb backstop: flag write failed for job ${args.jobId}: ${
          (error as Error)?.message || error
        }`,
      );
    }
  }
  return { flagged, writeFailures };
}
