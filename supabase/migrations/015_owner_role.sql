-- Three levels instead of two.
--
-- Until now an account either could write or could not, and everything that
-- came with writing came together: adding a transaction, granting someone else
-- access, and reading the record of who did what. That is one permission doing
-- three jobs, and it forces a choice between "this person cannot do their work"
-- and "this person can hand out access and audit their own colleagues".
--
--   viewer   signs in, reads the ledger. Unchanged.
--   editor   does the work: adds, edits, imports, resolves, adds cards. Cannot
--            see who has access, cannot grant or revoke it, and cannot read
--            the history. Their own actions are still recorded in it.
--   owner    everything an editor can do, plus access and the history.
--
-- The history recording an editor's work while the editor cannot read it is the
-- point, not an oversight: an audit trail readable by the people it holds to
-- account is a weaker trail.
--
-- is_admin() keeps its meaning — may write — so every existing policy and every
-- function that guards on it is unchanged. What is new is is_owner(), and it
-- guards exactly three things: access management, the audit tables, and the
-- ability to make someone else an owner.
--
-- Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. The flag
-- ---------------------------------------------------------------------------

alter table admins add column if not exists is_owner boolean not null default false;

comment on column admins.is_owner is
    'An owner may manage access and read the history. An admin without it does '
    'every operational thing — add, edit, import, resolve, add cards — and '
    'neither sees who has access nor who changed what.';

-- The account that set the system up. Without this the first run of this
-- migration would leave nobody able to manage access at all.
update admins set is_owner = true
 where email = 'accounting3@events-explorers.com'
   and not is_owner;

-- A database that has admins but no owner is locked out of its own access
-- management. If the address above is not present, the earliest admin takes it.
update admins set is_owner = true
 where user_id = (select user_id from admins order by created_at limit 1)
   and not exists (select 1 from admins where is_owner);

-- 'granted_owner' is a new kind of entry and the constraint has to allow it,
-- or the first attempt to make someone an owner fails on a check violation.
alter table admin_audit drop constraint if exists admin_audit_action_check;
alter table admin_audit add constraint admin_audit_action_check
    check (action in ('granted', 'granted_owner', 'revoked'));

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from admins where user_id = auth.uid() and is_owner);
$$;

revoke all on function is_owner from public, anon;
grant execute on function is_owner to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The audit tables become the owner's
-- ---------------------------------------------------------------------------

drop policy if exists transaction_corrections_read on transaction_corrections;
create policy transaction_corrections_read on transaction_corrections
    for select to authenticated using (is_owner());

drop policy if exists card_audit_read on card_audit;
create policy card_audit_read on card_audit
    for select to authenticated using (is_owner());

drop policy if exists admin_audit_read on admin_audit;
create policy admin_audit_read on admin_audit
    for select to authenticated using (is_owner());

-- The admins table itself said, to anyone signed in, who could write. An editor
-- has no need of the list and the owner asked that it not be visible; their own
-- row stays readable so the app can tell them what they are.
drop policy if exists admins_read on admins;
create policy admins_read on admins
    for select to authenticated using (is_owner() or user_id = auth.uid());

-- The write policy was `for all`, and a FOR ALL policy's USING clause applies
-- to SELECT as well. Policies are OR'd, so any admin passed it and read the
-- whole table — the narrowing above would have had no effect at all. Rewritten
-- as the three write commands, and narrowed to the owner while it is here:
-- membership is changed through grant_admin and revoke_admin, which are
-- security definer and do their own checking, so nothing needs direct write
-- access to this table.
drop policy if exists admins_write on admins;
drop policy if exists admins_insert on admins;
create policy admins_insert on admins
    for insert to authenticated with check (is_owner());
drop policy if exists admins_update on admins;
create policy admins_update on admins
    for update to authenticated using (is_owner()) with check (is_owner());
drop policy if exists admins_delete on admins;
create policy admins_delete on admins
    for delete to authenticated using (is_owner());

-- ---------------------------------------------------------------------------
-- 3. Access management becomes the owner's
-- ---------------------------------------------------------------------------

-- A returns-table function cannot gain a column through create or replace.
drop function if exists list_app_users();

