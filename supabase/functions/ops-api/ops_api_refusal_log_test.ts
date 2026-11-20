// One log line per refused ops-api request: action, status and code only.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { opsApiRefusalLogLine } from "./ops_api_refusal_log.ts";

Deno.test("a refusal logs its action, status and code", () => {
  assertEquals(
    opsApiRefusalLogLine("generate_trade_invoice", 403, {
      code: "extra_job_not_allowed",
      userMessage: "You are not booked on job SWF-1",
      jobs: ["SWF-1"],
    }),
    "[ops-api] refused action=generate_trade_invoice status=403 code=extra_job_not_allowed",
  );
});

Deno.test("no body text, money, name or free text is ever printed", () => {
  const line = opsApiRefusalLogLine("search all jobs; drop", 409, {
    code: "Ada Quartermain owes $1,200",
    error: "secret words",
    net_pay: 940,
  });
  assertEquals(line, "[ops-api] refused action=- status=409 code=-");
  for (const word of ["Ada", "1,200", "secret", "940"]) {
    assert(!line.includes(word), word);
  }
});

Deno.test("a missing action, body or code prints a dash", () => {
  assertEquals(
    opsApiRefusalLogLine(null, 401, undefined),
    "[ops-api] refused action=- status=401 code=-",
  );
  assertEquals(
    opsApiRefusalLogLine("my_jobs", 500, "plain string body"),
    "[ops-api] refused action=my_jobs status=500 code=-",
  );
  assertEquals(
    opsApiRefusalLogLine("my_jobs", 404, { code: 7 }),
    "[ops-api] refused action=my_jobs status=404 code=-",
  );
});

Deno.test("the serve handler logs every ApiError answer through the helper", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const at = index.indexOf("if (err instanceof ApiError) {\n      console.warn(");
  assert(at > 0, "ApiError branch logs");
  assert(
    index.slice(at, at + 200).includes(
      "opsApiRefusalLogLine(auditAction, err.status, err.body)",
    ),
  );
});
