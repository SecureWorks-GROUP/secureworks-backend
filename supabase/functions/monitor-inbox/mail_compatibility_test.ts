// deno-lint-ignore-file no-explicit-any require-await no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fileId, fileRow, runMailCompatibility } from "./mail_compatibility.ts";
import { projectContextMailFiles } from "../ops-api/context_mail_file_projection.ts";
const file = {
  pointer: `context-mail-evidence://sha256/${"a".repeat(64)}`,
  hash: "a".repeat(64),
  name: "sample.pdf",
  content_type: "application/pdf",
  bytes: 3,
};
const classification = {
  classification: "invoice",
  priority: "high",
  action_needed: "Review invoice",
  job_ref: "SWP-12345",
};
function fixture() {
  const state: any = {
    enabled: true,
    failMedia: false,
    classified: 0,
    event: {
      id: "event",
      job_id: "job",
      match_status: "matched",
      attribution_status: "direct",
    },
    inbox: {
      id: "inbox",
      processed_at: "2026-01-01T00:00:00Z",
      subject: "Invoice",
      metadata: {
        capture_version: "mail_v2",
        business_event_id: "event",
        attachments: [file, {
          ...file,
          name: "photo.png",
          content_type: "image/png",
        }],
        legacy_classifier_eligible: true,
        compatibility: { status: "pending" },
      },
    },
    files: new Map(),
  };
  const sb = {
    rpc: async () => ({ data: state.enabled, error: null }),
    from: (table: string) => {
      let patch: any, upsert: any;
      const filters: any[] = [];
      const q: any = {
        select: () => q,
        or: () => q,
        order: () => q,
        limit: () => q,
        single: () => q,
        maybeSingle: () => q,
        eq: (k: string, v: any) => {
          filters.push([k, v]);
          return q;
        },
        update: (p: any) => {
          patch = structuredClone(p);
          return q;
        },
        upsert: (p: any) => {
          upsert = p;
          return q;
        },
        then: (resolve: any, reject: any) =>
          Promise.resolve().then(() => {
            if (table === "business_events") {
              return { data: structuredClone(state.event), error: null };
            }
            if (table === "inbox_events") {
              if (filters.some(([k]) => k === "graph_message_id")) {
                return { data: state.legacy || null, error: null };
              }
              if (!patch) {
                return {
                  data: state.inbox.metadata.compatibility.status === "complete"
                    ? []
                    : [structuredClone(state.inbox)],
                  error: null,
                };
              }
              if (
                filters.some(([k, v]) => state.inbox[k] !== v)
              ) {
                return { data: [], error: null };
              }
              Object.assign(state.inbox, patch);
              return { data: [{ id: "inbox" }], error: null };
            }
            if (table === "job_media" && state.failMedia) {
              return { error: "failed" };
            }
            if (!state.files.has(upsert.id)) {
              state.files.set(upsert.id, structuredClone(upsert));
            }
            return { error: null };
          }).then(resolve, reject),
      };
      return q;
    },
  };
  const classify = async () => {
    state.classified++;
    return classification;
  };
  return { state, sb, classify };
}
Deno.test("postcapture failure retries files without duplicate records or repeat classification", async () => {
  const { state, sb, classify } = fixture();
  state.failMedia = true;
  assertEquals((await runMailCompatibility(sb, classify)).failed, 1);
  assertEquals(state.files.size, 1);
  assertEquals(state.event.id, "event");
  state.failMedia = false;
  assertEquals((await runMailCompatibility(sb, classify)).complete, 1);
  assertEquals(state.files.size, 2);
  assertEquals(state.classified, 1);
  assertEquals(state.inbox.action_needed, "Review invoice");
  await runMailCompatibility(sb, classify);
  assertEquals(state.files.size, 2);
});
Deno.test("unresolved evidence stays unfiled until B2 binds it; classifier reference cannot bind", async () => {
  const { state, sb, classify } = fixture();
  state.event = {
    id: "event",
    job_id: null,
    match_status: "unresolved",
    attribution_status: "admin_bucket",
  };
  assertEquals(
    (await runMailCompatibility(sb, classify)).awaiting_attribution,
    1,
  );
  assertEquals(state.files.size, 0);
  state.event = {
    id: "event",
    job_id: "job",
    match_status: "matched",
    attribution_status: "luna",
  };
  assertEquals((await runMailCompatibility(sb, classify)).complete, 1);
  assertEquals(state.classified, 1);
  assertEquals(state.files.size, 2);
});
Deno.test("disabled switch and ineligible mail never call paid classifier", async () => {
  const { state, sb, classify } = fixture();
  state.enabled = false;
  assertEquals((await runMailCompatibility(sb, classify)).paused, true);
  state.enabled = true;
  state.inbox.metadata.legacy_classifier_eligible = false;
  await runMailCompatibility(sb, classify);
  assertEquals(state.classified, 0);
});
Deno.test("concurrent drains claim once", async () => {
  const { state, sb, classify } = fixture();
  await Promise.all([
    runMailCompatibility(sb, classify),
    runMailCompatibility(sb, classify),
  ]);
  assertEquals(state.classified, 1);
  assertEquals(state.files.size, 2);
});
Deno.test("filing preserves predecessor PDF semantics and rejects weak binding", async () => {
  const event = {
    job_id: "job",
    match_status: "matched",
    attribution_status: "direct",
  };
  assertEquals(
    (fileRow(event, file, "invoice", "")?.row as any).visible_to_trades,
    false,
  );
  assertEquals(
    fileRow(event, file, "supplier_response", "")?.row.type,
    "supplier_work_order",
  );
  assertEquals(
    fileRow(event, file, "other", "Dispatch")?.row.type,
    "supplier_work_order",
  );
  assertEquals(
    fileRow(event, file, "supplier_quote", "")?.row.type,
    "supplier_quote",
  );
  assertEquals(
    fileRow(
      { ...event, attribution_status: "weak_contact" },
      file,
      "invoice",
      "",
    ),
    null,
  );
  assertEquals(await fileId("event", file), await fileId("event", file));
});
Deno.test("authorized read signs private files for five minutes, preserves public links and source rows", async () => {
  const calls: any[] = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, ttl: number) => {
          calls.push({ bucket, path, ttl });
          return { data: { signedUrl: "https://signed.example.test/file" } };
        },
      }),
    },
  };
  const rows = [{
    job_id: "job",
    storage_url: file.pointer,
    pdf_url: file.pointer,
  }, { job_id: "job", storage_url: "https://existing.example.test/file" }];
  const output = await projectContextMailFiles(client, rows, "job");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].ttl, 300);
  assertEquals(rows[0].storage_url, file.pointer);
  assertEquals(output[0].pdf_url, "https://signed.example.test/file");
  assertEquals(output[1].storage_url, rows[1].storage_url);
  await assertRejects(
    () => projectContextMailFiles(client, rows, "other"),
    Error,
    "scope_invalid",
  );
  const unavailable = await projectContextMailFiles(
    {
      storage: {
        from: () => ({
          createSignedUrl: async () => ({ error: "unavailable" }),
        }),
      },
    },
    rows,
    "job",
  );
  assertEquals(unavailable[0].storage_url, null);
  assertEquals(unavailable[0].pdf_url, null);
  assertEquals(unavailable[0].file_unavailable, true);
});

Deno.test("predecessor overlap reuses existing classification without model spend", async () => {
  const { state, sb, classify } = fixture();
  state.inbox.metadata.legacy_graph_message_id = "original-graph-id";
  state.legacy = {
    ...classification,
    metadata: { job_ref: classification.job_ref },
  };
  assertEquals((await runMailCompatibility(sb, classify)).complete, 1);
  assertEquals(state.classified, 0);
  assertEquals(state.inbox.classification, "invoice");
});
