# Trade App Setup Guide

**Last Updated:** 4 March 2026

This guide covers creating crew accounts, installing the Trade App as a PWA, and troubleshooting common issues.

---

## 1. Creating Crew Accounts

Crew members sign into the Trade App with email + password (not magic link). Accounts are created through the Supabase Auth dashboard.

### Step-by-Step: Create a New Crew Account

1. Go to the Supabase Dashboard: `https://supabase.com/dashboard/project/kevgrhcjxspbxgovpmfl`
2. Click **Authentication** in the left sidebar
3. Click **Add user** > **Create new user**
4. Fill in:
   - **Email:** The crew member's email (e.g., `henry@secureworks.com.au`)
   - **Password:** Set a strong initial password and share it with them securely
   - **Auto-confirm:** Toggle ON (skips email verification)
5. Click **Create user**

### Step-by-Step: Add User to the Users Table

After creating the auth account, add them to the `users` table so the system recognises them:

1. In Supabase Dashboard, go to **Table Editor** > **users**
2. Click **Insert row**
3. Fill in:
   - **id:** Copy the UUID from the auth user you just created
   - **org_id:** `00000000-0000-0000-0000-000000000001`
   - **name:** Their display name (e.g., "Henry Mitchell") — this shows in the app header and on job notes
   - **email:** Same email as auth
   - **role:** `installer` (or `estimator` for scoping staff)
4. Click **Save**

**Note:** If the user logs in before you add them to the `users` table, the system auto-creates a row with their email prefix as the name and `estimator` as the role. You can edit this row to set the correct name and role.

### Assigning Crew to Jobs

Once the crew account exists, assign them to jobs through the Ops Dashboard:

1. Open the **Ops Dashboard** (`/dashboard/ops.html`)
2. Navigate to the job you want to assign
3. In the job detail view, use the **Schedule/Assign** section
4. Select the crew member from the user dropdown
5. Set the scheduled date, start time, and role (e.g., `lead_installer`)
6. Optionally set a crew name (e.g., "Henry's Team")
7. Save the assignment

The crew member will see this job appear in their Trade App under "My Jobs".

---

## 2. Installing the Trade App (PWA)

The Trade App is a Progressive Web App — it works like a native app when installed to the home screen.

**App URL:** `https://secureworks-site.vercel.app/dashboard/trade.html`
*(Replace with actual production URL if different)*

### Installing on iPhone (Safari)

1. Open **Safari** and go to the Trade App URL
2. Tap the **Share** button (square with arrow, bottom of screen)
3. Scroll down and tap **Add to Home Screen**
4. The name will auto-fill as "SW Trade" — tap **Add**
5. The app icon appears on your home screen
6. Open from home screen — it runs fullscreen without Safari's address bar

### Installing on Android (Chrome)

1. Open **Chrome** and go to the Trade App URL
2. Tap the **three-dot menu** (top right)
3. Tap **Add to Home screen** (or **Install app** if prompted)
4. Confirm the name "SecureWorks Trade" and tap **Add**
5. The app icon appears on your home screen
6. Open from home screen — it runs as a standalone app

### What It Looks Like

- **App name:** "SW Trade" (on home screen)
- **Icon:** SecureWorks house icon
- **Theme colour:** Dark blue (#293C46) status bar
- **Orientation:** Portrait mode
- The app caches its shell files (HTML, JS) so the login screen loads instantly, even on slow connections

### First Login

1. Open the app from your home screen
2. Enter your email and password (provided by admin)
3. Tap **Log In**
4. You'll see your assigned jobs under "My Jobs"

---

## 3. Troubleshooting

### Session Expired

**Symptom:** "Session expired — please log in again" error, or app shows login screen unexpectedly.

**Fix:**
1. Enter your email and password again
2. Tap **Log In**
3. Sessions can expire after extended inactivity — this is normal

### App Won't Load / Blank Screen

**Symptom:** White screen, spinner that never stops, or "Failed to load — please refresh the page" message.

**Fixes (try in order):**
1. **Check your internet connection** — the app needs internet for the initial load
2. **Force-refresh:** Pull down to refresh, or close and reopen the app
3. **Clear cache:**
   - **iPhone:** Settings > Safari > Clear History and Website Data
   - **Android:** Chrome > Settings > Site settings > Clear data for the app URL
4. **Re-install the PWA:** Delete the home screen icon, then follow the install steps again
5. If the problem persists, ask Marnin or Shaun to check if the Supabase service is running

### Photos Won't Upload

**Symptom:** Photo upload spinner runs but never completes, or shows an error.

**Fixes:**
1. **Check your signal** — uploads need a stable connection (Wi-Fi or strong mobile data)
2. **Retry** — close the job detail, reopen it, and try uploading again
3. **Smaller photos** — if on very slow data, the upload may time out on large files
4. Photos use a signed URL upload flow (not base64), so they go directly to storage — large files should work but need a stable connection

**How uploads work:** The app requests a signed upload URL from the server, uploads the photo directly to Supabase Storage, then registers the media record in the database. If any step fails, the photo won't appear but you can retry.

### Notes Won't Save (Offline Queue)

**Symptom:** You wrote a note but it says "Saved offline — will sync when connected."

**This is normal behaviour.** The app saves notes locally when you have no internet. They sync automatically when you're back online. You'll see a toast message like "2 offline note(s) synced" when they upload.

If offline notes aren't syncing after you're back online:
1. Navigate away from the current job and back
2. The app syncs pending notes on login and when loading jobs

### Jobs Not Showing

**Symptom:** "My Jobs" tab is empty or missing expected jobs.

**Fixes:**
1. **Check assignment in Ops Dashboard** — the crew member must be assigned to the job with their user ID
2. Jobs only show if:
   - The assignment status is not `cancelled`
   - The scheduled date is within the last 30 days or in the future
3. Ask Shaun to verify the assignment exists in the Ops Dashboard job detail view

### Signature Pad Issues

**Symptom:** Signature pad doesn't respond to touch, or signature doesn't save.

**Fixes:**
1. **Use your finger, not a stylus** — some styluses don't register properly on the canvas
2. **Rotate to landscape** if the pad area is too small in portrait
3. **Clear and retry** — tap the "Clear Signature" button and try again
4. The signature is required before submitting a service report — both the drawn signature and the typed name must be filled in
5. Signature data is NOT saved to localStorage (it's too large) — if you navigate away before submitting, you'll need to re-sign

### Address / Suburb Blank on Job

**Symptom:** Job detail shows no address or suburb.

**Cause:** The address wasn't entered in GHL or the scoping tool, so it wasn't synced to our system.

**Fix:**
1. Ask Shaun to update the address in the Ops Dashboard job detail
2. Or update the GHL contact with the correct address — the next sync will pull it through
3. For navigation, you can ask the client directly and use your phone's Maps app

### Can't Submit Service Report

**Symptom:** "Please get the homeowner signature" or other validation error when submitting.

**Required fields for service report submission:**
- Completion photos (at least one)
- Homeowner signature (drawn on the signature pad)
- Signer name (typed below the signature pad)
- Any outstanding items noted

### App Running Slowly

**Fixes:**
1. Close other apps on your phone to free memory
2. The app is a single HTML page — if it's been open for a long time, close and reopen it
3. Clear the PWA cache and re-install (see "App Won't Load" above)
