-- Dispatch v2 (slice 5): the approved supplier order email list.
--
-- Contract: docs/dispatch-v2-emails-contract.md. Reader and writer: ops-api's
-- dispatch_v2_* actions (supabase/functions/ops-api/dispatch_v2_store.ts).
--
-- Where Dispatch sends a supplier's order email (To and CC). Shaun approved
-- this list on 23 Oct 2026. It is kept here, in the app, and NOT in
-- suppliers.email: the 06:55 Xero sync overwrites suppliers.email every
-- morning, so nothing in this migration or in Dispatch ever writes to it.
--
-- Two tables:
--   dispatch_approved_supplier_emails       one row per supplier as Shaun named it
--                                           ("Stratco WA"), with its To and CC.
--   dispatch_approved_supplier_email_links  which Xero supplier contacts
--                                           (suppliers rows) are that supplier.
--                                           A contact links to at most one entry.
--
-- The seed links only supplier rows that exist (INSERT ... SELECT ... JOIN
-- suppliers), so a row missing on a copy of the database is skipped, never an
-- error. Seven approved suppliers have no supplier row yet (Metric Fencing,
-- Solarspan, Maxicoat, AB Steel Fabrication, Fielders, QSM Fabrication,
-- Unique Laser): their entries exist but link to nothing until Shaun names
-- the right contact. Mackson and Palram were ruled on 23 Oct 2026 (below).
--
-- Row security on with no policy, revoked from the browser roles: only
-- ops-api reaches these tables. Nothing here is applied by this file's author.
--
-- Rollback: supabase/rollbacks/20261023214100_dispatch_v2_emails_approved_supplier_store_down.sql.

CREATE TABLE IF NOT EXISTS public.dispatch_approved_supplier_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  -- The name Shaun uses for the supplier, e.g. "Stratco WA".
  name text NOT NULL,
  -- fencing, patio, fencing+patio or any. Shown on the search, never a block.
  used_for text NOT NULL,
  -- Lower case addresses. To has at least one.
  to_emails text[] NOT NULL,
  cc_emails text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- false = kept for the record but no longer used to send.
  active boolean NOT NULL DEFAULT true,
  approved_by text NOT NULL,
  approved_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_approved_supplier_emails_org_name_key UNIQUE (org_id, name),
  CONSTRAINT dispatch_approved_supplier_emails_used_for_valid CHECK (used_for IN ('fencing', 'patio', 'fencing+patio', 'any')),
  CONSTRAINT dispatch_approved_supplier_emails_to_count CHECK (cardinality(to_emails) BETWEEN 1 AND 10),
  CONSTRAINT dispatch_approved_supplier_emails_cc_count CHECK (cardinality(cc_emails) <= 10),
  CONSTRAINT dispatch_approved_supplier_emails_name_length CHECK (char_length(name) BETWEEN 1 AND 120)
);