create or replace function list_app_users()
returns table (
    user_id       uuid,
    email         text,
    is_admin      boolean,
    is_owner      boolean,
    created_at    timestamptz,
    last_sign_in  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not is_owner() then
        raise exception 'Only the owner may list accounts' using errcode = '42501';
    end if;
    return query
        select u.id,
               u.email::text,
               exists (select 1 from admins a where a.user_id = u.id),
               exists (select 1 from admins a where a.user_id = u.id and a.is_owner),
               u.created_at,
               u.last_sign_in_at
          from auth.users u
         order by u.created_at;
end;
$$;

revoke all on function list_app_users from public, anon;
grant execute on function list_app_users to authenticated;

-- grant_admin gains the ability to create another owner, and both it and
-- revoke_admin now require one.
drop function if exists grant_admin(text, text);

create or replace function grant_admin(
    p_email text,
    p_rationale text default null,
    p_as_owner boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id    uuid;
    v_by    text;
begin
    if not is_owner() then
        raise exception 'Only the owner may give access' using errcode = '42501';
    end if;
    if coalesce(btrim(p_email), '') = '' then
        raise exception 'An email address is required';
    end if;

    select id into v_id from auth.users where lower(email) = lower(btrim(p_email));
    if v_id is null then
        raise exception
            'No account has signed in with %. They must sign in once before they can be given access.',
            btrim(p_email);
    end if;

    select email into v_by from admins where user_id = auth.uid();

    insert into admins (user_id, email, added_by, is_owner)
    values (v_id, lower(btrim(p_email)), auth.uid(), coalesce(p_as_owner, false))
    on conflict (user_id) do update set is_owner = excluded.is_owner;

    insert into admin_audit (action, target_email, performed_by, performed_by_email, rationale)
    values (case when coalesce(p_as_owner, false) then 'granted_owner' else 'granted' end,
            lower(btrim(p_email)), auth.uid(), v_by,
            coalesce(nullif(btrim(p_rationale), ''),
                     'Write access given' || case when coalesce(p_as_owner, false)
                                                  then ', including access management' else '' end));
    return v_id;
end;
$$;

revoke all on function grant_admin from public, anon;
grant execute on function grant_admin to authenticated;

create or replace function revoke_admin(p_user_id uuid, p_rationale text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_email text;
    v_by    text;
    v_was_owner boolean;
    v_owners integer;
begin
    if not is_owner() then
        raise exception 'Only the owner may take access away' using errcode = '42501';
    end if;

    select email, is_owner into v_email, v_was_owner from admins where user_id = p_user_id;
    if v_email is null then
        raise exception 'That account does not have write access';
    end if;

    -- Removing the last owner would leave nobody able to manage access or read
    -- the history, and nobody able to put it back. The lockout is silent until
    -- someone tries, so it is refused here instead.
    select count(*) into v_owners from admins where is_owner;
    if v_was_owner and v_owners <= 1 then
        raise exception
            'This is the only account that can manage access. Make someone else an owner first.';
    end if;

    delete from admins where user_id = p_user_id;

    select email into v_by from admins where user_id = auth.uid();
    insert into admin_audit (action, target_email, performed_by, performed_by_email, rationale)
    values ('revoked', v_email, auth.uid(), v_by,
            coalesce(nullif(btrim(p_rationale), ''), 'Write access removed'));
    return p_user_id;
end;
$$;

revoke all on function revoke_admin from public, anon;
grant execute on function revoke_admin to authenticated;

-- ---------------------------------------------------------------------------
-- 4. What the app asks about itself
-- ---------------------------------------------------------------------------

-- One round trip instead of three, and the only way the client learns what it
-- may do. Every restriction above is enforced in the database regardless of
-- what this returns; the answer only decides what is worth drawing.
create or replace function my_access()
returns table (can_write boolean, can_manage boolean, email text)
language sql stable security definer set search_path = public as $$
    select
        exists (select 1 from admins where user_id = auth.uid()),
        exists (select 1 from admins where user_id = auth.uid() and is_owner),
        (select a.email from admins a where a.user_id = auth.uid());
$$;

revoke all on function my_access from public, anon;
grant execute on function my_access to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The three accounts get their work back
-- ---------------------------------------------------------------------------

-- Revoked yesterday when "admin" still meant "can also manage access and read
-- the audit". As editors they can do everything operational and none of that.
insert into admins (user_id, email, is_owner)
select u.id, lower(u.email), false
  from auth.users u
 where lower(u.email) in (
        'accounting@events-explorers.com',
        'accounting5@luxuryexplorersme.com',
        'accounting6@luxuryexplorersme.com')
on conflict (user_id) do update set is_owner = false;

insert into admin_audit (action, target_email, performed_by_email, rationale)
select 'granted', lower(u.email), 'accounting3@events-explorers.com',
       'Restored as an editor: adds, edits, imports and resolves, but cannot see or manage access and cannot read the history.'
  from auth.users u
 where lower(u.email) in (
        'accounting@events-explorers.com',
        'accounting5@luxuryexplorersme.com',
        'accounting6@luxuryexplorersme.com')
   and not exists (
        select 1 from admin_audit aa
         where aa.target_email = lower(u.email)
           and aa.rationale like 'Restored as an editor%');

commit;
