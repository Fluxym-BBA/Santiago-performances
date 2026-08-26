-- ============================================================================
-- MIGRATION v9 — DEUX MÉTIERS, CINQ MÉTRIQUES DE CYCLE DE VENTE
-- Cockpit BDR Fluxym — 26/08/2026
--
-- POURQUOI
--   L'outil ne suivait qu'un métier : le BDR. Il doit maintenant suivre aussi
--   les commerciaux, qui ne font pas le même travail et n'ont donc pas les
--   mêmes compteurs. Un commercial ne crée pas d'entreprise dans le CRM et ne
--   prend pas de rendez-vous pour quelqu'un d'autre ; en revanche il tient des
--   premiers rendez-vous, envoie des propositions, et voit des affaires sortir
--   du pipeline.
--
-- CE QUI N'EST PAS FAIT, ET POURQUOI
--   Le niveau d'accès n'est pas touché. « Membre » ne devient pas « BDR ».
--   Les deux questions sont indépendantes depuis la migration v4 : le niveau
--   dit ce que le compte a le droit de voir, le métier dit quels compteurs il
--   tient. Les fusionner rendrait impossible le cas déjà présent dans l'équipe,
--   le responsable qui prospecte, et forcerait à retoucher level_rank(),
--   can_read_all(), can_write_any() et toute la RLS pour un gain nul.
--
--   Le métier est donc un TROISIÈME axe, porté par deux booléens :
--     is_bdr   : tient les compteurs de prospection  (existant, inchangé)
--     is_sales : tient les compteurs de cycle de vente (nouveau)
--   Un manager qui fait les deux coche les deux et voit l'union des compteurs.
--   Un booléen de plus plutôt qu'une colonne job à quatre valeurs : is_bdr est
--   déjà lu par la RLS, par v_team_daily et par la navigation. Une colonne job
--   en ferait une valeur dérivée, donc deux sources de vérité pour la même
--   information.
--
-- LES CINQ NOUVELLES COLONNES
--   first_meetings  RDV1, premier rendez-vous avec un prospect
--   proposals_sent  réponse à un appel d'offres ou chiffrage d'un besoin identifié
--   no_go           prospect ou client que nous décidons de ne pas poursuivre
--   deals_dropped   affaire avortée, il n'existe plus d'opportunité
--   deals_lost      affaire allée au bout, gagnée par un concurrent
--
--   NOT NULL DEFAULT 0, contrairement à calls_engaged qui accepte NULL. La
--   nuance « personne ne comptait avant telle date » n'a pas lieu d'être ici :
--   aucun commercial n'a d'historique dans l'outil, et un BDR n'aura jamais de
--   RDV1 ni de proposition. Zéro veut donc bien dire zéro, à toutes les dates,
--   et aucun `since` n'est déclaré côté application. Conséquence voulue : les
--   164 journées déjà saisies gardent exactement le même score et le même
--   total d'actions, l'ajout de 0 × poids ne changeant rien.
--
--   AUCUNE CONTRAINTE CROISÉE entre ces colonnes. Une proposition peut suivre
--   un RDV1 tenu la semaine précédente, une affaire perdue peut n'avoir jamais
--   eu de RDV1 dans l'outil. Exiger proposals_sent <= first_meetings sur une
--   même journée refuserait des journées parfaitement réelles. C'est la leçon
--   du 24/08 sur calls_connected <= calls_made, qui elle est vraie parce que
--   les deux comptent le même appel le même jour.
--
-- LES TROIS SORTIES NE RAPPORTENT AUCUN POINT
--   no_go, deals_dropped et deals_lost arrivent avec un poids de 0 dans
--   score_weights. Perdre une affaire ne peut pas faire monter un score de
--   productivité. Elles sont comptées, suivies, jamais valorisées. Le poids
--   reste réglable depuis l'écran Barème, comme les autres : c'est une valeur
--   par défaut, pas une règle gravée.
--
-- MAIS ELLES COMPTENT DANS total_actions
--   total_actions est ce qui définit une « journée active », donc toutes les
--   moyennes, la série en cours et les classements. Sans les nouvelles colonnes
--   dedans, un commercial qui déclare deux NO GO et une proposition aurait
--   total_actions = 0 : l'outil le déclarerait inactif alors qu'il a travaillé
--   et saisi. Les cinq colonnes y entrent donc, y compris les sorties.
--   Elles ne créent aucun double comptage : contrairement à calls_connected et
--   calls_engaged, qui recomptent un appel déjà compté, chacune désigne un
--   événement distinct.
--
-- ORDRE DE DÉPLOIEMENT
--   CE FICHIER D'ABORD, le code ensuite. La page Barème enverra douze poids
--   au lieu de sept dès que js/api.js sera en ligne : sans les colonnes, tout
--   enregistrement de barème échouerait.
--
-- IDEMPOTENT : rejouable sans dommage.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) LE MÉTIER : profiles.is_sales
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_sales boolean not null default false;