CREATE TABLE IF NOT EXISTS public.dispatch_approved_supplier_email_links (
  -- One Xero supplier contact belongs to at most one approved entry.
  supplier_id uuid PRIMARY KEY REFERENCES public.suppliers(id) ON DELETE CASCADE,
  approved_id uuid NOT NULL REFERENCES public.dispatch_approved_supplier_emails(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_email text NULL
);

CREATE INDEX IF NOT EXISTS dispatch_approved_supplier_email_links_approved_idx
  ON public.dispatch_approved_supplier_email_links (approved_id);

COMMENT ON TABLE public.dispatch_approved_supplier_emails IS
  'Dispatch v2: the supplier order email To/CC Shaun approved (23 Oct 2026). Kept apart from suppliers.email, which the 06:55 Xero sync overwrites. Read by ops-api dispatch_v2_* only.';
COMMENT ON TABLE public.dispatch_approved_supplier_email_links IS
  'Dispatch v2: which suppliers rows (Xero contacts) are each approved supplier. A supplier with no link has no approved order email and Dispatch will not send to it.';

ALTER TABLE public.dispatch_approved_supplier_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_approved_supplier_email_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_approved_supplier_emails FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.dispatch_approved_supplier_email_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_approved_supplier_emails TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_approved_supplier_email_links TO service_role;

-- The seed: approved-supplier-order-emails.json as Shaun approved it.
INSERT INTO public.dispatch_approved_supplier_emails
  (org_id, name, used_for, to_emails, cc_emails, approved_by, approved_on)
SELECT '00000000-0000-0000-0000-000000000001'::uuid, v.name, v.used_for, v.to_emails, v.cc_emails, 'Shaun', DATE '2026-10-23'
FROM (VALUES
  ('R&R Fencing', 'fencing', ARRAY['sales@randrfencing.com.au']::text[], ARRAY[]::text[]),
  ('Fencing Warehouse WA', 'fencing', ARRAY['sales@fencingwarehousewa.au']::text[], ARRAY[]::text[]),
  ('Lysaght', 'fencing', ARRAY['lysaghtsaleswa@lysaght.com']::text[], ARRAY[]::text[]),
  ('Oxworks', 'fencing', ARRAY['wangara@oxworks.com.au']::text[], ARRAY['nicole.tingey@oxworks.com.au']::text[]),
  ('Metric Fencing', 'fencing', ARRAY['info@metricfencing.com.au']::text[], ARRAY[]::text[]),
  ('Teamwork Fencing', 'fencing', ARRAY['admin@teamworkfencing.com.au']::text[], ARRAY[]::text[]),
  ('Mackson', 'fencing', ARRAY['info@mackson.com.au']::text[], ARRAY[]::text[]),
  ('Fencing Supply Centre', 'fencing', ARRAY['info@fencingsupplycentre.com.au']::text[], ARRAY[]::text[]),
  ('Twinside Retaining', 'fencing', ARRAY['enquire@twinside.com.au']::text[], ARRAY[]::text[]),
  ('Fence Makers', 'fencing', ARRAY['info@fencemakers.com']::text[], ARRAY[]::text[]),
  ('Stratco WA', 'fencing+patio', ARRAY['tradewa@stratcowa.com.au']::text[], ARRAY['tony.bacich@stratcowa.com.au']::text[]),
  ('B&D Metals Group', 'fencing+patio', ARRAY['sales@bdmetalsgroup.com.au']::text[], ARRAY[]::text[]),
  ('Metroll Perth', 'fencing+patio', ARRAY['orders@perth.metroll.com.au']::text[], ARRAY['helen.mewburn@perth.metroll.com.au']::text[]),
  ('Bunnings', 'any', ARRAY['tradeorderswa@bunnings.com.au']::text[], ARRAY[]::text[]),
  ('CMI (Combined Metal Industries)', 'patio', ARRAY['kris.idnay@cmiwa.com.au']::text[], ARRAY[]::text[]),
  ('Ampelite', 'patio', ARRAY['waorders@ampelite.com.au']::text[], ARRAY['warwick@ampelite.com.au']::text[]),
  ('Bondor', 'patio', ARRAY['wa@bondor.com.au']::text[], ARRAY[]::text[]),
  ('Solarspan', 'patio', ARRAY['wasales@solarspan.com.au']::text[], ARRAY[]::text[]),
  ('JB Patios & Fabrications', 'patio', ARRAY['tim@jbpatios.com.au']::text[], ARRAY['nathan@jbpatios.com.au']::text[]),
  ('Panelmakers (Showbury)', 'patio', ARRAY['sales@panelmakers.com.au']::text[], ARRAY[]::text[]),
  ('Maxicoat (powder coating)', 'patio', ARRAY['maxicoat@bigpond.com']::text[], ARRAY['admin@maxicoat.com.au']::text[]),
  ('Palram', 'patio', ARRAY['dean.carter@palram.com']::text[], ARRAY['saleswa@palram.com']::text[]),
  ('AB Steel Fabrication', 'patio', ARRAY['info@absteelfabrication.com.au']::text[], ARRAY[]::text[]),
  ('Fielders', 'patio', ARRAY['perthorders@fielders.com.au']::text[], ARRAY[]::text[]),
  ('QSM Fabrication', 'patio', ARRAY['sales@qsmfabrication.com.au']::text[], ARRAY['giuseppe@qsmfabrication.com.au']::text[]),
  ('Unique Laser', 'patio', ARRAY['laser.perth@uniquelaser.com.au']::text[], ARRAY[]::text[])
) AS v(name, used_for, to_emails, cc_emails)
ON CONFLICT (org_id, name) DO NOTHING;

-- The links. Only supplier rows that exist in this organisation are linked.
-- Bunnings: the approved list named one row and "8 more Bunnings rows, all
-- email null"; all nine are linked here (checked by name, read only, 23 Oct).
INSERT INTO public.dispatch_approved_supplier_email_links (supplier_id, approved_id, org_id, created_by_email)
SELECT s.id, a.id, a.org_id, 'seed:dispatch_v2_emails'
FROM (VALUES
  ('R&R Fencing', 'c2bf210b-11dc-4821-849a-39a6de25aaaf'),
  ('R&R Fencing', '022434eb-bba0-4726-b6ce-71a40632a275'),
  ('R&R Fencing', 'fce8671a-1437-4afb-a434-35f0ab3ec0a0'),
  ('Fencing Warehouse WA', '6e81fd10-63c0-4267-a6e2-1cfc8e4e518a'),
  ('Fencing Warehouse WA', '78778acb-7269-456d-832c-22b5cc1537fd'),
  ('Fencing Warehouse WA', 'f7c6f9f2-9cce-4074-baf2-6eef0e76ebe6'),
  ('Lysaght', '917f2f1d-eba5-4b17-b203-1e288324bb8c'),
  ('Oxworks', '612cd76d-1809-4d66-839d-57991fd0cf13'),
  ('Teamwork Fencing', 'debc5dfa-061c-44a1-86e1-ba79162ec2c1'),
  ('Fencing Supply Centre', '407023a1-75b7-4d21-b4e0-d2a848afddae'),
  ('Twinside Retaining', '6be6423e-f615-45ed-9ee8-6b96a3cdd212'),
  ('Fence Makers', '0468f8c2-0763-4596-9f41-ee6a32a3cad9'),
  ('Stratco WA', '7d303bb6-7862-4885-b6a1-7581e2872a13'),
  ('Stratco WA', '62ca6b19-5f5f-4be0-86f5-4d566ad2d7a2'),
  ('Stratco WA', '5449fbde-7357-4528-b2a7-8320fd4d7940'),
  ('Stratco WA', 'ca9c12b8-0b2c-401f-b6a8-a6bd52d0cdac'),
  ('B&D Metals Group', '9d022516-5ae7-4c5b-adc8-2aed728f4714'),
  ('B&D Metals Group', '717f7189-89d8-486d-bec3-be59dc49b93f'),
  ('B&D Metals Group', 'b18155a5-9590-4795-9fa5-32e556766dd7'),
  ('Metroll Perth', 'bd19404d-d5ec-45a3-9360-ec435acc82e5'),
  ('Metroll Perth', '255f342f-6326-48fa-9953-88ecb63249e9'),
  ('Metroll Perth', '3a59e1ae-c314-45bb-89af-97c8add288f6'),
  ('Metroll Perth', 'cec439dd-76d2-4e43-99c7-4e142cead93e'),
  ('Metroll Perth', '5073a445-0572-4560-ad0c-e7fbafd9f665'),
  ('Bunnings', '57ab8d8c-1865-41cd-b0b0-d0055997ad89'),
  ('CMI (Combined Metal Industries)', '134e926d-d3b5-43a0-9db0-e2b7d7e565ab'),
  ('CMI (Combined Metal Industries)', 'cad56667-fb78-4232-948e-0d6457d9626f'),
  ('CMI (Combined Metal Industries)', 'a8c0fc33-4cf3-4a51-b67f-a2057853f957'),
  ('CMI (Combined Metal Industries)', '983e3092-8952-4f24-89d5-1a059973cd30'),
  ('Ampelite', '79d6bac0-885b-4a50-ad73-8e01730b200b'),
  ('Bondor', 'b6aacf3b-5ca7-400b-aa39-5c2eed2a465c'),
  ('JB Patios & Fabrications', '97020db5-d527-44c1-b9ef-5d3b83dbc6ae'),
  ('JB Patios & Fabrications', 'f7fb55f0-784a-4b9e-ba7a-d6921394e47a'),
  ('Panelmakers (Showbury)', '10257497-3822-402c-b48a-7a4b03e048b6'),
  ('Bunnings', '7746c5cf-57f9-4ef3-a4f7-af1519a17425'),
  ('Bunnings', '30f95b4a-e3f8-494e-a933-8add453a24ff'),
  ('Bunnings', '4a7d6d84-1c2b-4b6c-a600-f45dd08bb61d'),
  ('Bunnings', '3aa6c1bc-b4f8-4e5b-a5a3-36d4f7441959'),
  ('Bunnings', '7133480e-5a29-4e9a-b591-c8a49b811278'),
  ('Bunnings', 'bbc5da0b-8c82-4d26-b4fc-acabf8472e7d'),
  ('Bunnings', '677bcfaf-3684-47e8-a100-5edb616ed0ec'),
  ('Bunnings', 'fbf9556c-d2b6-407b-85a3-b5dd003753c1'),
  -- Ruled 23 Oct 2026: MACKSON MANUFACTURING PTY LTD, the live Xero contact
  -- with recent bills. d08cc885-7b45-4411-9d6d-13a5d13ae143 is a duplicate
  -- contact and is deliberately NOT linked.
  ('Mackson', '20d06d01-dab9-4493-a7d8-c2dcda4f3274'),
  -- Ruled 23 Oct 2026: Palram Australia Pty Ltd.
  ('Palram', '8f1d2d75-6905-4e02-b266-88a48c628e83')
) AS v(approved_name, supplier_id)
JOIN public.dispatch_approved_supplier_emails a
  ON a.name = v.approved_name AND a.org_id = '00000000-0000-0000-0000-000000000001'::uuid
JOIN public.suppliers s
  ON s.id = v.supplier_id::uuid AND s.org_id = a.org_id
ON CONFLICT (supplier_id) DO NOTHING;
