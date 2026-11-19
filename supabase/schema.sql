-- Block Out Level Lab у Supabase. Вхід — email + пароль (доступ видає власник), запасний — посилання на email.
-- Запустіть цей файл один раз: Supabase → SQL Editor → New query → вставити → Run.
-- Повторний запуск безпечний. ПЕРЕД запуском впишіть свій email у самому кінці файлу (власник).
--
-- Що тут: редактори і запити на доступ, версії й варіації рівнів (lab_entries), налаштування, бакет `levels`
-- для файлів рівнів (gzip). Читати може будь-хто, писати — лише редактори; права перевіряє база (RLS).

create extension if not exists pgcrypto with schema extensions;

-- ── Хто може редагувати ──────────────────────────────────────────────────

create table if not exists public.lab_members (
  email    text primary key,             -- завжди в нижньому регістрі
  is_owner boolean not null default false,
  added_at timestamptz not null default now()
);
alter table public.lab_members enable row level security;

create or replace function public.me_email() returns text
language sql stable as $$ select lower(auth.jwt() ->> 'email') $$;

create or replace function public.me_name() returns text
language sql stable as $$
  select coalesce(nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''), split_part(public.me_email(), '@', 1))
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.lab_members where email = public.me_email())
$$;
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.lab_members where email = public.me_email() and is_owner)
$$;
grant execute on function public.is_member(), public.is_owner() to anon, authenticated;

drop policy if exists "members see members" on public.lab_members;
create policy "members see members" on public.lab_members for select to authenticated using (public.is_member());
grant select on public.lab_members to authenticated;

-- ── Версії та варіації ───────────────────────────────────────────────────
-- kind = 'version'   — збережена версія (не видаляється автоматично);
-- kind = 'variation' — кожен запуск генератора; незакріплені (pinned = false) старіють і видаляються.
-- sets: {"normal": {"count": 5000}, "special": {"count": 331, "from": "<id іншого запису>"}} — набори без "from"
-- мають власні файли в бакеті levels: <id>/<set>.json.gz і <id>/<set>.stats.json.gz.

create table if not exists public.lab_entries (
  id          text primary key,
  kind        text not null default 'variation' check (kind in ('version', 'variation')),
  title       text not null,
  note        text not null default '',
  parent      text,
  sets        jsonb not null default '{}'::jsonb,
  gen_set     text,                       -- набір, який генерувався (для варіацій)
  gen_range   jsonb,                      -- {"from": 1, "to": 5000, "full": true}
  config      jsonb,                      -- конфіг генератора
  summary     jsonb,                      -- короткі метрики для списку
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  author      uuid,
  author_name text,
  updated_by_name text
);
create index if not exists lab_entries_kind_idx on public.lab_entries (kind, created_at desc);
alter table public.lab_entries enable row level security;

-- Автора і час ставить база — клієнт не може їх підробити
create or replace function public.lab_entries_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.author := auth.uid();
    new.author_name := public.me_name();
    new.created_at := now();
  else
    new.author := old.author;
    new.author_name := old.author_name;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  new.updated_by_name := public.me_name();
  return new;
end $$;
drop trigger if exists lab_entries_stamp on public.lab_entries;
create trigger lab_entries_stamp before insert or update on public.lab_entries
  for each row execute function public.lab_entries_stamp();

grant select on public.lab_entries to anon, authenticated;
grant insert, update, delete on public.lab_entries to authenticated;
drop policy if exists "entries are public" on public.lab_entries;
create policy "entries are public" on public.lab_entries for select using (true);
drop policy if exists "members add entries" on public.lab_entries;
create policy "members add entries" on public.lab_entries for insert to authenticated with check (public.is_member());
drop policy if exists "members edit entries" on public.lab_entries;
create policy "members edit entries" on public.lab_entries for update to authenticated using (public.is_member()) with check (public.is_member());
-- Видаляти: незакріплені варіації — будь-який редактор; версії й закріплене — автор або власник
drop policy if exists "members delete entries" on public.lab_entries;
create policy "members delete entries" on public.lab_entries for delete to authenticated using (
  public.is_member() and ((kind = 'variation' and not pinned) or author = auth.uid() or public.is_owner())
);

-- ── Налаштування (змінює власник) ────────────────────────────────────────

create table if not exists public.lab_settings (
  key   text primary key,
  value jsonb not null
);
alter table public.lab_settings enable row level security;
grant select on public.lab_settings to anon, authenticated;
grant insert, update on public.lab_settings to authenticated;
drop policy if exists "settings are public" on public.lab_settings;
create policy "settings are public" on public.lab_settings for select using (true);
drop policy if exists "owner edits settings" on public.lab_settings;
create policy "owner edits settings" on public.lab_settings for all to authenticated using (public.is_owner()) with check (public.is_owner());
insert into public.lab_settings (key, value) values ('variation_keep_days', '14') on conflict do nothing;

