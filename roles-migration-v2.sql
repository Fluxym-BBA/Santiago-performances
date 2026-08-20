-- ============================================================================
--  BDR COCKPIT — Migration 2 : des rôles à deux axes
--  Usage : Supabase → SQL Editor → coller → Run. Idempotent, rejouable.
--  Prérequis : multi-user-migration.sql a déjà été exécuté.
--
--  POURQUOI CETTE MIGRATION
--  ------------------------
--  Le modèle précédent n'avait qu'un axe : on était « admin » OU « bdr ». Un
--  administrateur était donc traité comme un commercial, apparaissait dans les
--  classements avec un score de zéro, et se voyait proposer une page de saisie
--  qui n'avait aucun sens pour lui.
--
--  Or ce sont deux questions distinctes :
--    1. cette personne administre-t-elle l'outil ?
--    2. cette personne prospecte-t-elle, et faut-il donc suivre son activité ?
--
--  D'où deux colonnes indépendantes, et quatre situations possibles :
--
--    is_admin  is_bdr   qui
--    --------  ------   ---------------------------------------------------
--    vrai      faux     administrateur pur : ni saisie, ni classement
--    vrai      vrai     manager qui prospecte aussi : accès à tout
--    faux      vrai     BDR : sa saisie et ses performances, rien d'autre
--    faux      faux     observateur : consulte l'équipe, n'administre rien
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) LES DEUX COLONNES
-- ----------------------------------------------------------------------------
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists is_bdr   boolean not null default true;

comment on column public.profiles.is_admin is 'Administre les comptes et consulte tous les utilisateurs';
comment on column public.profiles.is_bdr   is 'Saisit son activité et apparaît dans les classements. Faux pour un administrateur pur.';

-- Reprise depuis l'ancienne colonne role, si elle est encore là.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'role'
  ) then
    update public.profiles
       set is_admin = (role = 'admin'),
           is_bdr   = (role <> 'admin');
    raise notice 'Rôles repris depuis la colonne role.';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 2) is_admin() LIT DÉSORMAIS LA COLONNE
--    La fonction garde exactement le même nom et la même signature : toutes les
--    règles RLS écrites précédemment continuent de fonctionner sans être
--    touchées. C'est tout l'intérêt d'être passé par une fonction plutôt que
--    d'avoir écrit « role = 'admin' » dans chaque policy.
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
    where user_id = p_uid and is_admin and is_active
  );
$$;

/** Vrai si la personne fait de la prospection : sert à la construction des menus. */
create or replace function public.is_bdr(p_uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select is_bdr from public.profiles where user_id = p_uid), false);
$$;

grant execute on function public.is_admin(uuid) to authenticated;
grant execute on function public.is_bdr(uuid)   to authenticated;


-- ----------------------------------------------------------------------------
-- 3) CRÉATION DE COMPTE : BDR PAR DÉFAUT
--    Un nouveau compte est un commercial et n'est jamais administrateur : le
--    défaut le plus prudent est celui qui donne le moins de droits.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (user_id, email, display_name, is_admin, is_bdr)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
      initcap(replace(split_part(new.email, '@', 1), '.', ' '))
    ),
    false,
    coalesce((new.raw_user_meta_data->>'is_bdr')::boolean, true)
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4) MISE À JOUR D'UN PROFIL
--    p_role disparaît au profit de p_is_admin et p_is_bdr. La protection du
--    dernier administrateur actif est conservée : sans elle, une fausse
--    manoeuvre rendrait l'administration définitivement inaccessible.
-- ----------------------------------------------------------------------------
drop function if exists public.admin_update_profile(uuid, text, text, boolean, boolean);

create or replace function public.admin_update_profile(
  p_user_id      uuid,
  p_display_name text    default null,
  p_is_admin     boolean default null,
  p_is_bdr       boolean default null,
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

  if (p_is_admin = false or p_is_active = false) then
    select count(*) into admins_left
    from public.profiles
    where is_admin and is_active and user_id <> p_user_id;
    if admins_left = 0 then
      raise exception 'Impossible : ce compte est le dernier administrateur actif';
    end if;
  end if;

  update public.profiles set
    display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
    is_admin     = coalesce(p_is_admin,  is_admin),
    is_bdr       = coalesce(p_is_bdr,    is_bdr),
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

revoke all on function public.admin_update_profile(uuid, text, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.admin_update_profile(uuid, text, boolean, boolean, boolean, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- 5) VUE D'ÉQUIPE : LE MARQUEUR is_bdr DOIT REMONTER
--    Sans lui, le front ne pourrait pas exclure les administrateurs purs des
--    classements, et ils y apparaîtraient avec un score de zéro.
-- ----------------------------------------------------------------------------
drop view if exists public.v_team_daily;

create view public.v_team_daily
with (security_invoker = true) as
select
  k.*,
  p.display_name,
  p.email,
  p.is_admin,
  p.is_bdr,
  p.is_demo,
  p.is_active
from public.v_daily_kpi k
join public.profiles p on p.user_id = k.user_id;

grant select on public.v_team_daily to authenticated;


-- ----------------------------------------------------------------------------
-- 6) L'ANCIENNE COLONNE
--    Supprimée en dernier, une fois que plus rien ne la lit. Le front sait
--    fonctionner avec ou sans elle, l'ordre de déploiement n'a donc aucune
--    importance.
-- ----------------------------------------------------------------------------
alter table public.profiles drop column if exists role;


-- ----------------------------------------------------------------------------
-- 7) LE COMPTE ADMINISTRATEUR
--    Administrateur, et NON commercial : pas de page de saisie, pas de
--    performances personnelles, absent des classements.
--    Adapter l'adresse si besoin.
-- ----------------------------------------------------------------------------
update public.profiles
   set is_admin = true,
       is_bdr   = false
 where lower(email) = lower('bbartoli@fluxym.com');


-- ----------------------------------------------------------------------------
-- 8) VÉRIFICATION — à lire dans le panneau de résultats
-- ----------------------------------------------------------------------------
select
  p.display_name                                as nom,
  p.email,
  case when p.is_admin then 'oui' else 'non' end as administrateur,
  case when p.is_bdr   then 'oui' else 'non' end as prospecte,
  case when p.is_demo  then 'oui' else 'non' end as demo,
  case when p.is_active then 'oui' else 'non' end as actif,
  (select count(*) from public.daily_activity d where d.user_id = p.user_id) as jours_saisis,
  case
    when p.is_admin and not p.is_bdr then 'Administrateur pur : Équipe et Comptes'
    when p.is_admin and p.is_bdr     then 'Manager qui prospecte : accès à tout'
    when p.is_bdr                    then 'BDR : sa saisie et ses performances'
    else                                  'Observateur : consultation seule'
  end                                            as acces
from public.profiles p
order by p.is_admin desc, p.is_bdr desc, p.display_name;
