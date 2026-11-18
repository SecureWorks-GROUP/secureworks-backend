// Dispatch v2 item 19 (Shaun, 18 Nov 2026): the Read now button.
//
// Today Outlook is read every five minutes (cron outlook-mail-poll, minutes
// 2, 7, 12 ...) and supplier replies are matched to Dispatch orders a minute
// later (cron dispatch-v2-replies-scan). Read now does both straight away, in
// that order, for the office person who pressed it, then the screen reloads
// the board, the Needs you now bar, the tray and the open job.
//
//   1. Mail: the same reader the cron calls (outlook-mail-capture, mode
//      poll), waited on for at most READ_NOW_MAIL_CAP_MS. Slow or failed
//      mail never stops step 2: mail the cron already read may be waiting.
//   2. Replies: the same scan the cron calls (dispatch_v2_replies_scan),
//      with peek on, so mail read a moment ago in step 1 is matched now
//      instead of in two minutes (contract section 3j).
//
// Both are switched off together by the capture automation lane, the same
// switch that pauses the crons. Read now reads mail only: it never sends,
// never moves a job stage or status, and writes only what the two crons
// already write. A press while a run is going, or within READ_NOW_REUSE_MS
// of the last one, gets that run's answer back (reused: true) instead of a
// second run. That guard is per worker; two workers running at once is safe,
// because the reader leases each mailbox and the scan stores each email once
// (dispatch_v2_supplier_emails is unique on business_event_id).
//
// Contract: docs/dispatch-v2-board-contract.md, section 3j.

export const DISPATCH_V2_READ_NOW_ACTION = "dispatch_v2_read_now";
/** How long Read now waits for Outlook before saying it is slow. */
export const READ_NOW_MAIL_CAP_MS = 25_000;
/** A press this soon after the last run gets that run's answer back. */
export const READ_NOW_REUSE_MS = 30_000;

export type ReadNowMail =
  | {
    status: "read";
    /** New emails saved across every mailbox read. */
    emails_read: number;
    mailboxes: number;
    /** Mailboxes the reader could not finish (an error, or busy elsewhere). */
    mailboxes_not_read: number;
  }
  /** The reader is switched off (its flags), so nothing was read. */
  | { status: "off"; reason: string }
  /** No answer within READ_NOW_MAIL_CAP_MS. The reader may still finish. */
  | { status: "slow" }
  | { status: "failed"; code: string };

export type ReadNowReplies =
  | {
    status: "scanned";
    /** Supplier emails stored this run, and how each was placed. */
    stored: number;
    matched: number;
    needs_confirmation: number;
    unmatched: number;
    /** Delivery date suggestions made this run. */
    suggestions: number;
  }
  /** Feature flag dispatch_v2_replies_v1 is off. */
  | { status: "off" }
  | { status: "failed"; code: string };

export type ReadNowAnswer = {
  ok: true;
  /** When this run finished (ISO). */
  read_at: string;
  /** "paused": the capture lane is off, so neither step ran. */
  lane: "on" | "paused";
  mail: ReadNowMail | null;
  replies: ReadNowReplies | null;
  /** The Emails to sort count after the run (needs_confirmation +
   * unmatched_order_desk, the tray's own count); null when it could not be read. */
  left_to_sort: number | null;
  /** True when this answer is a run already going or just finished. */
  reused: boolean;
};

