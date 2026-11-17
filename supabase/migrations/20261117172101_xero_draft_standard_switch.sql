-- P3-01.2: only new draft writers opt into the settled division rules.
-- Existing invoice create/edit callers keep main's legacy mapper regardless
-- of this switch. Missing or unreadable is off. No existing row is changed.
-- The foundation also seeds this flag; this seed is safe in either order.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('xero_draft_standard_v1', false,
        'P3-01.2: opt-in draft standard for new draft writers only; existing invoice mapping is unchanged.')
ON CONFLICT (flag_name) DO NOTHING;
