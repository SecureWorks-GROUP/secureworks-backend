-- Standalone single-case runs and the registered stack use the same flag shape.
CREATE TABLE IF NOT EXISTS public.feature_flags (
 flag_name text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text
);