comment on column public.profiles.is_sales is
  'Métier commercial : tient les compteurs de cycle de vente (RDV1, '
  'propositions, sorties de pipeline). Indépendant de access_level et '
  'd''is_bdr. Un compte peut être les deux, auquel cas il voit l''union des '
  'compteurs. is_bdr or is_sales = la personne saisit une activité, a un '
  'score et apparaît dans les classements.';

-- ----------------------------------------------------------------------------
-- 2) LES CINQ COLONNES D'ACTIVITÉ
-- ----------------------------------------------------------------------------
alter table public.daily_activity
  add column if not exists first_meetings integer not null default 0,
  add column if not exists proposals_sent integer not null default 0,
  add column if not exists no_go          integer not null default 0,
  add column if not exists deals_dropped  integer not null default 0,
  add column if not exists deals_lost     integer not null default 0;

comment on column public.daily_activity.first_meetings is
  'RDV1 : premier rendez-vous avec un prospect, tenu par le commercial. '
  'Distinct de meetings_booked, qui est le rendez-vous OBTENU par le BDR : '
  'deux personnes, deux événements, deux compteurs.';
comment on column public.daily_activity.proposals_sent is
  'Proposition envoyée : réponse à un appel d''offres, ou chiffrage adressé '
  'en réponse à un besoin clair et identifié.';
comment on column public.daily_activity.no_go is
  'Prospect ou client pour lequel nous avons décidé de ne pas continuer. '
  'Décision de notre côté. Ne rapporte aucun point.';
comment on column public.daily_activity.deals_dropped is
  'Affaire avortée : il n''existe plus d''opportunité, sans que le client '
  'nous ait préféré un concurrent. Ne rapporte aucun point.';
comment on column public.daily_activity.deals_lost is
  'Affaire allée jusqu''au bout et perdue : un concurrent l''a gagnée. '
  'Ne rapporte aucun point.';

-- Positivité seule. Le DO garde l'idempotence : ADD CONSTRAINT IF NOT EXISTS
-- n'existe pas en PostgreSQL.
do $$
declare
  c text;
begin
  foreach c in array array['first_meetings','proposals_sent','no_go',
                           'deals_dropped','deals_lost']
  loop
    if not exists (select 1 from pg_constraint
                    where conrelid = 'public.daily_activity'::regclass
                      and conname = 'daily_activity_' || c || '_positive') then
      execute format(
        'alter table public.daily_activity add constraint %I check (%I >= 0)',
        'daily_activity_' || c || '_positive', c);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3) OBJECTIFS JOURNALIERS : DEUX COLONNES, PAS CINQ
--    Un objectif journalier de NO GO n'a aucun sens : on ne se fixe pas de
--    perdre des affaires. Seuls le RDV1 et la proposition en reçoivent un.
--    Les trois sorties n'ont pas de colonne d'objectif, et l'application ne
--    leur affiche aucune jauge.
-- ----------------------------------------------------------------------------
alter table public.daily_targets
  add column if not exists first_meetings_target integer not null default 1,
  add column if not exists proposals_target      integer not null default 1;

do $$
declare
  c text;
begin
  foreach c in array array['first_meetings_target','proposals_target']
  loop
    if not exists (select 1 from pg_constraint
                    where conrelid = 'public.daily_targets'::regclass
                      and conname = 'daily_targets_' || c || '_check') then
      execute format(
        'alter table public.daily_targets add constraint %I check (%I >= 0)',
        'daily_targets_' || c || '_check', c);
    end if;
  end loop;
end $$;

comment on column public.daily_targets.first_meetings_target is
  'Objectif journalier de RDV1. Défaut 1, à calibrer sur les premières '
  'semaines réelles : aucune donnée ne permet aujourd''hui de le fonder.';
