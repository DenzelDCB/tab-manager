# Tab Manager - Phase 1

This ZIP is the **Phase 1 starter project**, not the complete multi-phase
extension. It includes the Manifest V3 scaffold, placeholder UI/background
files, and the SQL needed to create the initial Supabase tables and policies.

## 1. Create the Supabase project

1. Open https://supabase.com/dashboard.
2. Create a project and wait for provisioning to finish.
3. Open **Project Settings -> API** (or the API Keys section in the current
   dashboard).
4. Copy the Project URL and the publishable key (or legacy anon key).
5. Do not copy or use the `service_role` / secret key in the extension.

## 2. Run the database SQL

1. In the Supabase dashboard, open **SQL Editor**.
2. Create a new query.
3. Open `sql/001_setup.sql` from this project.
4. Paste the entire file into the SQL Editor and run it.
5. Confirm that `public.tabs` and `public.commands` exist under **Table Editor**.
6. Confirm RLS is enabled for both tables.

The SQL also adds `public.commands` to the `supabase_realtime` publication
when that publication exists and the table is not already included.

## 3. Configure the extension

Edit `manifest.json` and replace:

    https://YOUR_PROJECT_REF.supabase.co/*

with your exact Supabase project hostname, retaining `/*`.

Edit `lib/supabase.js` and replace:

- `YOUR_PROJECT_REF` with your project reference.
- `YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY` with your publishable key
  (or legacy anon key).

The publishable/anon key is intended for client use. RLS is what protects
the rows. Never put a `service_role` or secret key in this extension.

## 4. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `tab-manager-phase1` folder (the folder containing
   `manifest.json`).
5. Confirm that the extension appears without errors.
6. Click its toolbar icon. You should see the Phase 1 placeholder popup.

## 5. Create an authentication user

For the initial test account:

1. Open **Authentication -> Users** in Supabase.
2. Choose **Add user**.
3. Create an email/password user.
4. Confirm the user appears in the users list.

The login UI is intentionally not implemented in Phase 1.

## Database model notes

- `user_id` links each record to a Supabase Auth user.
- `device_id` distinguishes separate browser installations. A Chrome
  `browser_tab_id` is only meaningful within a browser instance and can be
  reused, so it must not be treated as globally unique.
- `browser_tab_id` and `window_id` are stored as `bigint`.
- The `tabs` table has one current row per user/device/tab combination.
- The `commands` table stores close/block requests for a specific device/tab.

## Important security boundary

The policies in this starter project let a signed-in user access only rows
whose `user_id` equals their own Supabase Auth UID. They support a user's
own enrolled browser(s), not a central administrator controlling arbitrary
other users.

Before implementing cross-user administration, Phase 2/3 must introduce a
server-verified administrator role and a trusted command-creation path
(for example, a Supabase Edge Function). Do not solve this by exposing the
service-role key or by letting the extension choose arbitrary `user_id`
values. The extension should validate that a command's `device_id` matches
its own persisted device ID before acting.

## What's intentionally not implemented

- Tab event synchronization
- Supabase client bundling and authentication session handling
- Supabase Realtime subscription in the service worker
- Admin role management and cross-user command authorization
- Close/block command execution and acknowledgement
- Production blocked-page enforcement

These are later phases. This ZIP deliberately does not generate all phases
at once.
