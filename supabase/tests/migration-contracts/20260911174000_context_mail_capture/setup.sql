-- Earlier registered migrations provide UUID business_events and B1 switches.
-- Supabase Storage bucket fields used here; no live storage requests in SQL tests.
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets(id text PRIMARY KEY,name text NOT NULL,public boolean NOT NULL DEFAULT false);
INSERT INTO storage.buckets(id,name,public) VALUES('b5-existing-public-fixture','b5-existing-public-fixture',true) ON CONFLICT DO NOTHING;