comment on column public.daily_targets.proposals_target is
  'Objectif journalier de propositions envoyées. Défaut 1, même réserve.';

-- ----------------------------------------------------------------------------
-- 4) BARÈME : CINQ POIDS DE PLUS
--    first_meetings à 25, comme le rendez-vous obtenu : pour un commercial,
--    le RDV1 est l'équivalent du seul chiffre qui compte vraiment.
--    proposals_sent à 15 : c'est un travail réel et engageant, mais qui suit
--    un RDV1 déjà valorisé.
--    Les trois sorties à 0, voir l'en-tête.
--    Ces valeurs sont des points de départ, pas des vérités : elles ont été
--    posées sans une seule journée de donnée commerciale, et l'écran Barème
--    existe précisément pour les corriger quand il y en aura.
-- ----------------------------------------------------------------------------
alter table public.score_weights
  add column if not exists first_meetings integer not null default 25,
  add column if not exists proposals_sent integer not null default 15,
  add column if not exists no_go          integer not null default 0,
  add column if not exists deals_dropped  integer not null default 0,
  add column if not exists deals_lost     integer not null default 0;

-- Les bornes existantes ne connaissaient que sept colonnes : une faute de
-- frappe à trois zéros sur un nouveau poids passerait. La contrainte est
-- refaite sur les douze.
alter table public.score_weights drop constraint if exists score_weights_bounds;
alter table public.score_weights
  add constraint score_weights_bounds check (
    calls_made        between 0 and 1000 and
    calls_connected   between 0 and 1000 and
    calls_engaged     between 0 and 1000 and
    meetings_booked   between 0 and 1000 and
    emails_sent       between 0 and 1000 and
    companies_created between 0 and 1000 and
    contacts_created  between 0 and 1000 and
    first_meetings    between 0 and 1000 and
    proposals_sent    between 0 and 1000 and
    no_go             between 0 and 1000 and
    deals_dropped     between 0 and 1000 and
    deals_lost        between 0 and 1000
  );

-- score_weights_not_all_zero n'est PAS élargie, volontairement. Elle garantit
-- que le score de prospection ne peut pas être annulé en bloc. L'étendre aux
-- douze colonnes l'affaiblirait : un barème où tous les poids BDR seraient à
-- zéro passerait, à la seule condition qu'un NO GO vaille un point.

