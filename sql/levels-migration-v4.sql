-- ============================================================================
--  BDR COCKPIT — Migration 4 : une échelle de niveaux au lieu d'une case
--  Usage : Supabase → SQL Editor → coller → Run. Idempotent, rejouable.
--  Prérequis : multi-user-migration.sql, roles-migration-v2.sql,
--              accounts-migration-v3.sql.
--
--  LE PROBLÈME QU'ELLE RÉSOUT
--  --------------------------
--  Jusqu'ici « administrateur » était une case, donc tout ou rien : quiconque
--  la portait pouvait lire, corriger et supprimer les saisies de n'importe qui,
--  et administrer tous les comptes, y compris celui du propriétaire de l'outil.
--  Impossible de donner à un responsable d'équipe une vue sur son équipe sans
--  lui donner en même temps le droit de réécrire ses chiffres.
--
--  L'ÉCHELLE
--  ---------
--    owner   (4) le propriétaire. Tout, y compris corriger les chiffres
--                d'autrui et gérer les administrateurs.
--    admin   (3) gère les comptes de niveau strictement inférieur. Lit tout.
--                NE CORRIGE PAS les saisies des autres.
--    manager (2) lit toute l'équipe. N'écrit rien d'autre que ses propres
--                données. C'est le responsable en lecture seule.
--    member  (1) ses propres données, rien d'autre.
--
--  « Prospecte » (is_bdr) reste un axe indépendant : on peut être responsable
--  qui prospecte, ou propriétaire qui ne prospecte pas.
--
--  LA RÈGLE UNIQUE
--  ---------------
--  On n'agit que sur un compte de niveau STRICTEMENT INFÉRIEUR au sien, et on
--  ne peut jamais attribuer un niveau supérieur ou égal au sien. Cette seule
--  phrase interdit de supprimer le propriétaire, de s'auto-promouvoir, et de
--  dégrader un pair. Elle remplace une collection de cas particuliers.
--
--  POURQUOI UN ADMIN NE CORRIGE PAS LES CHIFFRES DES AUTRES
--  -------------------------------------------------------
--  L'outil pilote de l'activité déclarative. Si un responsable peut réécrire
--  ce qu'un BDR a saisi, le chiffre cesse d'appartenir au BDR et la saisie
--  quotidienne perd son sens. La correction reste donc au propriétaire seul,
--  et les colonnes created_by / updated_by en gardent la trace.
--
--  CE QU'ELLE NE FAIT PAS, VOLONTAIREMENT
--  --------------------------------------
--  • Aucune notion d'équipe : un manager voit TOUT LE MONDE, pas « son »
--    équipe. Le périmètre par équipe est un autre chantier, qui suppose une
--    table d'équipes et la réécriture de toutes les règles d'accès.
--  • Aucun changement de comportement visible aujourd'hui : la colonne
--    is_admin est conservée et tenue en phase avec le niveau par un
--    déclencheur, afin que le site et la fonction serveur actuels continuent
--    de fonctionner sans être modifiés. Le niveau « manager » n'est donc pas
--    encore utilisable depuis l'interface : c'est l'objet du lot suivant.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) LA COLONNE ET L'ÉCHELLE
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists access_level text not null default 'member';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass and conname = 'profiles_access_level_check'
  ) then
    alter table public.profiles add constraint profiles_access_level_check
      check (access_level in ('owner', 'admin', 'manager', 'member'));
  end if;
end $$;

comment on column public.profiles.access_level is
  'Niveau de pouvoir : owner > admin > manager > member. Indépendant de is_bdr.';

/** Rang numérique du niveau. Comparer des entiers évite d''écrire la
    hiérarchie en dur à chaque endroit qui doit la faire respecter. */
create or replace function public.level_rank(p_level text)
returns int language sql immutable
as $$
  select case p_level
           when 'owner'   then 4
           when 'admin'   then 3
           when 'manager' then 2
           else 1
         end;
$$;

grant execute on function public.level_rank(text) to authenticated;