-- Незакріплені варіації, старші за variation_keep_days (сайт видаляє їхні файли й записи)
create or replace function public.lab_expired() returns setof public.lab_entries
language sql stable security definer set search_path = public as $$
  select e.* from public.lab_entries e
   where e.kind = 'variation' and not e.pinned
     and e.created_at < now() - make_interval(days => coalesce((select (value #>> '{}')::int from public.lab_settings where key = 'variation_keep_days'), 14))
   order by e.created_at
   limit 200
$$;
grant execute on function public.lab_expired() to authenticated;

-- ── Файли рівнів ─────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit)
values ('levels', 'levels', true, 52428800)
on conflict (id) do update set public = true;

drop policy if exists "levels are public" on storage.objects;
create policy "levels are public" on storage.objects for select using (bucket_id = 'levels');
drop policy if exists "members upload levels" on storage.objects;
create policy "members upload levels" on storage.objects for insert to authenticated with check (bucket_id = 'levels' and public.is_member());
drop policy if exists "members update levels" on storage.objects;
create policy "members update levels" on storage.objects for update to authenticated using (bucket_id = 'levels' and public.is_member());
drop policy if exists "members delete levels" on storage.objects;
create policy "members delete levels" on storage.objects for delete to authenticated using (bucket_id = 'levels' and public.is_member());

-- ── Запити на доступ і підтвердження власником ───────────────────────────
-- Людина на сайті натискає «Запросити доступ» (email + ім'я). Власник бачить запит, натискає «Підтвердити» —
-- сайт генерує пароль, база створює акаунт і додає людину в редактори. У базі лише bcrypt-хеш пароля.

create table if not exists public.access_requests (
  id         bigint generated always as identity primary key,
  email      text not null,
  name       text,
  note       text,
  created_at timestamptz not null default now(),
  status     text not null default 'pending'      -- pending | approved | rejected
);
create unique index if not exists access_requests_pending_idx on public.access_requests (email) where status = 'pending';
alter table public.access_requests enable row level security;
grant select on public.access_requests to authenticated;
drop policy if exists "owner sees requests" on public.access_requests;
create policy "owner sees requests" on public.access_requests for select to authenticated using (public.is_owner());

create or replace function public.request_access(p_email text, p_name text, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(coalesce(p_email, '')));
begin
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(e) > 120 then return 'bad_email'; end if;
  if exists (select 1 from public.lab_members where email = e) then return 'member'; end if;
  if (select count(*) from public.access_requests where status = 'pending') >= 30 then return 'full'; end if;
  insert into public.access_requests (email, name, note)
  values (e, left(trim(coalesce(p_name, '')), 40), left(trim(coalesce(p_note, '')), 300))
  on conflict (email) where status = 'pending'
  do update set name = excluded.name, note = excluded.note, created_at = now();
  return 'ok';
end $$;
revoke all on function public.request_access(text, text, text) from public;
grant execute on function public.request_access(text, text, text) to anon, authenticated;

create or replace function public.owner_grant(p_email text, p_name text, p_password text) returns void
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  e   text := lower(trim(coalesce(p_email, '')));
  nm  text := nullif(left(trim(coalesce(p_name, '')), 40), '');
  uid uuid;
begin
  if not public.is_owner() then raise exception 'Лише власник може видавати доступ'; end if;
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Неправильний email'; end if;
  if length(coalesce(p_password, '')) < 10 then raise exception 'Пароль закороткий'; end if;

  select id into uid from auth.users where lower(email) = e;
  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', e,
            crypt(p_password, gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('name', coalesce(nm, split_part(e, '@', 1))),
            now(), now(), '', '', '', '');
    insert into auth.identities (user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (uid, uid::text, jsonb_build_object('sub', uid::text, 'email', e, 'email_verified', true), 'email', now(), now(), now());
  else
    update auth.users
       set encrypted_password = crypt(p_password, gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           raw_user_meta_data = case when nm is not null and coalesce(raw_user_meta_data ->> 'name', '') = ''
                                     then coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('name', nm)
                                     else raw_user_meta_data end,
           updated_at = now()
     where id = uid;
  end if;

  insert into public.lab_members (email) values (e) on conflict do nothing;
  update public.access_requests set status = 'approved' where email = e and status = 'pending';
end $$;
revoke all on function public.owner_grant(text, text, text) from public, anon;
grant execute on function public.owner_grant(text, text, text) to authenticated;

create or replace function public.owner_reject(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Лише власник'; end if;
  update public.access_requests set status = 'rejected' where id = p_id and status = 'pending';
end $$;
revoke all on function public.owner_reject(bigint) from public, anon;
grant execute on function public.owner_reject(bigint) to authenticated;

create or replace function public.owner_members()
returns table (email text, name text, is_owner boolean, joined boolean, last_sign_in timestamptz)
language sql stable security definer set search_path = public, auth as $$
  select m.email, coalesce(nullif(u.raw_user_meta_data ->> 'name', ''), split_part(m.email, '@', 1)),
         m.is_owner, u.id is not null, u.last_sign_in_at
    from public.lab_members m
    left join auth.users u on lower(u.email) = m.email
   where public.is_owner()
   order by m.is_owner desc, 2;
$$;
revoke all on function public.owner_members() from public, anon;
grant execute on function public.owner_members() to authenticated;

create or replace function public.owner_remove(p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Лише власник'; end if;
  delete from public.lab_members where email = lower(trim(p_email)) and not is_owner;
end $$;
revoke all on function public.owner_remove(text) from public, anon;
grant execute on function public.owner_remove(text) to authenticated;

-- Живі оновлення списку версій і запитів
do $$
begin
  begin alter publication supabase_realtime add table public.lab_entries; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.access_requests; exception when duplicate_object then null; end;
end $$;

-- ── Власник ──────────────────────────────────────────────────────────────
-- Впишіть СВІЙ email замість owner@example.com. Решту людей ви додаєте на сайті: «Увійти» → профіль → «Доступ».
insert into public.lab_members (email, is_owner) values
  (lower('owner@example.com'), true)
on conflict (email) do update set is_owner = true;
