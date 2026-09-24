import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  filterPairedLegacyCallRows,
  withoutPairedLegacyCallRows,
} from "./ghl_call_pair.ts";

Deno.test("paired GHL call rows keep the logged call and omit only its legacy copy", () => {
  const rows = [
    { id: "legacy-1", event_type: "client.call_complete", payload: {} },
    {
      id: "logged-1",
      event_type: "client.call_logged",
      payload: { legacy_event_id: "legacy-1" },
    },
    { id: "legacy-2", event_type: "client.call_complete", payload: {} },
    { id: "logged-2", event_type: "client.call_logged", payload: {} },
    { id: "other", event_type: "client.sms_in", payload: {} },
  ];

  assertEquals(
    withoutPairedLegacyCallRows(rows).map((row) => row.id),
    ["logged-1", "legacy-2", "logged-2", "other"],
  );
});

Deno.test("paired legacy lookup hides a copy even when its call row is on another job", async () => {
  const rows = [
    { id: "legacy-on-job-a", event_type: "client.call_complete", payload: {} },
    { id: "unpaired-on-job-a", event_type: "client.call_complete", payload: {} },
  ];
  const client = {
    from(table: string) {
      assertEquals(table, "business_events");
      return {
        select() {
          return this;
        },
        eq(column: string, value: string) {
          assertEquals(column, "event_type");
          assertEquals(value, "client.call_logged");
          return this;
        },
        async in(column: string, ids: string[]) {
          assertEquals(column, "payload->>legacy_event_id");
          assertEquals(ids, ["legacy-on-job-a", "unpaired-on-job-a"]);
          return {
            data: [{ payload: { legacy_event_id: "legacy-on-job-a" } }],
            error: null,
          };
        },
      };
    },
  };

  assertEquals(
    (await filterPairedLegacyCallRows(client, rows)).map((row) => row.id),
    ["unpaired-on-job-a"],
  );
});
