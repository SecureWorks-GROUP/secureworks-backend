// deno-lint-ignore-file no-explicit-any no-import-prefix
// SW_SHARED_KEY_CONTAINMENT: the photo follow-up through the real function.
// A 401 from send-outlook-email is a refusal before any Graph call, so the
// photo pack must be saved as failed / photo_send_refused (retryable), unless
// the reply itself says the outcome is unknown. A failed save of that state,
// or one that matched no row, must be surfaced rather than swallowed.
//
// No network: fetch is stubbed, and the database is an in-memory stand-in.

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _makesafeSendPhotoFollowupForTest as makesafeSendPhotoFollowup } from "./index.ts";
import { makeFakeClaimStore } from "../_shared/outbound_send_claim_fake.ts";

const JOB = "job-photo-1";
const PHOTO_URL = "https://stub-storage.invalid/job-photo-1/photo.jpg";

type State = {
  packStatus: string;
  packUpdates: Record<string, unknown>[];
  finalPatchError: { message: string } | null;
  finalPatchZeroRows?: boolean;
};

class Query {
  private patch: Record<string, unknown> | null = null;
  private selected = false;
  private inserting = false;
  private statusFiltered = false;
  constructor(private table: string, private state: State) {}
  select(_c?: string) { this.selected = true; return this; }
  eq() { return this; }
  in() { this.statusFiltered = true; return this; }
  is() { return this; }
  order() { return this; }
  limit() { return this; }
  update(p: Record<string, unknown>) { this.patch = p; return this; }
  insert(_r: unknown) { this.inserting = true; return this; }
  upsert(_r: unknown) { this.inserting = true; return this; }
  private row(): unknown {
    switch (this.table) {
      case "makesafe_report_packs": return { id: "pack-photo", status: this.state.packStatus, failed_step: null };
      case "makesafe_job_details": return {
        job_id: JOB, cycle_number: 1, attendance_cycle_id: "cycle-1", external_ref: "AJBR-1",
        makesafe_companies: { slug: "aj", name: "AJ", report_recipient: "workorders@ajs.build" },
      };
      case "makesafe_attendance_cycles": return { id: "cycle-1", cycle_number: 1 };
      case "jobs": return { id: JOB, job_number: "SWMS-1", type: "makesafe", metadata: { address: "1 Test St" }, client_name: "Test" };
      default: return null;
    }
  }
  maybeSingle() { return Promise.resolve({ data: this.row(), error: null }); }
  single() { return Promise.resolve({ data: this.row(), error: null }); }
  then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
    let out: unknown = { data: null, error: null };
    if (this.inserting) {
      out = { data: null, error: null };
    } else if (this.table === "makesafe_report_packs" && this.patch) {
      this.state.packUpdates.push(this.patch);
      if (this.selected && this.statusFiltered) {
        // The atomic send lock: drafted / failed -> sending.
        const claimed = ["drafted", "failed"].includes(this.state.packStatus);
        if (claimed) this.state.packStatus = String(this.patch.status);
        out = { data: claimed ? [{ id: "pack-photo", status: this.state.packStatus }] : [], error: null };
      } else if (this.state.finalPatchError) {
        out = { data: null, error: this.state.finalPatchError };
      } else if (this.state.finalPatchZeroRows) {
        // PostgREST answers an update that matched nothing with no error.
        out = { data: [], error: null };
      } else {
        if (typeof this.patch.status === "string") this.state.packStatus = this.patch.status;
        out = { data: this.selected ? [{ id: "pack-photo" }] : null, error: null };
      }
    } else if (this.table === "job_events") {
      out = { data: [{ job_id: JOB, event_type: "note", detail_json: { text: "MAKESAFE_PACK_SENT | main | INV-1 | to=x@y.com | 2026-10-19 | msgid=m" } }], error: null };
    } else if (this.table === "job_media") {
      out = { data: [{ storage_url: PHOTO_URL, thumbnail_url: null }], error: null };
    }
    return Promise.resolve(out).then(resolve, reject);
  }
}