export type ReadNowDeps = {
  now(): number;
  captureLaneOn(): Promise<boolean>;
  /** Step 1. Must give up after capMs and answer { status: "slow" }. */
  pollMail(capMs: number): Promise<ReadNowMail>;
  /** Step 2: the cron's scan with peek on. Returns the scan's answer. */
  scanReplies(): Promise<Record<string, unknown>>;
  leftToSort(): Promise<number | null>;
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function codeOf(e: unknown): string {
  const m = (e as { code?: unknown; message?: unknown } | null);
  const c = typeof m?.code === "string" && m.code
    ? m.code
    : typeof m?.message === "string" && m.message
    ? m.message
    : "error";
  // Codes only on the screen, never long text or email words.
  return c.replace(/[^A-Za-z0-9_:. -]/g, "").slice(0, 80) || "error";
}

/** The scan's answer, cut down to the counts the screen shows. */
export function repliesFromScan(scan: Record<string, unknown>): ReadNowReplies {
  if (scan?.skipped === "flag_off") return { status: "off" };
  return {
    status: "scanned",
    stored: n(scan?.stored),
    matched: n(scan?.matched),
    needs_confirmation: n(scan?.needs_confirmation),
    unmatched: n(scan?.unmatched),
    suggestions: n(scan?.suggestions),
  };
}

/** The reader's answer ({mode: "poll", wait: true}), cut down to counts. */
export function mailFromCapture(
  status: number,
  body: any,
): ReadNowMail {
  if (status === 401 || status === 403) {
    return { status: "failed", code: "reader_refused_key" };
  }
  if (!body || typeof body !== "object") {
    return { status: "failed", code: `reader_http_${status}` };
  }
  if (body.outcome === "idle") {
    return { status: "off", reason: String(body.reason || "idle") };
  }
  if (body.outcome === "ran") {
    const sources: any[] = Array.isArray(body.sources) ? body.sources : [];
    let emails = 0;
    let notRead = Array.isArray(body.not_reached) ? body.not_reached.length : 0;
    for (const s of sources) {
      emails += n(s?.counts?.inserted);
      if (s?.outcome !== "ran" || s?.error_code) notRead++;
    }
    return {
      status: "read",
      emails_read: emails,
      mailboxes: sources.length,
      mailboxes_not_read: notRead,
    };
  }
  return {
    status: "failed",
    code: String(body.code || body.error || `reader_http_${status}`),
  };
}

export type ReadNowRunner = (deps: ReadNowDeps) => Promise<ReadNowAnswer>;

/** One runner per worker (index.ts keeps one); tests make their own. */
export function makeReadNowRunner(): ReadNowRunner {
  let running: Promise<ReadNowAnswer> | null = null;
  let last: { at: number; answer: ReadNowAnswer } | null = null;

  async function once(deps: ReadNowDeps): Promise<ReadNowAnswer> {
    if (!(await deps.captureLaneOn())) {
      return {
        ok: true,
        read_at: new Date(deps.now()).toISOString(),
        lane: "paused",
        mail: null,
        replies: null,
        left_to_sort: await deps.leftToSort().catch(() => null),
        reused: false,
      };
    }
    let mail: ReadNowMail;
    try {
      mail = await deps.pollMail(READ_NOW_MAIL_CAP_MS);
    } catch (e) {
      mail = { status: "failed", code: codeOf(e) };
    }
    let replies: ReadNowReplies;
    try {
      replies = repliesFromScan(await deps.scanReplies());
    } catch (e) {
      replies = { status: "failed", code: codeOf(e) };
    }
    return {
      ok: true,
      read_at: new Date(deps.now()).toISOString(),
      lane: "on",
      mail,
      replies,
      left_to_sort: await deps.leftToSort().catch(() => null),
      reused: false,
    };
  }

  return async (deps) => {
    if (running) return { ...(await running), reused: true };
    if (last && deps.now() - last.at < READ_NOW_REUSE_MS) {
      return { ...last.answer, reused: true };
    }
    running = once(deps);
    try {
      const answer = await running;
      last = { at: deps.now(), answer };
      return answer;
    } finally {
      running = null;
    }
  };
}

/** Step 1, live: post the reader exactly as cron outlook-mail-poll does
 * (trigger_context_email_poll), but wait for its answer, up to capMs. */
export function outlookPollMail(options: {
  supabaseUrl: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
}): (capMs: number) => Promise<ReadNowMail> {
  const doFetch = options.fetchImpl ?? fetch;
  return async (capMs) => {
    if (!options.supabaseUrl || !options.serviceKey) {
      return { status: "failed", code: "reader_not_set_up" };
    }
    let res: Response;
    try {
      res = await doFetch(
        `${options.supabaseUrl}/functions/v1/outlook-mail-capture`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${options.serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mode: "poll",
            wait: true,
            actor: "dispatch-v2-read-now",
          }),
          signal: AbortSignal.timeout(capMs),
        },
      );
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { status: "slow" };
      }
      return { status: "failed", code: "reader_unreachable" };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { status: "slow" };
      }
      body = null;
    }
    return mailFromCapture(res.status, body);
  };
}
