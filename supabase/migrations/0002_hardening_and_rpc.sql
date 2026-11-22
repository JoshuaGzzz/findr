-- FINDr migration 0002: fixes, server-side functions and hardening on top of 0001.
-- Safe to run more than once. Run it in the Supabase SQL editor.
--
-- What this fixes (found by reading the live policies and function bodies):
--   1. submit_claim crashed on every call (variable "fails" clashed with column "fails",
--      and an unassigned record was read when an item had no private detail).
--   2. A claimant lost sight of an item once it became CLAIMED, so "bring your ID" had nothing to show.
--   3. Claimants could read claims.matched / claims.missed, which leak parts of the private detail.
--   4. log_action() was callable by any signed-in user (audit-log forgery).
--   5. Nothing created a profiles row at sign-up.
--   6. Nothing implemented reject-as-spam (with strike), rollback, staff claim review or item intake with
--      server-side rate limits.

-- ---------------------------------------------------------------------------------------------
-- 0. Row level security must be on everywhere. (No FORCE: the SECURITY DEFINER functions need to bypass it.)
-- ---------------------------------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.items          enable row level security;
alter table public.item_private   enable row level security;
alter table public.claims         enable row level security;
alter table public.claim_attempts enable row level security;
alter table public.reports        enable row level security;
alter table public.alerts         enable row level security;
alter table public.audit_log      enable row level security;
alter table public.gates          enable row level security;
alter table public.categories     enable row level security;

-- ---------------------------------------------------------------------------------------------
-- 1. Profiles are created by the database when someone signs up. Role can never come from the client.
-- ---------------------------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, student_id)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(coalesce(new.email, 'user'), '@', 1)), 80),
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'student_id'), ''), 'UNKNOWN'), 16)
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: accounts created before this trigger existed.
insert into public.profiles (id, name, student_id)
select u.id,
       left(coalesce(nullif(trim(u.raw_user_meta_data->>'name'), ''), split_part(coalesce(u.email, 'user'), '@', 1)), 80),
       left(coalesce(nullif(trim(u.raw_user_meta_data->>'student_id'), ''), 'UNKNOWN'), 16)
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- ---------------------------------------------------------------------------------------------
-- 2. Policies
-- ---------------------------------------------------------------------------------------------
-- Items can only be created through create_found_item() (rate limits, strikes, drop-off code).
drop policy if exists items_insert   on public.items;
drop policy if exists private_insert on public.item_private;

-- A claimant keeps read access to the item they claimed (it becomes CLAIMED after approval).
-- Done through a SECURITY DEFINER helper: anonymous visitors have no privilege on claims, and a policy that
-- touched claims directly would make public search fail for them.
create or replace function public.is_claimant(p_item bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from claims where item_id = p_item and claimant_id = auth.uid())
$$;
grant execute on function public.is_claimant(bigint) to anon, authenticated;

drop policy if exists items_read on public.items;
create policy items_read on public.items for select using (
  status in ('unclaimed', 'claim_pending')
  or finder_id = auth.uid()
  or is_staff()
  or is_claimant(id)
);

-- ---------------------------------------------------------------------------------------------
-- 3. Table privileges: clients may read what policies allow, and write nothing directly
--    (reports are the one table students write to, guarded by the reports_rw policy).
-- ---------------------------------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger on
  public.items, public.item_private, public.claims, public.claim_attempts, public.audit_log,
  public.alerts, public.profiles, public.gates, public.categories
  from anon, authenticated;
revoke all on public.claim_attempts from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.reports from anon;
revoke truncate, references, trigger on public.reports from authenticated;

-- Claimants may read their own claims, but never the matcher output (it reveals parts of the secret).
-- Staff read the full rows through staff_claims() below.
revoke select on public.claims from anon, authenticated;
grant select (id, item_id, claimant_id, details, contact, status, created_at, decided_at)
  on public.claims to authenticated;

create unique index if not exists claim_attempts_uniq on public.claim_attempts (claimant_id, item_id);
create unique index if not exists items_code_uniq     on public.items (code) where code is not null;