-- ----------------------------------------------------------------------------
-- 2) REPRISE DE L'EXISTANT
--    Le propriétaire est désigné par son adresse : il n'y a pas d'autre
--    critère fiable, la case is_admin ne distinguait pas les deux.
-- ----------------------------------------------------------------------------
update public.profiles
   set access_level = case
         when lower(email) = lower('bbartoli@fluxym.com') then 'owner'
         when is_admin                                    then 'admin'
         else 'member'
       end
 where access_level = 'member' or is_admin;


-- ----------------------------------------------------------------------------
-- 3) LE NIVEAU ET L'ANCIENNE CASE RESTENT EN PHASE
--    Tant que le site et la fonction serveur écrivent is_admin, les deux
--    doivent raconter la même chose. Sans ce déclencheur, l'application
--    dégraderait silencieusement un compte à chaque enregistrement.
-- ----------------------------------------------------------------------------
create or replace function public.sync_level_and_flag()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- À la création, seul is_admin est renseigné par le code existant.
    if new.access_level is null or new.access_level = 'member' then
      new.access_level := case when new.is_admin then 'admin' else 'member' end;
    end if;
    new.is_admin := public.level_rank(new.access_level) >= 3;
    return new;
  end if;

  -- Le niveau prime : s'il change, la case suit.
  if new.access_level is distinct from old.access_level then
    new.is_admin := public.level_rank(new.access_level) >= 3;

  -- Sinon, c'est la case qui a bougé, et le niveau suit. Le propriétaire est
  -- protégé : décocher « administrateur » sur son compte depuis l'écran
  -- Comptes ne doit pas le rétrograder.
  elsif new.is_admin is distinct from old.is_admin then
    if old.access_level = 'owner' then
      new.is_admin := true;
    else
      new.access_level := case when new.is_admin then 'admin' else 'member' end;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_level_and_flag on public.profiles;
create trigger trg_sync_level_and_flag
  before insert or update on public.profiles
  for each row execute function public.sync_level_and_flag();


-- ----------------------------------------------------------------------------
-- 4) LES TROIS QUESTIONS QUE POSENT LES RÈGLES D'ACCÈS
--    Un compte désactivé a un rang nul : la désactivation coupe tout, sans
--    qu'il faille y penser à chaque règle.
-- ----------------------------------------------------------------------------
create or replace function public.my_rank()
returns int language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select public.level_rank(access_level)
                     from public.profiles
                    where user_id = auth.uid() and is_active), 0);
$$;

/** Lire les données de tout le monde : responsable et au-dessus. */
create or replace function public.can_read_all()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select public.my_rank() >= 2; $$;

/** Écrire les données d'autrui : le propriétaire seul. */
create or replace function public.can_write_any()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select public.my_rank() >= 4; $$;

/** Conservée pour ne rien casser : « administre les comptes ». */
create or replace function public.is_admin(p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select public.level_rank(access_level) >= 3
                     from public.profiles
                    where user_id = p_uid and is_active), false);
$$;

grant execute on function public.my_rank()       to authenticated;
grant execute on function public.can_read_all()  to authenticated;
grant execute on function public.can_write_any() to authenticated;
grant execute on function public.is_admin(uuid)  to authenticated;


-- ----------------------------------------------------------------------------
-- 5) LES RÈGLES D'ACCÈS : LA LECTURE S'ÉLARGIT, L'ÉCRITURE SE RESSERRE
--    C'est ici que le tout ou rien disparaît. Avant, is_admin() ouvrait les
--    quatre verbes. Maintenant lire et écrire ne demandent plus le même rang.
-- ----------------------------------------------------------------------------
drop policy if exists activity_select on public.daily_activity;
create policy activity_select on public.daily_activity for select to authenticated
  using (user_id = auth.uid() or public.can_read_all());

drop policy if exists activity_insert on public.daily_activity;
create policy activity_insert on public.daily_activity for insert to authenticated
  with check (user_id = auth.uid() or public.can_write_any());

