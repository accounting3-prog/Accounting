-- Managing who may write.
--
-- Everyone who signs in can already read the whole ledger; that is the default
-- and needs no grant. This migration is only about the smaller set who may
-- change it.
--
-- Granting and revoking go through admin-only functions rather than direct
-- writes to `admins`, so every change to who can move money is recorded with
-- who did it and why, in a table that can be read and appended to but never
-- edited or emptied.
--
-- Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- Immutable record of access changes
-- ---------------------------------------------------------------------------

create table if not exists admin_audit (
    id                 uuid primary key default gen_random_uuid(),
    action             text not null check (action in ('granted', 'revoked')),
    target_user_id     uuid,
    target_email       text not null,
    performed_by       uuid references auth.users(id),
    performed_by_email text,
    rationale          text,
    created_at         timestamptz not null default now()
);

create index if not exists admin_audit_created on admin_audit (created_at desc);

alter table admin_audit enable row level security;
drop policy if exists admin_audit_read on admin_audit;
create policy admin_audit_read on admin_audit
    for select to authenticated using (true);
-- Append-only, and only by an admin. Deliberately no update or delete policy:
-- the record of who was given the ability to move money must not be editable
-- by the people it holds to account.
drop policy if exists admin_audit_insert on admin_audit;
create policy admin_audit_insert on admin_audit
    for insert to authenticated with check (is_admin());

-- ---------------------------------------------------------------------------
-- Who has signed in
-- ---------------------------------------------------------------------------
--
-- auth.users is not readable through the API, and should not be. This function
-- exposes only what the access screen needs — address, when they joined, when
-- they were last seen — and only to an admin.

create or replace function list_app_users()
returns table (
    user_id       uuid,
    email         text,
    is_admin      boolean,
    created_at    timestamptz,
    last_sign_in  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not is_admin() then
        raise exception 'Only a named admin may list users' using errcode = '42501';
    end if;
    return query
        select u.id,
               u.email::text,
               exists (select 1 from admins a where a.user_id = u.id),
               u.created_at,
               u.last_sign_in_at
          from auth.users u
         order by u.created_at;
end;
$$;

revoke all on function list_app_users from public, anon;
grant execute on function list_app_users to authenticated;

-- ---------------------------------------------------------------------------
-- Granting write access
-- ---------------------------------------------------------------------------

create or replace function grant_admin(p_email text, p_rationale text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid;
    v_email   text := lower(btrim(p_email));
    v_by      text;
begin
    if not is_admin() then
        raise exception 'Only a named admin may grant access' using errcode = '42501';
    end if;
    if v_email = '' then
        raise exception 'An email address is required';
    end if;

    select id into v_user_id from auth.users where lower(email) = v_email;
    if v_user_id is null then
        -- Access is granted to a real account, never to an address that might
        -- one day be claimed by someone else.
        raise exception
            'No account has signed in with %. Ask them to sign in once, then grant access.',
            v_email;
    end if;

    if exists (select 1 from admins where user_id = v_user_id) then
        raise exception '% already has write access', v_email;
    end if;

    insert into admins (user_id, email, added_by) values (v_user_id, v_email, auth.uid());

    select email into v_by from admins where user_id = auth.uid();
    insert into admin_audit (action, target_user_id, target_email, performed_by,
                             performed_by_email, rationale)
    values ('granted', v_user_id, v_email, auth.uid(), v_by, nullif(btrim(p_rationale), ''));

    return v_user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Revoking write access
-- ---------------------------------------------------------------------------

create or replace function revoke_admin(p_user_id uuid, p_rationale text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_email text;
    v_by    text;
    v_count integer;
begin
    if not is_admin() then
        raise exception 'Only a named admin may revoke access' using errcode = '42501';
    end if;

    select email into v_email from admins where user_id = p_user_id;
    if v_email is null then
        raise exception 'That account does not have write access';
    end if;

    -- Removing the last admin would leave nobody able to add a transaction, or
    -- to restore anyone's access. The lockout is silent until someone tries to
    -- write, so it is refused here instead.
    select count(*) into v_count from admins;
    if v_count <= 1 then
        raise exception
            'This is the only account with write access. Grant it to someone else first.';
    end if;

    delete from admins where user_id = p_user_id;

    select email into v_by from admins where user_id = auth.uid();
    insert into admin_audit (action, target_user_id, target_email, performed_by,
                             performed_by_email, rationale)
    values ('revoked', p_user_id, v_email, auth.uid(), v_by, nullif(btrim(p_rationale), ''));

    return p_user_id;
end;
$$;

revoke all on function grant_admin  from public, anon;
revoke all on function revoke_admin from public, anon;
grant execute on function grant_admin  to authenticated;
grant execute on function revoke_admin to authenticated;

comment on function grant_admin is
    'Gives an existing signed-in account write access. Admin-only, and recorded '
    'in admin_audit.';
comment on function revoke_admin is
    'Removes write access. Admin-only, refuses to remove the last admin, and is '
    'recorded in admin_audit.';

commit;
