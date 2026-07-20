# Supabase setup

The application uses prefixed database objects so it does not collide with
unrelated tables in the same Supabase project:

- Table: `public.mpr_user_app_states`
- Private Storage bucket: `mpr-photos`
- Policies: names beginning with `mpr_`

## 1. Create the table, bucket, and RLS policies

Open the target Supabase project's SQL Editor and run:

[`supabase/migrations/001_mpr_sync.sql`](supabase/migrations/001_mpr_sync.sql)

The publishable browser key cannot create tables. Do not place a service-role
key in this application or in any `VITE_` environment variable.

## 2. Configure email login redirects

In Authentication > URL Configuration, add the URLs used by the application,
including the local development URL when testing:

- `http://127.0.0.1:5174`
- The final deployed application origin

## 3. Environment variables

Copy the two `VITE_SUPABASE_*` variables from `.env.example` into `.env` and
use the project's URL and publishable key. `.env` is gitignored.

## 4. Safety behavior

- Signing in never starts a sync.
- “检查同步” performs a read-only comparison.
- “确认同步” first creates a full local IndexedDB backup.
- Automated tests use pure/in-memory data and do not contact Supabase.
- Recovery changes local data only and does not automatically sync afterward.
