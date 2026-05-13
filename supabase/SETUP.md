# SecureWorks — Supabase Setup Guide

## Step 1: Create Supabase Project

1. Go to https://supabase.com and sign up / log in
2. Click "New Project"
3. Name it `secureworks` (or whatever you like)
4. Set a database password (save it somewhere safe)
5. Choose region: **Southeast Asia (Singapore)** (closest to Perth)
6. Wait for it to spin up (~2 minutes)

## Step 2: Run the Database Schema

1. In your Supabase dashboard, go to **SQL Editor**
2. Click **New Query**
3. Open `migrations/001_schema.sql` from this folder
4. Paste the entire contents into the SQL editor
5. Click **Run**
6. You should see "Success. No rows returned" — that means all tables were created

### Verify:
Go to **Table Editor** in the sidebar. You should see:
- `organisations` (with 1 row — SecureWorks WA)
- `users`
- `jobs`
- `job_documents`
- `job_media`
- `job_events`
- `job_assignments`

## Step 3: Get Your API Keys

1. Go to **Settings** → **API**
2. Copy:
   - **Project URL** → e.g. `https://abcd1234.supabase.co`
   - **anon public** key → starts with `eyJ...`
3. Copy `config.example.js` to `config.js`:
   ```
   cp config.example.js config.js
   ```
4. Paste your values into `config.js`

## Step 4: Configure Auth

1. Go to **Authentication** → **Providers**
2. **Email** should be enabled by default
3. Under Email settings, enable **Magic Link**
4. Set the Site URL to your domain (or `http://localhost` for local dev)
5. Add your domain to **Redirect URLs**: `https://yourdomain.com/*`

### Add Yourself as a User
1. Go to **Authentication** → **Users**
2. Click **Add User**
3. Enter your email, set a password, click **Create User**
4. Then go to **Table Editor** → `users` table
5. Click **Insert Row**:
   - `id`: paste the UUID from the auth user you just created
   - `org_id`: `00000000-0000-0000-0000-000000000001`
   - `name`: `Marnin`
   - `email`: your email
   - `role`: `admin`

## Step 5: Configure Storage

The migration script creates storage buckets automatically. Verify:
1. Go to **Storage** in the sidebar
2. You should see 3 buckets:
   - `job-photos`
   - `job-videos`
   - `job-pdfs`

If they're not there, create them manually with these names.

## Step 6: Deploy Edge Functions (Optional — for GHL + Quotes)

### Install Supabase CLI
```bash
brew install supabase/tap/supabase
```

### Login
```bash
supabase login
```

### Link your project
```bash
cd /path/to/secureworks-site/supabase
supabase link --project-ref YOUR_PROJECT_REF
```

### Set environment variables
```bash
supabase secrets set GHL_WEBHOOK_SECRET="your-secret-here"
supabase secrets set RESEND_API_KEY="re_your_key"
supabase secrets set FROM_EMAIL="quotes@secureworkswa.com.au"
supabase secrets set FROM_NAME="SecureWorks WA"
```

### Deploy
```bash
supabase functions deploy ghl-webhook
scripts/deploy-edge-function.sh send-quote
```

### GHL Webhook URL
After deploying, your GHL webhook URL will be:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/ghl-webhook
```

In GoHighLevel:
1. Go to your form → **Settings** → **Webhooks**
2. Add the URL above
3. Set the header `X-Webhook-Secret` to your secret value

## Step 7: Wire Up the Scoping Tools

Add these script tags to both scoping tool HTML files (before the closing `</body>` tag):

```html
<!-- Supabase + Cloud Module -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="../shared/brand.js"></script>
<script src="../shared/cloud.js"></script>
<script src="../shared/media.js"></script>
<script>
  // Configure Supabase (or use config.js)
  window.SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
  window.SUPABASE_ANON_KEY = 'eyJ...';
</script>
```

The tools will automatically detect `window.SECUREWORKS_CLOUD` and show cloud features.

## Step 8: Email Setup (for Send Quote)

The quote-sending feature uses [Resend](https://resend.com):
1. Sign up at https://resend.com
2. Add and verify your domain (`secureworkswa.com.au`)
3. Create an API key
4. Set it as a Supabase secret (Step 6 above)

---

## File Structure

```
supabase/
├── config.example.js      ← Copy to config.js with your keys
├── config.js              ← (git-ignored) Your actual keys
├── SETUP.md               ← This file
├── migrations/
│   └── 001_schema.sql     ← Database schema
└── functions/
    ├── ghl-webhook/
    │   └── index.ts        ← GHL form → draft job
    └── send-quote/
        └── index.ts        ← Email quotes + client acceptance page
```

## Troubleshooting

**"No Supabase config found — running in offline mode"**
→ Make sure `window.SUPABASE_URL` and `window.SUPABASE_ANON_KEY` are set before cloud.js loads

**Auth not working**
→ Check that your domain is in the Redirect URLs under Authentication settings

**Storage upload fails**
→ Check that storage buckets exist and RLS policies are applied

**GHL webhook returns 401**
→ Verify the `X-Webhook-Secret` header matches your `GHL_WEBHOOK_SECRET` secret
