BEGIN;
DO $$
DECLARE j public.jobs; old_deposit timestamptz;
BEGIN
 SELECT * INTO j FROM public.jobs WHERE id='ea000000-0000-4000-8000-000000000001';
 IF j.accepted_at IS DISTINCT FROM '2026-08-01T00:00:00Z'::timestamptz OR j.accepted_at_evidence->>'quality' IS DISTINCT FROM 'OBSERVED_EVENT' THEN RAISE EXCEPTION 'witnessed acceptance not retained'; END IF;
 SELECT * INTO j FROM public.jobs WHERE id='ea000000-0000-4000-8000-000000000002';
 IF j.accepted_at IS DISTINCT FROM '2026-09-09T00:00:00Z'::timestamptz OR j.accepted_at_evidence->>'quality' IS DISTINCT FROM 'BACKFILLED' OR j.status<>'scheduled' THEN RAISE EXCEPTION 'estimate is not explicitly backfilled'; END IF;
 SELECT * INTO j FROM public.jobs WHERE id='ea000000-0000-4000-8000-000000000003';
 IF j.accepted_at IS DISTINCT FROM '2026-01-01T00:00:00Z'::timestamptz OR j.accepted_at_evidence IS NOT NULL THEN RAISE EXCEPTION 'existing acceptance rewritten'; END IF;
 SELECT * INTO j FROM public.jobs WHERE id='ea000000-0000-4000-8000-000000000004';
 IF j.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'conflict was mistaken for acceptance'; END IF;
 old_deposit:=j.deposit_at;
 UPDATE public.jobs SET status='accepted' WHERE id=j.id RETURNING * INTO j;
 IF j.accepted_at IS NULL OR j.accepted_at_evidence->>'quality' IS DISTINCT FROM 'OBSERVED_WRITE' THEN RAISE EXCEPTION 'new accepted transition has no stamp'; END IF;
 IF j.deposit_at IS DISTINCT FROM old_deposit THEN RAISE EXCEPTION 'deposit changed'; END IF;
 UPDATE public.jobs SET accepted_at='2099-01-01T00:00:00Z',status='accepted' WHERE id=j.id;
 IF (SELECT accepted_at FROM public.jobs WHERE id=j.id) IS DISTINCT FROM j.accepted_at THEN RAISE EXCEPTION 'repeat status overwrote first acceptance'; END IF;
END $$;
ROLLBACK;
