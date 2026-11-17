-- Model choices and aggregate harness scores have no job dependency.
CREATE SCHEMA IF NOT EXISTS zztest_ai_models;
CREATE TABLE IF NOT EXISTS zztest_ai_models.rows (payload jsonb NOT NULL);
TRUNCATE zztest_ai_models.rows;
INSERT INTO zztest_ai_models.rows(payload) VALUES ('[
 {"run_id":"zztest-406","ai_job":"read-notes","spec_id":"read-notes","spec_version":1,"engine":"codex","model":"gpt-6-luna","effort":"xhigh","sheet_id":"zztest-sheet","cases":20,"passed":19,"score":0.9500,"critical_misses":0,"median_ms":100,"p95_ms":200,"calls":20,"calls_per_case":1.00,"passes_bar":true},
 {"run_id":"zztest-406","ai_job":"read-bill","spec_id":"read-bill","spec_version":1,"engine":"claude","model":"claude-opus-5-5","effort":"high","sheet_id":"zztest-sheet","cases":20,"passed":18,"score":0.9000,"critical_misses":1,"median_ms":200,"p95_ms":300,"calls":40,"calls_per_case":2.00,"checker_model":"gpt-6-luna","ran_at":"2026-11-17T00:00:00Z","passes_bar":false}
]');
