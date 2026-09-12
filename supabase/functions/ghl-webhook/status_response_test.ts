import { assertStatusUpdateResponse } from "./status_response.ts";
Deno.test("HTTP and application status failures are not reported as a successful stage write", () => {
  for (
    const [ok, status, result] of [
      [false, 500, { error: "db down" }],
      [false, 403, { error: "forbidden" }],
      [true, 200, { success: false }],
      [true, 200, null],
    ] as const
  ) {
    let threw = false;
    try {
      assertStatusUpdateResponse({ ok, status }, result);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("false status success");
  }
  assertStatusUpdateResponse({ ok: true, status: 200 }, {
    success: true,
    job: { status: "accepted" },
  });
});