-- ---------------------------------------------------------------------------------------------
-- 4. submit_claim, rewritten. Same contract as before: never reveals the secret.
-- ---------------------------------------------------------------------------------------------
create or replace function public.submit_claim(p_item bigint, p_details text, p_contact text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  it items; sec text; m record; cid bigint;
  v_fails int := 0;
  v_score numeric := null; v_matched text[] := '{}'; v_missed text[] := '{}';
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  select * into it from items where id = p_item for update;
  if it.id is null or it.status <> 'unclaimed' then raise exception 'This item can''t be claimed right now'; end if;
  if it.finder_id = auth.uid() then raise exception 'You reported this item, so you can''t claim it'; end if;
  if char_length(trim(coalesce(p_details, ''))) < 8 then raise exception 'Describe at least one detail only the owner would know'; end if;

  select ca.fails into v_fails from claim_attempts ca where ca.claimant_id = auth.uid() and ca.item_id = p_item;
  v_fails := coalesce(v_fails, 0);
  if v_fails >= 3 then raise exception 'Too many unsuccessful attempts. Visit the security office with a valid ID'; end if;

  select ip.secret into sec from item_private ip where ip.item_id = p_item;
  if coalesce(sec, '') <> '' then
    select * into m from claim_match(sec, p_details);
    v_score := m.score; v_matched := coalesce(m.matched, '{}'); v_missed := coalesce(m.missed, '{}');
    if v_score < 0.5 then
      insert into claim_attempts (claimant_id, item_id, fails) values (auth.uid(), p_item, 1)
        on conflict (claimant_id, item_id) do update set fails = claim_attempts.fails + 1;
      perform log_action('CLAIM_FAILED', p_item, 'Details did not match (attempt ' || (v_fails + 1) || ' of 3)');
      return json_build_object('ok', false, 'attemptsLeft', 2 - v_fails);   -- never reveals the secret
    end if;
  end if;

  insert into claims (item_id, claimant_id, details, contact, score, matched, missed)
    values (p_item, auth.uid(), left(trim(p_details), 300), left(trim(coalesce(p_contact, '')), 80), v_score, v_matched, v_missed)
    returning id into cid;
  update items set status = 'claim_pending' where id = p_item;
  perform log_action('CLAIM_SUBMITTED', p_item,
    case when v_score is null then 'No private detail on file: manual check needed'
         else 'Detail match ' || round(v_score * 100) || '%' end);
  return json_build_object('ok', true, 'claimId', cid);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Intake: students create PENDING items with a drop-off code, staff create UNCLAIMED items.
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_found_item(
  p_title text, p_category text, p_gate text, p_tags text[], p_description text,
  p_found_at timestamptz, p_secret text default null, p_photo_path text default null)
returns items language plpgsql security definer set search_path = public as $$
declare
  me profiles; is_s boolean; it items; v_code text;
  v_title text := trim(coalesce(p_title, ''));
  v_desc text := left(trim(coalesce(p_description, '')), 300);
  v_found timestamptz := coalesce(p_found_at, now());
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  select * into me from profiles where id = auth.uid();
  if me.id is null then raise exception 'Please sign in first'; end if;
  is_s := (me.role = 'staff');
  if char_length(v_title) < 3 or char_length(v_title) > 60 then raise exception 'Give the item a short title (3–60 characters).'; end if;
  if not exists (select 1 from categories where id = p_category) then raise exception 'Choose a category.'; end if;
  if not exists (select 1 from gates where id = p_gate) then raise exception 'Choose a gate or location.'; end if;
  if v_found > now() + interval '5 minutes' then raise exception 'The time found can''t be in the future.'; end if;
  if p_photo_path is not null and p_photo_path not like me.id::text || '/%' then raise exception 'Invalid photo.'; end if;

  if not is_s then
    if v_found < now() - interval '7 days' then raise exception 'Self-service reports must be within the last 7 days. Bring older items to the security office.'; end if;
    if me.strikes >= 2 then raise exception 'Self-service reports are paused on your account. Please hand items directly to campus security.'; end if;
    if (select count(*) from items where finder_id = me.id and source = 'self-service' and created_at > now() - interval '10 minutes') >= 3 then
      raise exception 'Too many reports in a short time. Try again in a few minutes.';
    end if;
  end if;
  if exists (select 1 from items where finder_id = me.id and lower(title) = lower(v_title) and category = p_category
             and gate = p_gate and created_at > now() - interval '10 minutes') then
    raise exception 'You already reported this item a moment ago.';
  end if;

  if not is_s then
    loop
      v_code := '';
      for i in 1..5 loop
        v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      end loop;
      exit when not exists (select 1 from items where code = v_code);
    end loop;
  end if;

  insert into items (title, category, gate, tags, description, found_at, status, photo_path, finder_id, source, code)
  values (v_title, p_category, p_gate, coalesce(p_tags, '{}'), v_desc, v_found,
          (case when is_s then 'unclaimed' else 'pending_dropoff' end)::item_status,
          p_photo_path, me.id, case when is_s then 'staff' else 'self-service' end, v_code)
  returning * into it;

  if coalesce(trim(p_secret), '') <> '' then
    insert into item_private (item_id, secret) values (it.id, left(trim(p_secret), 300));
  end if;
  perform log_action('ITEM_LOGGED', it.id,
    v_title || ' @ ' || (select name from gates where id = p_gate) ||
    case when is_s then ' (staff intake)' else ' (self-service, awaiting drop-off)' end);
  return it;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Staff: reject a pending item as spam (adds a strike), roll a change back, review claims.
-- ---------------------------------------------------------------------------------------------
create or replace function public.reject_pending(p_item bigint, p_reason text default 'spam / never dropped off')
returns void language plpgsql security definer set search_path = public as $$
declare it items;
begin
  if not is_staff() then raise exception 'Staff access only'; end if;
  update items set status = 'archived', disposition = 'rejected'
    where id = p_item and status = 'pending_dropoff' returning * into it;
  if it.id is null then raise exception 'Only pending items can be rejected.'; end if;
  update profiles set strikes = strikes + 1 where id = it.finder_id;
  perform log_action('PENDING_REJECTED', p_item, 'Rejected (' || coalesce(p_reason, 'spam') || '); strike on finder');
end $$;

create or replace function public.staff_rollback(
  p_item bigint, p_kind text, p_claim bigint default null, p_to text default null, p_code text default null)
returns void language plpgsql security definer set search_path = public as $$
declare it items;
begin
  if not is_staff() then raise exception 'Staff access only'; end if;
  select * into it from items where id = p_item for update;
  if it.id is null then raise exception 'Item not found.'; end if;

  if p_kind = 'receive' then
    if it.status <> 'unclaimed' or p_code is null then raise exception 'This item changed since, so it can''t be undone.'; end if;
    update items set status = 'pending_dropoff', code = upper(p_code) where id = p_item;
  elsif p_kind = 'rejectPending' then
    if it.status <> 'archived' then raise exception 'This item changed since, so it can''t be undone.'; end if;
    update items set status = 'pending_dropoff', disposition = null where id = p_item;
    update profiles set strikes = greatest(strikes - 1, 0) where id = it.finder_id;
  elsif p_kind = 'approve' then
    if it.status <> 'claimed' then raise exception 'This item changed since, so it can''t be undone.'; end if;
    update claims set status = 'pending', decided_at = null where id = p_claim and item_id = p_item and status = 'approved';
    if not found then raise exception 'Claim not found.'; end if;
    update items set status = 'claim_pending' where id = p_item;
  elsif p_kind = 'rejectClaim' then
    if it.status <> 'unclaimed' then raise exception 'This item changed since, so it can''t be undone.'; end if;
    update claims set status = 'pending', decided_at = null where id = p_claim and item_id = p_item and status = 'rejected';
    if not found then raise exception 'Claim not found.'; end if;
    update items set status = 'claim_pending' where id = p_item;
  elsif p_kind = 'archive' then
    if it.status <> 'archived' or p_to not in ('unclaimed', 'claimed', 'pending_dropoff') then raise exception 'This item changed since, so it can''t be undone.'; end if;
    update items set status = p_to::item_status, disposition = null where id = p_item;
  else
    raise exception 'Unknown change type';
  end if;
  perform log_action('ROLLBACK', p_item, 'Reverted ' || p_kind);
end $$;

create or replace function public.staff_claims()
returns table (
  claim_id bigint, claim_item_id bigint, claimant_uid uuid, claimant_name text, claimant_student_id text,
  claim_details text, claim_contact text, claim_score numeric, claim_matched text[], claim_missed text[],
  claim_status text, claim_created_at timestamptz, claim_decided_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.item_id, c.claimant_id, p.name, p.student_id, c.details, c.contact, c.score,
         c.matched, c.missed, c.status, c.created_at, c.decided_at
  from claims c left join profiles p on p.id = c.claimant_id
  where is_staff()
  order by c.id
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Function privileges
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.log_action(text, bigint, text) from public, anon, authenticated;

revoke execute on function public.receive_item(text, text)                                    from public, anon;
revoke execute on function public.decide_claim(bigint, boolean)                               from public, anon;
revoke execute on function public.archive_item(bigint, text)                                  from public, anon;
revoke execute on function public.submit_claim(bigint, text, text)                            from public, anon;
revoke execute on function public.create_found_item(text, text, text, text[], text, timestamptz, text, text) from public, anon;
revoke execute on function public.reject_pending(bigint, text)                                from public, anon;
revoke execute on function public.staff_rollback(bigint, text, bigint, text, text)            from public, anon;
revoke execute on function public.staff_claims()                                              from public, anon;

grant execute on function public.receive_item(text, text)                                     to authenticated;
grant execute on function public.decide_claim(bigint, boolean)                                to authenticated;
grant execute on function public.archive_item(bigint, text)                                   to authenticated;
grant execute on function public.submit_claim(bigint, text, text)                             to authenticated;
grant execute on function public.create_found_item(text, text, text, text[], text, timestamptz, text, text) to authenticated;
grant execute on function public.reject_pending(bigint, text)                                 to authenticated;
grant execute on function public.staff_rollback(bigint, text, bigint, text, text)             to authenticated;
grant execute on function public.staff_claims()                                               to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. Photos: private bucket "item-photos". Signed-in users upload into their own folder.
--    Reads are open so the public search page can show photos through short-lived signed URLs.
-- ---------------------------------------------------------------------------------------------
drop policy if exists findr_photos_insert on storage.objects;
create policy findr_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'item-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists findr_photos_read on storage.objects;
create policy findr_photos_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'item-photos');
