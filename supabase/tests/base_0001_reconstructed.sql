-- Test fixture only. This is a RECONSTRUCTION of the live 0001 schema, rebuilt from the table/column listing,
-- the pg_policies output and the function bodies that were read from the real project.
-- It also stubs the Supabase pieces the tests need (auth.users, auth.uid(), storage.objects) and a stand-in
-- claim_match(), whose real body was not inspected. Never run this against the real project.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create schema storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name, '/'))[1:greatest(cardinality(string_to_array(name, '/')) - 1, 0)] $$;
grant usage on schema storage to anon, authenticated;
grant select, insert on storage.objects to anon, authenticated;

create type item_status as enum ('pending_dropoff', 'unclaimed', 'claim_pending', 'claimed', 'archived');
create type user_role as enum ('student', 'staff');

create table categories (id text primary key, label text not null);
create table gates (id text primary key, name text not null);
create table profiles (id uuid primary key references auth.users (id) on delete cascade, name text not null,
  student_id text not null, role user_role not null default 'student', strikes integer not null default 0);
create table items (
  id bigint generated always as identity primary key, title text not null,
  category text not null references categories (id), gate text not null references gates (id),
  tags text[] not null default '{}', description text not null default '', found_at timestamptz not null default now(),
  status item_status not null default 'pending_dropoff', photo_path text, finder_id uuid not null references profiles (id),
  source text not null default 'self-service', code text, flagged_at timestamptz, disposition text,
  created_at timestamptz not null default now());
create table item_private (item_id bigint primary key references items (id) on delete cascade, secret text not null default '');
create table claims (id bigint generated always as identity primary key, item_id bigint not null references items (id),
  claimant_id uuid not null references profiles (id), details text not null, contact text, score numeric,
  matched text[] default '{}', missed text[] default '{}', status text not null default 'pending',
  created_at timestamptz not null default now(), decided_at timestamptz);
create table claim_attempts (claimant_id uuid not null, item_id bigint not null, fails integer not null default 0,
  primary key (claimant_id, item_id));
create table reports (id bigint generated always as identity primary key, owner_id uuid not null references profiles (id),
  title text not null, category text not null, gate text not null, tags text[] not null default '{}',
  description text not null default '', contact text, lost_at timestamptz not null default now(),
  status text not null default 'open', created_at timestamptz not null default now());
create table alerts (id bigint generated always as identity primary key, report_id bigint not null, item_id bigint not null,
  score numeric not null, seen boolean not null default false, created_at timestamptz not null default now());
create table audit_log (seq bigint generated always as identity primary key, at timestamptz not null default now(),
  actor uuid, actor_name text, role text, action text not null, item_id bigint, detail text not null default '');

-- Supabase hands every table to anon/authenticated by default; RLS is what protects them.
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- ===== functions, copied from the live project =====
create or replace function public.is_staff() returns boolean language sql stable security definer set search_path to 'public' as
$f$ select exists (select 1 from profiles where id = auth.uid() and role = 'staff') $f$;

create or replace function public.log_action(p_action text, p_item bigint, p_detail text) returns void language sql
security definer set search_path to 'public' as
$f$ insert into audit_log (actor, actor_name, role, action, item_id, detail)
  select p.id, p.name, p.role::text, p_action, p_item, p_detail from profiles p where p.id = auth.uid() $f$;

create or replace function public.audit_guard() returns trigger language plpgsql as
$f$ begin raise exception 'audit_log is append-only'; end $f$;
create trigger audit_no_change before delete or update on public.audit_log for each row execute function audit_guard();

create or replace function public.archive_item(p_item bigint, p_disposition text default 'archived'::text)
returns void language plpgsql security definer set search_path to 'public' as
$f$ begin
  if not is_staff() then raise exception 'Staff access only'; end if;
  update items set status = 'archived', disposition = p_disposition where id = p_item and status in ('unclaimed','claimed','pending_dropoff');
  perform log_action(case when p_disposition = 'donated' then 'ITEM_DONATED' else 'ITEM_ARCHIVED' end, p_item, p_disposition);
end $f$;

create or replace function public.decide_claim(p_claim bigint, p_approve boolean)
returns void language plpgsql security definer set search_path to 'public' as
$f$ declare c claims;
begin
  if not is_staff() then raise exception 'Staff access only'; end if;
  update claims set status = case when p_approve then 'approved' else 'rejected' end, decided_at = now()
    where id = p_claim and status = 'pending' returning * into c;
  if c.id is null then raise exception 'Claim not found or already decided'; end if;
  update items set status = case when p_approve then 'claimed' else 'unclaimed' end::item_status where id = c.item_id;
  perform log_action(case when p_approve then 'CLAIM_APPROVED' else 'CLAIM_REJECTED' end, c.item_id, 'Claim ' || p_claim);
end $f$;

