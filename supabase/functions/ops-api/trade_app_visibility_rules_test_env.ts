// Loaded before ./index.ts by trade_app_visibility_rules_test.ts: index.ts
// reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY once at module load, and the
// per-job door contract drives the real request handler, which needs a
// client. Every request is answered by that test's fetch stub, never a network.
if (!Deno.env.get("SUPABASE_URL")) {
  Deno.env.set("SUPABASE_URL", "http://127.0.0.1:9");
}
if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
}