-- ----------------------------------------------------------------------------
-- 5) LISTE BLANCHE DES MÉTRIQUES : UNE SEULE, INTERROGÉE PAR LES DEUX
--    bump_metric et set_metric portaient chacune sa propre liste, écrite en
--    dur. Deux listes à tenir à jour, donc une occasion de n'en modifier
--    qu'une : passer de sept à douze métriques dans deux endroits différents
--    est exactement le genre d'oubli qui laisse un bouton « + » sans effet.
--    La liste vit désormais dans une fonction, et les deux l'interrogent.
--
--    Elle reste explicite plutôt que déduite du catalogue : ces deux fonctions
--    écrivent dans une colonne dont le nom vient du navigateur, et une liste
--    ouverte y serait une porte ouverte.
--
--    Les deux corps sont repris À L'IDENTIQUE de ce qui est déployé, seule la
--    ligne de contrôle change. Ni l'une ni l'autre n'est SECURITY DEFINER, et
--    ça ne change pas : la RLS de daily_activity est la barrière.
-- ----------------------------------------------------------------------------
create or replace function public.metric_allowed(p_metric text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select p_metric = any (array[
    'companies_created', 'contacts_created', 'calls_made', 'calls_connected',
    'calls_engaged', 'meetings_booked', 'emails_sent',
    'first_meetings', 'proposals_sent', 'no_go', 'deals_dropped', 'deals_lost'
  ]);
$$;

revoke all on function public.metric_allowed(text) from public;
grant execute on function public.metric_allowed(text) to authenticated, service_role;

create or replace function public.bump_metric(
  p_metric  text,
  p_delta   integer default 1,
  p_date    date default current_date,
  p_user_id uuid default null
)
returns public.daily_activity
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  r      public.daily_activity;
  target uuid := coalesce(p_user_id, auth.uid());
begin
  if not public.metric_allowed(p_metric) then
    raise exception 'Métrique non autorisée : %', p_metric;
  end if;

  if target is distinct from auth.uid() and not public.can_write_any() then
    raise exception 'Saisie pour un autre utilisateur réservée au propriétaire';
  end if;

  insert into public.daily_activity (user_id, activity_date)
  values (target, p_date)
  on conflict (user_id, activity_date) do nothing;

  execute format(
    'update public.daily_activity
        set %1$I = greatest(0, coalesce(%1$I, 0) + $1)
      where user_id = $2 and activity_date = $3
      returning *', p_metric)
  into r
  using p_delta, target, p_date;

  if r.id is null then
    raise exception 'Journée introuvable ou modification refusée';
  end if;

  return r;
end;
$function$;

create or replace function public.set_metric(
  p_metric  text,
  p_value   integer,
  p_date    date default current_date,
  p_user_id uuid default null
)
returns public.daily_activity
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  r      public.daily_activity;
  target uuid := coalesce(p_user_id, auth.uid());
begin
  if not public.metric_allowed(p_metric) then
    raise exception 'Métrique non autorisée : %', p_metric;
  end if;

  if p_value is null or p_value < 0 then
    raise exception 'Valeur refusée : %', p_value;
  end if;

  if target is distinct from auth.uid() and not public.can_write_any() then
    raise exception 'Saisie pour un autre utilisateur réservée au propriétaire';
  end if;

  -- Ligne créée à zéro, donc toujours cohérente : c'est ce que l'upsert
  -- partiel de la page de saisie ne savait pas faire (voir migration v5).
  insert into public.daily_activity (user_id, activity_date)
  values (target, p_date)
  on conflict (user_id, activity_date) do nothing;

  execute format(
    'update public.daily_activity
        set %1$I = $1
      where user_id = $2 and activity_date = $3
      returning *', p_metric)
  into r
  using p_value, target, p_date;

  if r.id is null then
    raise exception 'Journée introuvable ou modification refusée';
  end if;

  return r;
end;
$function$;

-- CREATE OR REPLACE conserve les droits existants : rien à re-attribuer ici.

-- ----------------------------------------------------------------------------
-- 6) ADMINISTRATION DES COMPTES : LE MÉTIER SE RÈGLE COMME LE RESTE
--
--    admin_set_level gagne un septième paramètre. En PostgreSQL, ajouter un
--    paramètre ne remplace pas la fonction : il en crée une seconde, et les
--    deux coexistent. Un appel PostgREST à six arguments nommés deviendrait
--    alors ambigu et échouerait. L'ancienne signature est donc supprimée
--    explicitement, et admin_update_profile, qui l'appelle par position, est
--    refaite dans le même mouvement.
--
--    Le corps est celui qui est DÉPLOYÉ aujourd'hui, à la ligne is_sales près :
--    contrôle par my_rank(), refus d'agir sur un compte de rang supérieur ou
--    égal, refus de fabriquer son égal, et protection du dernier propriétaire
--    actif. Rien de tout cela ne change.
--
--    ATTENTION : le fichier sql/levels-migration-v4.sql du dépôt décrit une
--    version différente de ces deux fonctions (paramètre p_level, appel à un
--    can_manage_accounts() qui n'existe pas en base). C'est le dépôt qui a
--    divergé, pas la base. La base est la référence ici.
-- ----------------------------------------------------------------------------
create or replace function public.admin_set_level(
  p_user_id      uuid,
  p_display_name text    default null,
  p_access_level text    default null,
  p_is_bdr       boolean default null,
  p_is_demo      boolean default null,
  p_is_active    boolean default null,
  p_is_sales     boolean default null
)
returns public.profiles
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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

  -- Le métier n'est pas un droit : aucune règle de hiérarchie ne le protège,
  -- au même titre qu'is_bdr. Un administrateur qui peut toucher ce compte peut
  -- dire quels compteurs il tient.
  update public.profiles set
    display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
    access_level = coalesce(p_access_level, access_level),
    is_bdr       = coalesce(p_is_bdr,    is_bdr),
    is_sales     = coalesce(p_is_sales,  is_sales),
    is_demo      = coalesce(p_is_demo,   is_demo),
    is_active    = coalesce(p_is_active, is_active)
  where user_id = p_user_id
  returning * into r;

  return r;
end;
$function$;

revoke all on function public.admin_set_level(uuid, text, text, boolean, boolean, boolean, boolean) from public;
grant execute on function public.admin_set_level(uuid, text, text, boolean, boolean, boolean, boolean) to authenticated, service_role;

create or replace function public.admin_update_profile(
  p_user_id      uuid,
  p_display_name text    default null,
  p_is_admin     boolean default null,
  p_is_bdr       boolean default null,
  p_is_demo      boolean default null,
  p_is_active    boolean default null,
  p_is_sales     boolean default null
)
returns public.profiles
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
                                p_is_bdr, p_is_demo, p_is_active, p_is_sales);
end;
$function$;

revoke all on function public.admin_update_profile(uuid, text, boolean, boolean, boolean, boolean, boolean) from public;
grant execute on function public.admin_update_profile(uuid, text, boolean, boolean, boolean, boolean, boolean) to authenticated, service_role;

-- Les anciennes signatures à six arguments partent maintenant, et pas avant :
-- tant qu'elles existent, un appel à six arguments nommés est ambigu.
drop function if exists public.admin_update_profile(uuid, text, boolean, boolean, boolean, boolean);
drop function if exists public.admin_set_level(uuid, text, text, boolean, boolean, boolean);

-- ----------------------------------------------------------------------------
-- 7) LES TROIS VUES
--    CREATE OR REPLACE et non DROP : PostgreSQL autorise l'ajout de colonnes
--    EN FIN de liste, ce qui suffit ici. On évite ainsi de refaire les droits
--    et de casser les vues dépendantes. Les nouvelles colonnes sont donc en
--    queue, et non à côté de celles qu'elles complètent : l'application lit
--    par nom, jamais par position.
--    Les colonnes existantes sont reprises À L'IDENTIQUE, y compris l'écriture
--    des taux : changer leur formulation ferait échouer le remplacement pour
--    rien.
-- ----------------------------------------------------------------------------
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
    d.calls_engaged,
    d.meetings_booked,
    d.emails_sent,
    d.notes,
    case when d.calls_made > 0
         then round(100.0 * d.calls_connected::numeric / d.calls_made::numeric, 1)
         else null::numeric end as connect_rate,
    case when d.calls_engaged is not null and d.calls_connected > 0
         then round(100.0 * d.calls_engaged::numeric / d.calls_connected::numeric, 1)
         else null::numeric end as engage_rate,
    case when d.calls_connected > 0
         then round(100.0 * d.meetings_booked::numeric / d.calls_connected::numeric, 1)
         else null::numeric end as meeting_rate,
    case when d.calls_engaged is not null and d.calls_engaged > 0
         then round(100.0 * d.meetings_booked::numeric / d.calls_engaged::numeric, 1)
         else null::numeric end as meeting_rate_engaged,
    case when d.meetings_booked > 0
         then round(1.0 * d.calls_made::numeric / d.meetings_booked::numeric, 1)
         else null::numeric end as calls_per_meeting,

    -- Une journée est active dès qu'un événement y a été déclaré, quel que
    -- soit le métier. Les cinq colonnes de cycle de vente en font donc partie,
    -- sinon un commercial serait compté inactif tous les jours et l'outil
    -- afficherait des moyennes fausses sur une population entière.
    -- calls_connected et calls_engaged restent dehors, inchangé : elles
    -- recomptent un appel déjà compté par calls_made.
    d.calls_made + d.emails_sent + d.companies_created + d.contacts_created
      + d.first_meetings + d.proposals_sent + d.no_go + d.deals_dropped
      + d.deals_lost
        as total_actions,

    -- Barème lu dans score_weights, repli sur les valeurs historiques, à
    -- l'identique de la migration v8. Les cinq nouveaux poids suivent la même
    -- règle : les trois sorties de pipeline ont un repli à 0, donc perdre une
    -- affaire ne peut pas faire monter un score, même barème absent.
    d.calls_made        * coalesce(w.calls_made, 1)
  + d.calls_connected   * coalesce(w.calls_connected, 2)
  + coalesce(d.calls_engaged, 0) * coalesce(w.calls_engaged, 4)
  + d.meetings_booked   * coalesce(w.meetings_booked, 25)
  + d.emails_sent       * coalesce(w.emails_sent, 1)
  + d.companies_created * coalesce(w.companies_created, 2)
  + d.contacts_created  * coalesce(w.contacts_created, 2)
  + d.first_meetings    * coalesce(w.first_meetings, 25)
  + d.proposals_sent    * coalesce(w.proposals_sent, 15)
  + d.no_go             * coalesce(w.no_go, 0)
  + d.deals_dropped     * coalesce(w.deals_dropped, 0)
  + d.deals_lost        * coalesce(w.deals_lost, 0)
        as productivity_score,
    d.updated_at,
    d.updated_by,
    d.created_by,
    d.updated_by is not null and d.updated_by <> d.user_id as is_correction,

    d.first_meetings,
    d.proposals_sent,
    d.no_go,
    d.deals_dropped,
    d.deals_lost
from public.daily_activity d
left join public.score_weights w on w.id = true;

comment on view public.v_daily_kpi is
    'Activité quotidienne enrichie des taux et du score. Le barème du score vient de score_weights, en LEFT JOIN avec repli sur les valeurs historiques. total_actions compte tout événement déclaré, prospection comme cycle de vente : c''est lui qui définit une journée active.';

create or replace view public.v_team_daily
with (security_invoker = true) as
select
  k.id, k.user_id, k.activity_date,
  k.companies_created, k.contacts_created,
  k.calls_made, k.calls_connected, k.calls_engaged,
  k.meetings_booked, k.emails_sent, k.notes,
  k.connect_rate, k.engage_rate, k.meeting_rate, k.meeting_rate_engaged,
  k.calls_per_meeting, k.total_actions, k.productivity_score,
  k.updated_at, k.updated_by, k.created_by, k.is_correction,
  p.display_name, p.email, p.is_admin, p.is_bdr, p.is_demo, p.is_active, p.access_level,

  k.first_meetings, k.proposals_sent, k.no_go, k.deals_dropped, k.deals_lost,
  p.is_sales
from public.v_daily_kpi k
join public.profiles p on p.user_id = k.user_id;

create or replace view public.v_best_day
with (security_invoker = true) as
select distinct on (user_id)
  id, user_id, activity_date,
  companies_created, contacts_created,
  calls_made, calls_connected, calls_engaged,
  meetings_booked, emails_sent, notes,
  connect_rate, engage_rate, meeting_rate, meeting_rate_engaged,
  calls_per_meeting, total_actions, productivity_score,
  updated_at, updated_by, created_by, is_correction,

  first_meetings, proposals_sent, no_go, deals_dropped, deals_lost
from public.v_daily_kpi
order by user_id, productivity_score desc, activity_date desc;

-- Les droits ne sont pas retouchés : CREATE OR REPLACE VIEW les conserve,
-- contrairement à DROP puis CREATE. Le contrôle (h) le vérifie.

commit;

-- ----------------------------------------------------------------------------
-- 8) CONTRÔLES — à lire, pas seulement à exécuter
-- ----------------------------------------------------------------------------