drop policy if exists activity_update on public.daily_activity;
create policy activity_update on public.daily_activity for update to authenticated
  using      (user_id = auth.uid() or public.can_write_any())
  with check (user_id = auth.uid() or public.can_write_any());

drop policy if exists activity_delete on public.daily_activity;
create policy activity_delete on public.daily_activity for delete to authenticated
  using (user_id = auth.uid() or public.can_write_any());

drop policy if exists targets_select on public.daily_targets;
create policy targets_select on public.daily_targets for select to authenticated
  using (user_id = auth.uid() or public.can_read_all());

drop policy if exists targets_write on public.daily_targets;
create policy targets_write on public.daily_targets for all to authenticated
  using      (user_id = auth.uid() or public.can_write_any())
  with check (user_id = auth.uid() or public.can_write_any());

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.can_read_all());


-- ----------------------------------------------------------------------------
-- 6) MISE À JOUR D'UN PROFIL : LA RÈGLE UNIQUE, APPLIQUÉE UNE FOIS
--    L'ancienne signature à p_is_admin est conservée et redirigée : le site
--    actuel continue de fonctionner sans être modifié.
-- ----------------------------------------------------------------------------
create or replace function public.admin_set_level(
  p_user_id      uuid,
  p_display_name text    default null,
  p_access_level text    default null,
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
  r        public.profiles;
  cible    public.profiles;
  mon_rang int := public.my_rank();
begin
  if mon_rang < 3 then
    raise exception 'Action réservée aux administrateurs';
  end if;

  select * into cible from public.profiles where user_id = p_user_id;
  if cible is null then
    raise exception 'Utilisateur introuvable';
  end if;

  -- La règle unique, côté cible.
  if p_user_id <> auth.uid() and public.level_rank(cible.access_level) >= mon_rang then
    raise exception 'Impossible : ce compte est de niveau supérieur ou égal au vôtre';
  end if;

  -- La règle unique, côté niveau demandé : on ne fabrique pas son égal.
  if p_access_level is not null and public.level_rank(p_access_level) >= mon_rang then
    raise exception 'Impossible d''attribuer un niveau supérieur ou égal au vôtre';
  end if;

  -- Le dernier propriétaire actif reste propriétaire et actif.
  if (p_access_level is not null and p_access_level <> 'owner' or p_is_active = false)
     and cible.access_level = 'owner' then
    if not exists (select 1 from public.profiles
                    where access_level = 'owner' and is_active and user_id <> p_user_id) then
      raise exception 'Impossible : ce compte est le dernier propriétaire actif';
    end if;
  end if;

  update public.profiles set
    display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
    access_level = coalesce(p_access_level, access_level),
    is_bdr       = coalesce(p_is_bdr,    is_bdr),
    is_demo      = coalesce(p_is_demo,   is_demo),
    is_active    = coalesce(p_is_active, is_active)
  where user_id = p_user_id
  returning * into r;

  return r;
end;
$$;

revoke all on function public.admin_set_level(uuid, text, text, boolean, boolean, boolean) from public, anon;
grant execute on function public.admin_set_level(uuid, text, text, boolean, boolean, boolean) to authenticated;

/** Ancienne porte d'entrée, conservée pour le site actuel. Traduit la case
    en niveau, puis applique exactement les mêmes contrôles. */
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
  cible  public.profiles;
  niveau text := null;
begin
  select * into cible from public.profiles where user_id = p_user_id;
  if cible is null then
    raise exception 'Utilisateur introuvable';
  end if;

  if p_is_admin is not null then
    if p_is_admin and public.level_rank(cible.access_level) < 3 then
      niveau := 'admin';
    elsif not p_is_admin and cible.access_level = 'admin' then
      niveau := 'member';
    end if;   -- on ne rétrograde jamais un owner par ce chemin
  end if;

  return public.admin_set_level(p_user_id, p_display_name, niveau,
                                p_is_bdr, p_is_demo, p_is_active);
end;
$$;

revoke all on function public.admin_update_profile(uuid, text, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.admin_update_profile(uuid, text, boolean, boolean, boolean, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- 7) SUPPRESSION : LE DERNIER PROPRIÉTAIRE, ET LA HIÉRARCHIE
--    Quand la suppression vient de la fonction serveur, auth.uid() est nul :
--    la hiérarchie a déjà été contrôlée là-bas, mais la protection du dernier
--    propriétaire doit rester absolue, y compris par ce chemin.
-- ----------------------------------------------------------------------------
create or replace function public.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  mon_rang int := public.my_rank();
begin
  if old.access_level = 'owner' and old.is_active then
    if not exists (select 1 from public.profiles
                    where access_level = 'owner' and is_active and user_id <> old.user_id) then
      raise exception
        'Impossible de supprimer % : dernier propriétaire actif.',
        coalesce(old.email, old.user_id::text);
    end if;
  end if;

  if mon_rang > 0 and public.level_rank(old.access_level) >= mon_rang then
    raise exception
      'Impossible de supprimer % : niveau supérieur ou égal au vôtre.',
      coalesce(old.email, old.user_id::text);
  end if;

  return old;
end;
$$;

drop trigger if exists trg_guard_last_admin on public.profiles;
create trigger trg_guard_last_admin
  before delete on public.profiles
  for each row execute function public.guard_last_admin();


-- ----------------------------------------------------------------------------
-- 8) L'APERÇU AVANT SUPPRESSION MONTRE AUSSI LE NIVEAU
-- ----------------------------------------------------------------------------
drop function if exists public.admin_delete_preview(uuid);

create function public.admin_delete_preview(p_user_id uuid)
returns table (
  email          text,
  display_name   text,
  is_admin       boolean,
  is_bdr         boolean,
  days_recorded  bigint,
  first_day      date,
  last_day       date,
  is_last_admin  boolean,
  access_level   text,
  blocked        boolean
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select
    p.email, p.display_name, p.is_admin, p.is_bdr,
    (select count(*) from public.daily_activity d where d.user_id = p.user_id),
    (select min(d.activity_date) from public.daily_activity d where d.user_id = p.user_id),
    (select max(d.activity_date) from public.daily_activity d where d.user_id = p.user_id),
    p.access_level = 'owner' and p.is_active and not exists (
      select 1 from public.profiles q
      where q.access_level = 'owner' and q.is_active and q.user_id <> p.user_id),
    p.access_level,
    public.level_rank(p.access_level) >= public.my_rank()
  from public.profiles p
  where p.user_id = p_user_id and public.is_admin();
$$;

revoke all on function public.admin_delete_preview(uuid) from public, anon;
grant execute on function public.admin_delete_preview(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 9) LA VUE D'ÉQUIPE REMONTE LE NIVEAU
--    Ajout en fin de liste : le code qui lit les colonnes existantes n'est
--    pas affecté.
-- ----------------------------------------------------------------------------
drop view if exists public.v_team_daily;

create view public.v_team_daily
with (security_invoker = true) as
select
  k.*,
  p.display_name, p.email,
  p.is_admin, p.is_bdr, p.is_demo, p.is_active,
  p.access_level
from public.v_daily_kpi k
join public.profiles p on p.user_id = k.user_id;

grant select on public.v_team_daily to authenticated;


-- ============================================================================
--  CONTRÔLE
-- ============================================================================
select
  p.display_name as nom,
  p.access_level as niveau,
  case p.access_level
    when 'owner'   then 'Propriétaire : tout, y compris corriger les autres'
    when 'admin'   then 'Administrateur : gère les comptes, lit tout, ne corrige pas'
    when 'manager' then 'Responsable : lecture seule sur toute l''équipe'
    else                'Membre : ses propres données'
  end            as pouvoir,
  case when p.is_bdr then 'oui' else 'non' end as prospecte,
  case when p.is_admin then 'oui' else 'non' end as case_is_admin_en_phase,
  case when p.is_active then 'oui' else 'non' end as actif
from public.profiles p
order by public.level_rank(p.access_level) desc, p.display_name;
