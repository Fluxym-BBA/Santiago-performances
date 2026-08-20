-- ============================================================================
--  BDR COCKPIT — Migration multi-utilisateurs
--  Usage : Supabase → SQL Editor → coller → Run. Idempotent, rejouable.
--
--  Ce script n'efface aucune donnée existante.
--
--  CE QU'IL FAUT COMPRENDRE AVANT DE LIRE LE RESTE
--  -----------------------------------------------
--  Il n'y a pas une base par utilisateur, et il ne faut pas en créer une.
--  L'isolation est déjà assurée par la Row Level Security de PostgreSQL, qui
--  est exactement le mécanisme conçu pour cela : une seule table, une seule
--  migration, et chaque ligne n'est visible que de son propriétaire. Vingt-deux
--  bases voudraient dire vingt-deux projets Supabase, vingt-deux jeux de clés,
--  vingt-deux migrations à rejouer à chaque évolution, et aucune requête
--  possible entre deux utilisateurs, donc aucune vue d'équipe.
--
--  Ce que ce script ajoute :
--    1. une table de profils, avec un rôle (admin ou bdr) et un marqueur
--       « compte de démonstration » ;
--    2. la création automatique du profil à l'ouverture d'un compte ;
--    3. une fonction is_admin() sûre, qui ne provoque pas de récursion RLS ;
--    4. des règles d'accès élargies : un admin lit et corrige tout le monde,
--       un BDR ne voit que lui ;
--    5. la traçabilité : qui a saisi, qui a corrigé, et quand ;
--    6. une vue d'équipe et des fonctions d'administration.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) PROFILS
--    Le rôle est stocké ici, et surtout PAS dans user_metadata : cette partie
--    du JWT est modifiable par l'utilisateur lui-même via auth.updateUser(),
--    n'importe qui pourrait donc se déclarer admin. app_metadata serait sûr
--    mais n'est modifiable qu'avec la clé service_role, que l'on ne peut pas
--    mettre dans un dépôt public. Une table plus la RLS reste la bonne réponse.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text        not null default '',
  role         text        not null default 'bdr' check (role in ('admin','bdr')),
  is_demo      boolean     not null default false,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table  public.profiles is 'Un profil par compte : nom affiché, rôle, compte de démonstration, actif ou non';
comment on column public.profiles.is_demo   is 'Compte de démonstration : ses chiffres sont exclus des vues d''équipe par défaut';
comment on column public.profiles.is_active is 'Un compte inactif reste visible en historique mais sort des classements';

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 2) CRÉATION AUTOMATIQUE DU PROFIL
--    Le profil naît avec le compte. Créer un utilisateur dans Supabase suffit
--    donc, il n'y a jamais de deuxième geste à faire.
--    Le nom affiché part de raw_user_meta_data.display_name si le champ a été
--    renseigné à la création, sinon de la partie gauche de l'e-mail.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
      initcap(replace(split_part(new.email, '@', 1), '.', ' '))
    )
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- L'e-mail reste synchronisé s'il est modifié dans Supabase.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.profiles set email = new.email where user_id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- Rattrapage pour les comptes déjà créés avant cette migration.
insert into public.profiles (user_id, email, display_name)
select u.id, u.email,
       initcap(replace(split_part(u.email, '@', 1), '.', ' '))
from auth.users u
on conflict (user_id) do nothing;


-- ----------------------------------------------------------------------------
-- 3) is_admin() — LE POINT DÉLICAT
--    Une règle RLS posée sur profiles qui interrogerait profiles provoquerait
--    une récursion infinie, et PostgreSQL renverrait l'erreur 42P17. La
--    fonction est donc en SECURITY DEFINER : elle s'exécute avec les droits de
--    son propriétaire, contourne la RLS, et coupe la récursion.
--    search_path est figé, sans quoi un schéma pirate pourrait détourner la
--    résolution des noms de tables.
-- ----------------------------------------------------------------------------
create or replace function public.is_admin(p_uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where user_id = p_uid and role = 'admin' and is_active
  );
