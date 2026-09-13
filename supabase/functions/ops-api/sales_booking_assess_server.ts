// Local production-shaped assessment HTTP entrypoint. Default hold. No provider writes.
import { runAssessment } from "./sales_booking_engine.ts";

const PORT = Number(Deno.env.get("BOOKING_ASSESSMENT_PORT") || 4175);

Deno.serve({ hostname: "127.0.0.1", port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, entry: "sales_booking_assess", port: PORT, reason_url: Boolean(Deno.env.get("BOOKING_REASON_URL")) });
  }
  if (req.method !== "POST" || (url.pathname !== "/assess" && url.pathname !== "/")) {
    return Response.json({ ok: false, error: "POST /assess" }, { status: 404 });
  }
  const body = await req.json();
  const payload = await runAssessment(body, {
    cached_hash: body.cached_hash,
    cached_payload: body.cached_payload,
  });
  return Response.json(payload);
});

console.log("Booking assessment entrypoint http://127.0.0.1:" + PORT + "/assess");
