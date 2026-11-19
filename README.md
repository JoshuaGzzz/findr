# FINDr

Campus lost-and-found: Trie search, smart matching, secure claims, retention heap, undo stack, audit log.

## Run locally (browser-storage demo, no backend)
    npm install && npm run build && open findr.html

## Supabase backend
1. In the Supabase SQL editor run `supabase/migrations/0002_hardening_and_rpc.sql` (0001 must already exist). Safe to re-run.
2. Create a private storage bucket named `item-photos`.
3. Authentication → Sign In / Providers → Email: turn "Confirm email" off for demos.
4. Sign up in the app, then promote yourself to staff (SQL editor):
       update public.profiles set role = 'staff' where id = (select id from auth.users where email = 'you@example.com');
5. Optional sample items: run `supabase/seed_demo.sql`.

## Vercel
Set environment variables `SUPABASE_URL` and `SUPABASE_KEY` (publishable key only, never `sb_secret_`/service_role) and deploy.
`vercel.json` runs `node build.js` and serves `dist/`. Without the variables the build ships the browser-storage demo.

## Tests
    npm test          # DSA + store + adapter end-to-end against PGlite
    npm run test:sql  # 69 database policy/function checks