$$;

revoke all on function public.is_admin(uuid) from public, anon;
grant execute on function public.is_admin(uuid) to authenticated;

-- Nom affiché d'un utilisateur, utilisable dans les messages du front.
create or replace function public.display_name_of(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(nullif(display_name, ''), email, 'Utilisateur') from public.profiles where user_id = p_uid;
$$;
grant execute on function public.display_name_of(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 4) RLS SUR LES PROFILS
--    Lecture : soi-même, ou tout le monde si l'on est admin.
--    Écriture : seul le nom affiché est modifiable en direct, et seulement le
--    sien. Le rôle, l'activation et le marqueur de démonstration passent
--    obligatoirement par les fonctions de la section 8, qui vérifient les
--    droits et protègent le dernier administrateur.
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "profiles_update_own_name" on public.profiles;
create policy "profiles_update_own_name" on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Le GRANT limité aux colonnes est ce qui empêche réellement un BDR de se
-- promouvoir admin : la règle ci-dessus l'autorise à modifier SA ligne, le
-- GRANT décide quelles colonnes il peut toucher.
revoke all on public.profiles from authenticated, anon;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;


-- ----------------------------------------------------------------------------
-- 5) TRAÇABILITÉ DES SAISIES
--    Puisqu'un admin peut corriger la journée d'un autre, il faut pouvoir dire
--    qui a écrit. Sans cela, une correction devient indiscernable d'une saisie,
--    et le chiffre n'est plus défendable en réunion.
-- ----------------------------------------------------------------------------
alter table public.daily_activity add column if not exists created_by uuid references auth.users (id);
alter table public.daily_activity add column if not exists updated_by uuid references auth.users (id);

comment on column public.daily_activity.updated_by is 'Auteur de la dernière écriture : le BDR lui-même, ou l''admin qui a corrigé';

create or replace function public.stamp_author()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  if (tg_op = 'INSERT') then
    new.created_by = coalesce(new.created_by, auth.uid());
  end if;
  return new;
end;
$$;

-- Remplace le trigger updated_at sur cette table : il fait le même travail,
-- plus l'auteur.
drop trigger if exists trg_daily_activity_updated_at on public.daily_activity;
drop trigger if exists trg_daily_activity_author on public.daily_activity;
create trigger trg_daily_activity_author
  before insert or update on public.daily_activity
  for each row execute function public.stamp_author();


-- ----------------------------------------------------------------------------
-- 6) RLS SUR LES DONNÉES
--    Un BDR ne voit et ne modifie que ses lignes, exactement comme avant.
--    Un admin lit tout et peut corriger. La suppression reste volontairement
--    réservée au propriétaire de la ligne et à l'admin.
-- ----------------------------------------------------------------------------
-- Les anciens noms comme les nouveaux sont retirés : le script reste rejouable
-- autant de fois que nécessaire sans jamais échouer sur un doublon.
drop policy if exists "activity_select_own" on public.daily_activity;
drop policy if exists "activity_insert_own" on public.daily_activity;
drop policy if exists "activity_update_own" on public.daily_activity;
drop policy if exists "activity_delete_own" on public.daily_activity;
drop policy if exists "activity_select" on public.daily_activity;
drop policy if exists "activity_insert" on public.daily_activity;
drop policy if exists "activity_update" on public.daily_activity;
drop policy if exists "activity_delete" on public.daily_activity;

create policy "activity_select" on public.daily_activity
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "activity_insert" on public.daily_activity
  for insert to authenticated
  with check (user_id = auth.uid() or public.is_admin());

create policy "activity_update" on public.daily_activity
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy "activity_delete" on public.daily_activity
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "targets_all_own" on public.daily_targets;
drop policy if exists "targets_select"  on public.daily_targets;
drop policy if exists "targets_write"   on public.daily_targets;
create policy "targets_select" on public.daily_targets
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "targets_write" on public.daily_targets
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());


