# FINDr

Campus lost-and-found. Search runs on a Python DSA engine (linear / binary / jump search, merge sort, Trie, queue, stack, heap, linked list); login and storage stay in Supabase.

## Run locally (browser-storage demo, no backend)
    npm install && npm run build && open findr.html

## Supabase backend
1. In the Supabase SQL editor run `supabase/migrations/0002_hardening_and_rpc.sql` (0001 must already exist). Safe to re-run.
2. Create a private storage bucket named `item-photos`.
3. Authentication → Sign In / Providers → Email: turn "Confirm email" off for demos.
4. Sign up in the app, then promote yourself to staff (SQL editor):
       update public.profiles set role = 'staff' where id = (select id from auth.users where email = 'you@example.com');
5. Optional sample items: run `supabase/seed_demo.sql`.

## Python DSA engine (the core of the project)
Code lives in `backend/findr_dsa/`, standard library only (Python 3.9+, no pip install).

    python backend/server.py --demo        # sample data, no accounts needed
    SUPABASE_URL=... SUPABASE_KEY=... python backend/server.py   # real items from Supabase (publishable key only)

Open http://127.0.0.1:3000 (run `npm run build` first so the page exists). The server answers every search and
autocomplete request with the Python engine; the **DSA Lab** page shows each algorithm step by step and benchmarks them.
If the server is off, the page falls back to the JavaScript search.

| Where in FINDr | DSA | File |
|---|---|---|
| Find item by id, filter by date window | Binary search vs linear search vs jump search | `searching.py` |
| Keep lists sorted, order results | Merge sort | `sorting.py` |
| Keyword search, autocomplete | Trie | `structures.py` |
| Claims waiting for review | Queue (on a linked list) | `structures.py` |
| Staff undo | Stack | `structures.py` |
| Items due for disposal | Min-heap | `structures.py` |
| Typo correction | Edit distance (dynamic programming) | `text.py` |

Compare the algorithms from the command line: `python -m findr_dsa.benchmark --sizes 1000 10000 100000` (run inside `backend/`).

## Vercel
Set environment variables `SUPABASE_URL` and `SUPABASE_KEY` (publishable key only, never `sb_secret_`/service_role) and deploy.
`vercel.json` runs `node build.js` and serves `dist/`. Without the variables the build ships the browser-storage demo.

## Tests
    npm test          # DSA + store + adapter end-to-end against PGlite
    npm run test:sql  # 69 database policy/function checks
    npm run test:py   # 59 Python tests: algorithms, structures, engine, HTTP API
