// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  projectNameJobNumber,
  resolveProjectJobId,
} from "./project_job_link.ts";

const jobs = new Map<string, string[]>([
  ["SWF-26764", ["job-26764"]],
  ["SWF-26765", ["job-26765"]],
  ["SWP-261178", ["job-261178"]],
  ["SWF-99999", ["job-a", "job-b"]],
]);
const contacts = new Map<string, string>([["contact-deb", "job-26765"]]);

Deno.test("project name job number uses the shared grammar", () => {
  assertEquals(
    projectNameJobNumber("SWF-26764 14 Curlew Ct Ballajura"),
    "SWF-26764",
  );
  assertEquals(
    projectNameJobNumber("swp-261178 1 Drift Lane Aveley"),
    "SWP-261178",
  );
  // legacy Tradify numbers and builder buckets carry no job number
  assertEquals(projectNameJobNumber("SW1334 15 Cloudberry Crescent"), null);
  assertEquals(projectNameJobNumber("Major Loss Builders June 2026"), null);
  assertEquals(projectNameJobNumber(null), null);
});

Deno.test("a name that resolves to one job wins over the contact match", () => {
  // live shape: same client, two jobs; the contact map holds the other one
  assertEquals(
    resolveProjectJobId({
      name: "SWF-26764 14 Curlew Ct",
      contactId: "contact-deb",
      jobIdsByNumber: jobs,
      contactToJob: contacts,
    }),
    { jobId: "job-26764", method: "project_name_job_number" },
  );
});

Deno.test("no name match keeps the contact path", () => {
  assertEquals(
    resolveProjectJobId({
      name: "Deb Hendricks fencing",
      contactId: "contact-deb",
      jobIdsByNumber: jobs,
      contactToJob: contacts,
    }),
    { jobId: "job-26765", method: "contact_match" },
  );
  // a job number that matches no job falls back too
  assertEquals(
    resolveProjectJobId({
      name: "SWF-11111 somewhere",
      contactId: "contact-deb",
      jobIdsByNumber: jobs,
      contactToJob: contacts,
    }),
    { jobId: "job-26765", method: "contact_match" },
  );
});

Deno.test("an ambiguous job number never links by name", () => {
  assertEquals(
    resolveProjectJobId({
      name: "SWF-99999 x",
      contactId: null,
      jobIdsByNumber: jobs,
      contactToJob: contacts,
    }),
    { jobId: null, method: null },
  );
});

Deno.test("nothing to go on leaves the project unlinked", () => {
  assertEquals(
    resolveProjectJobId({
      name: "Major Loss Builders June 2026",
      contactId: "unknown",
      jobIdsByNumber: jobs,
      contactToJob: contacts,
    }),
    { jobId: null, method: null },
  );
});