create or replace function public.receive_item(p_code text, p_secret text default null::text)
returns items language plpgsql security definer set search_path to 'public' as
$f$ declare it items;
begin
  if not is_staff() then raise exception 'Staff access only'; end if;
  update items set status = 'unclaimed', code = null where code = upper(p_code) and status = 'pending_dropoff' returning * into it;
  if it.id is null then raise exception 'No pending item matches that drop-off code'; end if;
  if coalesce(p_secret, '') <> '' then
    insert into item_private (item_id, secret) values (it.id, p_secret)
      on conflict (item_id) do update set secret = excluded.secret;
  end if;
  perform log_action('ITEM_VERIFIED', it.id, 'Physically received');
  return it;
end $f$;

-- The ORIGINAL submit_claim, verbatim, so the test can show the crash that 0002 fixes.
create or replace function public.submit_claim(p_item bigint, p_details text, p_contact text default null::text)
returns json language plpgsql security definer set search_path to 'public' as
$f$ declare it items; sec text; m record; fails int; cid bigint;
begin
  select * into it from items where id = p_item for update;
  if it.id is null or it.status <> 'unclaimed' then raise exception 'This item can''t be claimed right now'; end if;
  if it.finder_id = auth.uid() then raise exception 'You reported this item, so you can''t claim it'; end if;
  if char_length(trim(p_details)) < 8 then raise exception 'Describe at least one detail only the owner would know'; end if;
  select coalesce(fails, 0) into fails from claim_attempts where claimant_id = auth.uid() and item_id = p_item;
  if coalesce(fails, 0) >= 3 then raise exception 'Too many unsuccessful attempts. Visit the security office with a valid ID'; end if;
  select secret into sec from item_private where item_id = p_item;
  if coalesce(sec, '') <> '' then
    select * into m from claim_match(sec, p_details);
    if m.score < 0.5 then
      insert into claim_attempts values (auth.uid(), p_item, 1)
        on conflict (claimant_id, item_id) do update set fails = claim_attempts.fails + 1;
      perform log_action('CLAIM_FAILED', p_item, 'Details did not match');
      return json_build_object('ok', false, 'attemptsLeft', 2 - coalesce(fails, 0));
    end if;
  end if;
  insert into claims (item_id, claimant_id, details, contact, score, matched, missed)
    values (p_item, auth.uid(), p_details, p_contact, m.score, m.matched, m.missed) returning id into cid;
  update items set status = 'claim_pending' where id = p_item;
  perform log_action('CLAIM_SUBMITTED', p_item, 'Claim ' || cid);
  return json_build_object('ok', true, 'claimId', cid);
end $f$;

-- STAND-IN for the real claim_match (body not inspected): share of the secret's words found in the claim.
create or replace function public.claim_match(secret text, claimed text, out score numeric, out matched text[], out missed text[])
language plpgsql as
$f$ declare toks text[]; cl text := lower(claimed);
begin
  select array_agg(distinct t) into toks from unnest(regexp_split_to_array(lower(secret), '[^a-z0-9]+')) t where length(t) >= 3;
  select coalesce(array_agg(t), '{}') into matched from unnest(coalesce(toks, '{}')) t where position(t in cl) > 0;
  select coalesce(array_agg(t), '{}') into missed from unnest(coalesce(toks, '{}')) t where position(t in cl) = 0;
  score := case when coalesce(cardinality(toks), 0) = 0 then 0 else round(cardinality(matched)::numeric / cardinality(toks), 2) end;
end $f$;

-- ===== RLS + policies, copied from pg_policies =====
alter table profiles enable row level security; alter table items enable row level security;
alter table item_private enable row level security; alter table claims enable row level security;
alter table reports enable row level security; alter table alerts enable row level security;
alter table audit_log enable row level security; alter table gates enable row level security;
alter table categories enable row level security;
-- claim_attempts: RLS deliberately NOT enabled, to prove 0002 turns it on.

create policy profile_self on profiles for select using (id = auth.uid() or is_staff());
create policy items_insert on items for insert with check (
  (finder_id = auth.uid() and status = 'pending_dropoff'::item_status and source = 'self-service'::text) or is_staff());
create policy items_read on items for select using (
  status = any (array['unclaimed'::item_status, 'claim_pending'::item_status]) or finder_id = auth.uid() or is_staff());
create policy private_insert on item_private for insert with check (
  is_staff() or exists (select 1 from items i where i.id = item_private.item_id and i.finder_id = auth.uid() and i.status = 'pending_dropoff'::item_status));
create policy private_staff on item_private for select using (is_staff());
create policy claims_read on claims for select using (claimant_id = auth.uid() or is_staff());
create policy reports_rw on reports for all using (owner_id = auth.uid() or is_staff()) with check (owner_id = auth.uid());
create policy alerts_read on alerts for select using (
  exists (select 1 from reports r where r.id = alerts.report_id and r.owner_id = auth.uid()) or is_staff());
create policy audit_staff on audit_log for select using (is_staff());
create policy ref_read_g on gates for select using (true);
create policy ref_read_c on categories for select using (true);
