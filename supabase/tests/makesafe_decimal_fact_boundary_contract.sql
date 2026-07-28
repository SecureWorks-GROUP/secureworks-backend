BEGIN;

DO $$
DECLARE
  v_facts jsonb := '{"service_reports":[{"labour_hours":2.5}]}'::jsonb;
  v_token text;
  v_readiness jsonb := '{"labour_hours":2.5}'::jsonb;
BEGIN
  v_token := public.makesafe_reconciliation_state_token_v1(v_facts);
  IF v_token <> 'sha256:8fbb5fd020b39a35d30fbc89935bb1dc6f6f83a3f64904ba2c969848a69a65fe' THEN
    RAISE EXCEPTION 'decimal reconciliation token regression';
  END IF;
  IF public.makesafe_fact_canonical_json_v1(v_facts) <> '{"service_reports":[{"labour_hours":2.5}]}' THEN
    RAISE EXCEPTION 'decimal fact canonicalization regression';
  END IF;
  BEGIN
    PERFORM public.makesafe_canonical_json_v1(v_readiness);
    RAISE EXCEPTION 'decimal readiness value was accepted';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'decimal readiness value was accepted' THEN
        RAISE;
      END IF;
      IF SQLERRM <> 'readiness numbers must be finite base-10 integers' THEN
        RAISE;
      END IF;
  END;
END;
$$;

ROLLBACK;
