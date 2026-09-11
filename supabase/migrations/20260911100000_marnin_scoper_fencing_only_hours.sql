-- Marnin's scoping calendar for Stratco quote visits (11 Sep 2026, Marnin via Rayleigh).
-- Scoper 706c5258-70dd-483a-b36c-af6864b24498 (marnin@secureworkswa.com.au) books
-- fencing visits only, 08:00 to 16:30 Monday to Friday. Before this change the row
-- allowed 08:00 to 17:00 and had the patio lane enabled at weight 0.6.
-- Data only. sw_create_scope_booking reads these values on every call.
UPDATE public.scoper_preferences
   SET daily_window   = jsonb_build_object('start', '08:00', 'end', '16:30'),
       available_days = ARRAY[1, 2, 3, 4, 5]::int[],
       per_lane       = jsonb_set(
                          jsonb_set(
                            COALESCE(per_lane, '{}'::jsonb),
                            '{patios}',
                            COALESCE(per_lane -> 'patios', '{}'::jsonb)
                              || jsonb_build_object('enabled', false,
                                                    'reason', 'fencing-only (Marnin, 11 Sep 2026)'),
                            true),
                          '{fencing}',
                          COALESCE(per_lane -> 'fencing', '{}'::jsonb)
                            || jsonb_build_object('enabled', true),
                          true),
       updated_at     = now()
 WHERE user_id = '706c5258-70dd-483a-b36c-af6864b24498';