-- ----------------------------------------------------------------------------
-- 7) VUES
--    v_daily_kpi gagne l'auteur de la dernière écriture et un indicateur de
--    correction. v_best_day en dépend par un select *, elle est donc supprimée
--    puis recréée : ajouter une colonne à une vue dont une autre vue a figé la
--    liste de colonnes est le genre de détail qui fait échouer une migration.
-- ----------------------------------------------------------------------------
drop view if exists public.v_team_daily;
drop view if exists public.v_best_day;

create or replace view public.v_daily_kpi
with (security_invoker = true) as
select
  d.id,
  d.user_id,
  d.activity_date,
  d.companies_created,
  d.contacts_created,
  d.calls_made,
  d.calls_connected,
  d.meetings_booked,
  d.emails_sent,
  d.notes,
  case when d.calls_made > 0
       then round(100.0 * d.calls_connected / d.calls_made, 1) end as connect_rate,
  case when d.calls_connected > 0
       then round(100.0 * d.meetings_booked / d.calls_connected, 1) end as meeting_rate,
  case when d.meetings_booked > 0
       then round(1.0 * d.calls_made / d.meetings_booked, 1) end as calls_per_meeting,
  d.calls_made + d.emails_sent + d.companies_created + d.contacts_created as total_actions,
  (d.calls_made        * 1
 + d.calls_connected   * 3
 + d.meetings_booked   * 20
 + d.emails_sent       * 1
 + d.companies_created * 2
 + d.contacts_created  * 2) as productivity_score,
  d.updated_at,
  d.updated_by,
  d.created_by,
  -- Vrai quand la dernière écriture vient de quelqu'un d'autre que le
  -- propriétaire de la ligne : la journée a été corrigée par un admin.
  (d.updated_by is not null and d.updated_by <> d.user_id) as is_correction
from public.daily_activity d;

create view public.v_best_day
with (security_invoker = true) as
select distinct on (user_id) *
from public.v_daily_kpi
order by user_id, productivity_score desc, activity_date desc;

grant select on public.v_daily_kpi, public.v_best_day to authenticated;


-- ----------------------------------------------------------------------------
-- 7 bis) VUE D'ÉQUIPE
--    security_invoker = true est indispensable : sans lui, une vue s'exécute
--    avec les droits de son propriétaire et court-circuite la RLS, ce qui
--    exposerait les données de tout le monde à tout le monde.
-- ----------------------------------------------------------------------------
create view public.v_team_daily
with (security_invoker = true) as
select
  k.*,
  p.display_name,
  p.email,
  p.role,
  p.is_demo,
  p.is_active
from public.v_daily_kpi k
join public.profiles p on p.user_id = k.user_id;

comment on view public.v_team_daily is 'Activité quotidienne enrichie du profil. Filtrée par la RLS : un BDR n''y voit que ses lignes.';

grant select on public.v_team_daily to authenticated;

-- Le meilleur jour reste calculé par utilisateur : la vue existante convient,
-- il suffit de la filtrer sur l'utilisateur consulté depuis le front.


-- ----------------------------------------------------------------------------
-- 8) INCRÉMENT ATOMIQUE, VERSION MULTI-UTILISATEURS
--    p_user_id absent ou nul = pour soi. Renseigné et différent de soi = il
--    faut être admin, sinon la fonction refuse.
-- ----------------------------------------------------------------------------
create or replace function public.bump_metric(
  p_metric  text,
  p_delta   integer default 1,
  p_date    date    default current_date,
  p_user_id uuid    default null
)
returns public.daily_activity
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r      public.daily_activity;
  target uuid := coalesce(p_user_id, auth.uid());
