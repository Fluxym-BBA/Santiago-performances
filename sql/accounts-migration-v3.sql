-- ============================================================================
--  BDR COCKPIT — Migration 3 : suppression de compte sans dégât
--  Usage : Supabase → SQL Editor → coller → Run. Idempotente, rejouable.
--  Prérequis : multi-user-migration.sql puis roles-migration-v2.sql.
--
--  POURQUOI CETTE MIGRATION
--  ------------------------
--  Supprimer un compte devient possible depuis l'application (lot 2). Deux
--  problèmes se posaient, tous deux invisibles jusqu'au jour où l'on supprime
--  vraiment quelqu'un :
--
--  1. daily_activity.created_by et updated_by pointent vers auth.users SANS
--     règle de cascade. Dès qu'un administrateur a corrigé la saisie de
--     quelqu'un, son identifiant est inscrit dans ces colonnes. Le supprimer
--     échouerait alors sur une violation de clé étrangère, avec un message
--     parfaitement incompréhensible pour qui n'a pas le schéma en tête.
--     Ces colonnes disent QUI a saisi, ce n'est pas une donnée vitale :
--     « mettre à null » est le bon comportement, et surtout pas la cascade,
--     qui supprimerait la saisie d'un BDR parce qu'un administrateur parti a
--     corrigé une virgule.
--
--  2. Rien n'empêchait de supprimer le dernier administrateur. L'Edge Function
--     le refuse, mais une suppression lancée depuis le tableau de bord
--     Supabase ne passe pas par elle. La vraie barrière doit être dans la base.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) LES DEUX CLÉS ÉTRANGÈRES DE TRAÇABILITÉ PASSENT EN « SET NULL »
--    On retrouve le nom réel de la contrainte plutôt que de le supposer :
--    PostgreSQL le génère, et il diffère selon l'ordre historique des
--    migrations.
-- ----------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select con.conname, att.attname
    from pg_constraint con
    join pg_class    rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    join unnest(con.conkey) as k(attnum) on true
    join pg_attribute att on att.attrelid = rel.oid and att.attnum = k.attnum
    where ns.nspname = 'public'
      and rel.relname = 'daily_activity'
      and con.contype = 'f'
      and att.attname in ('created_by', 'updated_by')
  loop
    execute format('alter table public.daily_activity drop constraint %I', c.conname);
    raise notice 'Contrainte % supprimée (colonne %)', c.conname, c.attname;
  end loop;
end $$;

alter table public.daily_activity
  add constraint daily_activity_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

alter table public.daily_activity
  add constraint daily_activity_updated_by_fkey
  foreign key (updated_by) references auth.users (id) on delete set null;

comment on column public.daily_activity.created_by is
  'Auteur de la première saisie. Mis à null si le compte est supprimé : la donnée d''activité survit à son auteur.';
comment on column public.daily_activity.updated_by is
  'Auteur de la dernière modification. Mis à null si le compte est supprimé.';


-- ----------------------------------------------------------------------------
-- 2) LE DERNIER ADMINISTRATEUR ACTIF EST INSUPPRIMABLE
--    Le déclencheur est posé sur profiles et non sur auth.users : la
--    suppression d'un utilisateur cascade vers profiles, la suppression de la
--    ligne de profil déclenche donc ce contrôle, et l'exception annule toute
--    la transaction. La protection vaut aussi bien pour l'application que pour
--    une suppression manuelle depuis le tableau de bord Supabase.
-- ----------------------------------------------------------------------------
create or replace function public.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  admins_left integer;
begin
  if old.is_admin and old.is_active then
    select count(*) into admins_left
    from public.profiles
    where is_admin and is_active and user_id <> old.user_id;

    if admins_left = 0 then
      raise exception
        'Impossible de supprimer % : dernier administrateur actif. Nommez un autre administrateur d''abord.',
        coalesce(old.email, old.user_id::text);
    end if;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_guard_last_admin on public.profiles;
create trigger trg_guard_last_admin
  before delete on public.profiles
  for each row execute function public.guard_last_admin();


-- ----------------------------------------------------------------------------
-- 3) CE QUE COÛTERAIT UNE SUPPRESSION, AVANT DE LA FAIRE
--    L'application affiche ce chiffre dans la confirmation. Une fonction
--    dédiée évite de faire confiance à un décompte calculé côté navigateur,
--    et reste utilisable seule dans l'éditeur SQL.
-- ----------------------------------------------------------------------------
create or replace function public.admin_delete_preview(p_user_id uuid)
returns table (
  email          text,
  display_name   text,
  is_admin       boolean,
  is_bdr         boolean,
  days_recorded  bigint,
  first_day      date,
  last_day       date,
  is_last_admin  boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.email,
    p.display_name,
    p.is_admin,
    p.is_bdr,
    (select count(*) from public.daily_activity d where d.user_id = p.user_id),
    (select min(d.activity_date) from public.daily_activity d where d.user_id = p.user_id),
    (select max(d.activity_date) from public.daily_activity d where d.user_id = p.user_id),
    p.is_admin and p.is_active and not exists (
      select 1 from public.profiles q
      where q.is_admin and q.is_active and q.user_id <> p.user_id
    )
  from public.profiles p
  where p.user_id = p_user_id
    and public.is_admin();   -- un non-administrateur n'obtient aucune ligne
$$;

revoke all on function public.admin_delete_preview(uuid) from public, anon;
grant execute on function public.admin_delete_preview(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 4) VÉRIFICATION — à lire dans le panneau de résultats
--    Les deux clés doivent afficher « SET NULL », et le déclencheur être
--    présent. Si l'une des deux affiche « NO ACTION », la migration n'a pas
--    été rejouée : la suppression d'un administrateur ayant corrigé une
--    saisie échouerait.
-- ----------------------------------------------------------------------------
select
  con.conname                                as contrainte,
  case con.confdeltype
    when 'a' then 'NO ACTION  ← à corriger'
    when 'n' then 'SET NULL   ← correct'
    when 'c' then 'CASCADE    ← dangereux ici'
    else con.confdeltype::text
  end                                        as a_la_suppression
from pg_constraint con
join pg_class     rel on rel.oid = con.conrelid
join pg_namespace ns  on ns.oid  = rel.relnamespace
where ns.nspname = 'public' and rel.relname = 'daily_activity' and con.contype = 'f'
union all
select
  'trg_guard_last_admin',
  case when exists (
    select 1 from pg_trigger where tgname = 'trg_guard_last_admin' and not tgisinternal
  ) then 'installé   ← correct' else 'ABSENT     ← à corriger' end
order by 1;