function harness(finalPatchError: { message: string } | null = null, finalPatchZeroRows = false) {
  const state: State = { packStatus: "drafted", packUpdates: [], finalPatchError, finalPatchZeroRows };
  const claims = makeFakeClaimStore();
  const client = { from: (t: string) => new Query(t, state), rpc: claims.rpc };
  return { state, client, claims };
}

async function withOutlookStatus<T>(status: number, fn: (calls: string[]) => Promise<T>, replyBody: Record<string, unknown> = { error: "Unauthorized" }): Promise<T> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === PHOTO_URL) return Promise.resolve(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } }));
    if (url.includes("/functions/v1/send-outlook-email")) {
      return Promise.resolve(new Response(JSON.stringify(replyBody), { status }));
    }
    return Promise.reject(new Error("unhandled stub fetch: " + url));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const quiet = async <T>(fn: () => Promise<T>) => {
  const log = console.log, err = console.error;
  console.log = console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};

Deno.test("photo follow-up: a 401 from send-outlook-email saves failed / photo_send_refused", async () => {
  const { state, client, claims } = harness();
  await withOutlookStatus(401, async (calls) => {
    await quiet(() => assertRejects(() => makesafeSendPhotoFollowup(client, { job_id: JOB, approved_photos: [{ url: PHOTO_URL, name: "photo.jpg" }] })));
    assert(calls.some((u) => u.includes("send-outlook-email")), "the email was attempted");
  });
  const last = state.packUpdates.at(-1)!;
  assertEquals(last.status, "failed");
  assertEquals(last.failed_step, "photo_send_refused");
  assertEquals(state.packStatus, "failed", "the pack is retryable: the lock accepts 'failed'");
  assertEquals(claims.rowsFor(`makesafe_pack:${JOB}:photo`).map((r) => r.state), ["failed"], "a refusal frees the send claim");
});

Deno.test("photo follow-up: a 5xx after the attempt stays 'sending' (outcome unknown)", async () => {
  const { state, client, claims } = harness();
  await withOutlookStatus(502, async () => {
    await quiet(() => assertRejects(() => makesafeSendPhotoFollowup(client, { job_id: JOB, approved_photos: [{ url: PHOTO_URL, name: "photo.jpg" }] })));
  });
  const last = state.packUpdates.at(-1)!;
  assertEquals(last.status, "sending");
  assertEquals(last.failed_step, "photo_send_unknown_outcome");
  assertEquals(claims.rowsFor(`makesafe_pack:${JOB}:photo`).map((r) => r.state), ["outcome_unknown"], "an unknown outcome holds the claim");
});

Deno.test("photo follow-up: a failed save of the refused state is surfaced, not swallowed", async () => {
  const { client } = harness({ message: "db down" });
  await withOutlookStatus(401, async () => {
    const err = await quiet(() => assertRejects(() => makesafeSendPhotoFollowup(client, { job_id: JOB, approved_photos: [{ url: PHOTO_URL, name: "photo.jpg" }] })));
    assert(String((err as Error).message).includes("photo pack state was not saved"), String((err as Error).message));
  });
});

Deno.test("photo follow-up: a save that matched no pack row is surfaced, not read as saved", async () => {
  const { client } = harness(null, true);
  await withOutlookStatus(401, async () => {
    const err = await quiet(() => assertRejects(() => makesafeSendPhotoFollowup(client, { job_id: JOB, approved_photos: [{ url: PHOTO_URL, name: "photo.jpg" }] })));
    assert(String((err as Error).message).includes("no pack row was updated"), String((err as Error).message));
  });
});

Deno.test("photo follow-up: a 401 whose reply says the outcome is unknown stays 'sending'", async () => {
  const { state, client } = harness();
  await withOutlookStatus(401, async () => {
    await quiet(() => assertRejects(() => makesafeSendPhotoFollowup(client, { job_id: JOB, approved_photos: [{ url: PHOTO_URL, name: "photo.jpg" }] })));
  }, { state: "outcome_unknown", retry_safe: false });
  const last = state.packUpdates.at(-1)!;
  assertEquals(last.status, "sending");
  assertEquals(last.failed_step, "photo_send_unknown_outcome");
});