begin
  if p_metric not in ('companies_created','contacts_created','calls_made',
                      'calls_connected','meetings_booked','emails_sent') then
    raise exception 'Métrique non autorisée : %', p_metric;
  end if;

  if target is distinct from auth.uid() and not public.is_admin() then
    raise exception 'Saisie pour un autre utilisateur réservée aux administrateurs';
  end if;

  insert into public.daily_activity (user_id, activity_date)
  values (target, p_date)
  on conflict (user_id, activity_date) do nothing;

  execute format(
    'update public.daily_activity
        set %1$I = greatest(0, %1$I + $1)
      where user_id = $2 and activity_date = $3
      returning *', p_metric)
  into r
  using p_delta, target, p_date;

  return r;
end;
$$;

-- L'ancienne signature à trois arguments est supprimée pour éviter toute
-- ambiguïté de surcharge côté PostgREST.
drop function if exists public.bump_metric(text, integer, date);

revoke all on function public.bump_metric(text, integer, date, uuid) from public, anon;
grant execute on function public.bump_metric(text, integer, date, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 9) FONCTIONS D'ADMINISTRATION
--    Elles remplacent des règles RLS d'écriture sur profiles, ce qui permet de
--    valider les cas dangereux au même endroit : on ne se retire pas le dernier
--    rôle admin, on ne désactive pas le dernier admin actif.
-- ----------------------------------------------------------------------------
create or replace function public.admin_update_profile(
  p_user_id      uuid,
  p_display_name text    default null,
  p_role         text    default null,
  p_is_demo      boolean default null,
  p_is_active    boolean default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.profiles;
  admins_left integer;
begin
  if not public.is_admin() then
    raise exception 'Action réservée aux administrateurs';
  end if;
  if p_role is not null and p_role not in ('admin','bdr') then
    raise exception 'Rôle inconnu : %', p_role;
  end if;

  -- Protection du dernier administrateur actif : sans elle, une fausse
  -- manoeuvre rendrait l'administration définitivement inaccessible et il
  -- faudrait repasser par l'éditeur SQL de Supabase.
  if (p_role = 'bdr' or p_is_active = false) then
    select count(*) into admins_left
    from public.profiles
    where role = 'admin' and is_active and user_id <> p_user_id;
    if admins_left = 0 then
      raise exception 'Impossible : ce compte est le dernier administrateur actif';
    end if;
  end if;

  update public.profiles set
    display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
    role         = coalesce(p_role,      role),
    is_demo      = coalesce(p_is_demo,   is_demo),
    is_active    = coalesce(p_is_active, is_active)
  where user_id = p_user_id
  returning * into r;

  if r is null then
    raise exception 'Utilisateur introuvable';
  end if;
  return r;
end;
$$;

revoke all on function public.admin_update_profile(uuid, text, text, boolean, boolean) from public, anon;
grant execute on function public.admin_update_profile(uuid, text, text, boolean, boolean) to authenticated;

-- Effacement des données d'un compte, sans toucher au compte lui-même.
-- Sert à vider le compte de démonstration, ou à repartir de zéro sur un BDR.
create or replace function public.admin_wipe_activity(
  p_user_id uuid,
  p_from    date default null,
  p_to      date default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if not public.is_admin() then
    raise exception 'Action réservée aux administrateurs';
  end if;

  delete from public.daily_activity
  where user_id = p_user_id
    and (p_from is null or activity_date >= p_from)
    and (p_to   is null or activity_date <= p_to);

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.admin_wipe_activity(uuid, date, date) from public, anon;
grant execute on function public.admin_wipe_activity(uuid, date, date) to authenticated;


-- ----------------------------------------------------------------------------
-- 10) LE PREMIER ADMINISTRATEUR
--     Personne n'est admin par défaut, et aucune fonction ne peut créer le
--     premier admin puisqu'elles exigent déjà de l'être. Cette ligne est donc
--     à exécuter une fois, ici, avec l'adresse voulue.
-- ----------------------------------------------------------------------------
update public.profiles
   set role = 'admin', display_name = coalesce(nullif(display_name,''), 'Bruno Bartoli')
 where lower(email) = lower('bbartoli@fluxym.com');

-- Vérification finale : à lire dans le panneau de résultats.
select p.display_name, p.email, p.role, p.is_demo, p.is_active,
       (select count(*) from public.daily_activity d where d.user_id = p.user_id) as jours_saisis
from public.profiles p
order by p.role, p.display_name;
