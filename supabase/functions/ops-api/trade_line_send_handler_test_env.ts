// Loaded before ./index.ts by trade_line_send_handler_test.ts: index.ts reads
// XERO_CLIENT_ID once at module load, and the shared Xero cooldown refuses a
// call without it. Every Xero request is answered by that test's fetch stub.
if (!Deno.env.get("XERO_CLIENT_ID")) Deno.env.set("XERO_CLIENT_ID", "zztest-client");
if (!Deno.env.get("XERO_CLIENT_SECRET")) Deno.env.set("XERO_CLIENT_SECRET", "zztest-secret");
