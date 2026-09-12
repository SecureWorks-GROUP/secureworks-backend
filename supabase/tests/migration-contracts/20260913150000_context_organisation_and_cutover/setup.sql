ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS org_id uuid;
CREATE TABLE IF NOT EXISTS public.organisations (id uuid PRIMARY KEY, name text);
INSERT INTO public.organisations(id,name) VALUES('00000000-0000-4000-8000-0000000000aa','Org A')
 ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organisations(id,name) VALUES('00000000-0000-4000-8000-0000000000bb','Org B')
 ON CONFLICT (id) DO NOTHING;
