-- Allow raw make-safe facts to carry canonical decimal measurements without
-- weakening the integer-only readiness-envelope contract.
--
-- Production service-report checklists legitimately contain measurements such
-- as 1.25, 2.5, and 3.5. Fact identity must hash those values, while
-- makesafe_canonical_json_v1 must continue rejecting non-integer readiness
-- inputs. This migration installs a fact-only serializer and points the
-- existing fact hash at it. It performs no seed, status change, communication,
-- or financial write.

CREATE OR REPLACE FUNCTION public.makesafe_fact_canonical_json_v1(
  p_value jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $$
DECLARE
  value_type text := jsonb_typeof(p_value);
  result text;
  number_text text;
BEGIN
  IF value_type = 'null' THEN
    RETURN 'null';
  ELSIF value_type = 'string' THEN
    RETURN to_jsonb(normalize(p_value #>> '{}', NFC))::text;
  ELSIF value_type = 'boolean' THEN
    RETURN p_value::text;
  ELSIF value_type = 'number' THEN
    -- jsonb numbers are finite PostgreSQL numerics. Remove representation-only
    -- fractional zeroes so equal values such as 2.5 and 2.50 hash identically.
    number_text := regexp_replace(
      p_value::text,
      '(\.[0-9]*?)0+$',
      '\1'
    );
    RETURN regexp_replace(number_text, '\.$', '');
  ELSIF value_type = 'object' THEN
    SELECT '{' || COALESCE(string_agg(
      to_jsonb(normalize(key, NFC))::text || ':' ||
        public.makesafe_fact_canonical_json_v1(value),
      ',' ORDER BY normalize(key, NFC) COLLATE "C"
    ), '') || '}'
    INTO result
    FROM jsonb_each(p_value);
    RETURN result;
  ELSIF value_type = 'array' THEN
    SELECT '[' || COALESCE(string_agg(
      public.makesafe_fact_canonical_json_v1(value),
      ',' ORDER BY
        COALESCE(
          normalize(value->>'id', NFC),
          normalize(value->>'attendance_cycle_id', NFC),
          normalize(value->>'family_code', NFC),
          public.makesafe_fact_canonical_json_v1(value)
        ) COLLATE "C"
    ), '') || ']'
    INTO result
    FROM jsonb_array_elements(p_value);
    RETURN result;
  END IF;

  RAISE EXCEPTION 'unsupported make-safe fact JSON type: %', value_type;
END;
$$;

CREATE OR REPLACE FUNCTION public.makesafe_fact_hash_v1(
  p_kind text,
  p_payload jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public, extensions
AS $$
  SELECT 'sha256:' || encode(
    extensions.digest(
      convert_to(
        'SecureWorks:make-safe-fact:v1:' || p_kind || E'\n' ||
          public.makesafe_fact_canonical_json_v1(p_payload),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

DO $$
DECLARE
  v_decimal_hash text;
  v_scaled_decimal_hash text;
  v_integer_hash text;
BEGIN
  v_decimal_hash := public.makesafe_fact_hash_v1(
    'decimal-golden',
    '{"distance":2.5}'::jsonb
  );
  v_scaled_decimal_hash := public.makesafe_fact_hash_v1(
    'decimal-golden',
    '{"distance":2.50}'::jsonb
  );
  v_integer_hash := public.makesafe_fact_hash_v1(
    'integer-golden',
    '{"count":2}'::jsonb
  );

  IF v_decimal_hash <>
      'sha256:6c330f9e8440d0a13ba3bb465798ffbbefff8061e1dc2db2e38cd3f480e0fac0'
     OR v_scaled_decimal_hash IS DISTINCT FROM v_decimal_hash THEN
    RAISE EXCEPTION 'make-safe decimal fact canonicalization mismatch';
  END IF;
  IF v_integer_hash <>
      'sha256:c49b0fc32037d0f93919bff7aa1aef97225dbb61f78caeee4c5da85498db7a66' THEN
    RAISE EXCEPTION 'make-safe integer fact hash compatibility mismatch';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.makesafe_fact_canonical_json_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.makesafe_fact_canonical_json_v1(jsonb)
  TO service_role;
