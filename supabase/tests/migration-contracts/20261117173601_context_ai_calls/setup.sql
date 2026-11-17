-- No job fixture is needed: call logs deliberately have no job foreign key.
CREATE SCHEMA IF NOT EXISTS zztest_ai_calls;
CREATE TABLE IF NOT EXISTS zztest_ai_calls.rows (payload jsonb NOT NULL);
TRUNCATE zztest_ai_calls.rows;
INSERT INTO zztest_ai_calls.rows(payload) VALUES ('[
 {"at":"2026-11-16T23:00:00Z","ai_job":"read-facts","spec_id":"read-facts","spec_version":0,"engine":"codex","model":"fixture-model","outcome":"answered","duration_ms":100},
 {"at":"2026-11-17T01:00:00Z","ai_job":"read-facts","spec_id":"read-facts","spec_version":0,"engine":"codex","model":"fixture-model","outcome":"failed","duration_ms":300}
]');