-- a) Les colonnes sont là.
select count(*) as colonnes_activite_attendu_5
  from information_schema.columns
 where table_schema = 'public' and table_name = 'daily_activity'
   and column_name in ('first_meetings','proposals_sent','no_go','deals_dropped','deals_lost');

select count(*) as colonnes_bareme_attendu_5
  from information_schema.columns
 where table_schema = 'public' and table_name = 'score_weights'
   and column_name in ('first_meetings','proposals_sent','no_go','deals_dropped','deals_lost');

-- b) AUCUN score historique n'a bougé : les nouvelles colonnes valent 0
--    partout, donc les deux moyennes doivent être identiques au centième.
--    Si elles diffèrent, ne déployez pas le code et dites-le.
select round(avg(productivity_score), 2) as score_moyen_apres,
       round(avg(total_actions), 2)      as actions_moyennes_apres,
       count(*)                          as journees
  from public.v_daily_kpi;

-- c) Le barème par défaut, tel qu'il sera lu par la vue et par l'écran.
select first_meetings, proposals_sent, no_go, deals_dropped, deals_lost
  from public.score_weights;

-- d) La liste blanche accepte les nouvelles métriques et refuse le reste.
select public.metric_allowed('first_meetings') as doit_etre_vrai,
       public.metric_allowed('notes')          as doit_etre_faux;

-- e) Une seule fonction pour chaque nom : deux lignes ici signifieraient un
--    appel ambigu depuis l'application.
select proname, count(*) as versions
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('admin_set_level', 'admin_update_profile')
 group by proname;

-- f) Personne n'est commercial pour l'instant : c'est normal, la case se coche
--    depuis l'écran Comptes.
select count(*) filter (where is_bdr)   as bdr,
       count(*) filter (where is_sales) as commerciaux,
       count(*) filter (where is_bdr and is_sales) as les_deux
  from public.profiles;
