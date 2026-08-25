-- ============================================================================
--  BDR COCKPIT — Migration v6 : appels avec échange, et nouveaux poids du score
--  Usage : Supabase → SQL Editor → coller → Run. Idempotent, rejouable.
--
--  Aucune donnée n'est effacée. Aucune valeur existante n'est modifiée.
--
--  CE QU'ELLE AJOUTE
--  -----------------
--  1) daily_activity.calls_engaged : appels aboutis ayant donné une vraie
--     conversation, par opposition à ceux qui s'arrêtent dans les trente
--     premières secondes. La chaîne devient : appels ⊇ aboutis ⊇ échanges,
--     garantie par contrainte.
--
--  2) La colonne est NULLABLE, et c'est le point le plus important de ce
--     script. Les journées saisies avant aujourd'hui valent NULL, pas zéro.
--     Zéro dirait « aucun échange ce jour-là », ce qui serait faux : personne
--     ne comptait. NULL dit « non mesuré », ce qui est vrai. Tous les taux
--     construits sur cette colonne doivent donc exclure les journées non
--     mesurées au lieu de les compter à zéro, sans quoi les moyennes seront
--     fausses dans le sens flatteur.
--     Conséquence pratique : la date de début de mesure n'a pas besoin d'être
--     stockée nulle part, elle se lit
--         select min(activity_date) from daily_activity where calls_engaged is not null;
--
--  3) daily_targets.engaged_target, objectif journalier, défaut 8. À réviser
--     dès qu'on connaîtra la vraie proportion d'échanges parmi les aboutis :
--     8 est une hypothèse, pas une mesure.
--
--  NOUVEAUX POIDS DU SCORE (décision du 25/08/2026, scénario S3)
--  ------------------------------------------------------------
--      appel passé 1, abouti 2, échange 4, RDV 25, e-mail 1,
--      entreprise 2, contact 2
--
--  Avant : abouti 3, RDV 20, le reste identique.
--
--  Pourquoi toucher aux poids alors qu'il suffisait d'ajouter l'échange :
--  mesuré sur les 164 journées réelles, le rendez-vous n'était que quatrième
--  contributeur du score (19,0 %), derrière l'e-mail (22,1 %), alors que
--  l'écran annonce le RDV comme « le seul chiffre qui compte vraiment ».
--  Ajouter l'échange sans rien changer l'aurait fait tomber cinquième.
--  Avec ces poids il remonte deuxième (20,7 %).
--
--  Effet sur l'historique, mesuré et accepté : la moyenne des 164 journées
--  passe de 140,7 à 137,1, soit -2,6 %, et 8 journées seulement bougent de
--  plus de 10 points. Le meilleur jour reste le même (25/08). C'est le prix
--  d'une formule unique, valable partout et à toutes les dates, plutôt que
--  d'une règle qui dépendrait du jour.
--
--  Il n'y a qu'une seule formule dans la base, celle de v_daily_kpi, et une
--  seule côté application, SCORE_WEIGHTS dans js/api.js. Les deux doivent
--  rester identiques : c'est la seule chose à vérifier si un jour le score
--  affiché à la saisie diffère de celui du tableau de bord.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) LA COLONNE ET SES CONTRAINTES
-- ----------------------------------------------------------------------------
alter table public.daily_activity
  add column if not exists calls_engaged integer;

comment on column public.daily_activity.calls_engaged is
  'Appels aboutis ayant donné une conversation réelle (au-delà des 30 premières secondes). NULL = non mesuré, à distinguer de 0 = mesuré et nul. Renseigné à partir du 25/08/2026.';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.daily_activity'::regclass
                    and conname = 'daily_activity_engaged_positive') then
    alter table public.daily_activity
      add constraint daily_activity_engaged_positive
      check (calls_engaged is null or calls_engaged >= 0);
  end if;

  -- Le maillon du bas ne peut pas dépasser celui du dessus. La contrainte
  -- couvre les deux sens : saisir trop d'échanges, ou faire descendre les
  -- aboutis sous les échanges déjà déclarés.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.daily_activity'::regclass
                    and conname = 'daily_activity_engaged_coherent') then
    alter table public.daily_activity
      add constraint daily_activity_engaged_coherent
      check (calls_engaged is null or calls_engaged <= calls_connected);
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 2) L'OBJECTIF JOURNALIER
--    NOT NULL avec défaut : ici zéro ne veut rien dire de faux, un objectif
--    non fixé est simplement un objectif à sa valeur par défaut.
-- ----------------------------------------------------------------------------
alter table public.daily_targets
  add column if not exists engaged_target integer not null default 8;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.daily_targets'::regclass
                    and conname = 'daily_targets_engaged_target_check') then
    alter table public.daily_targets
      add constraint daily_targets_engaged_target_check check (engaged_target >= 0);
  end if;
end $$;

comment on column public.daily_targets.engaged_target is
  'Objectif journalier d''appels avec échange. Défaut 8, hypothèse à réviser une fois la proportion réelle connue.';


-- ----------------------------------------------------------------------------
-- 3) LES FONCTIONS D'ÉCRITURE
--    Deux corrections en plus de la liste blanche :
--
--    a) coalesce dans bump_metric. GREATEST ignore les NULL : sur une colonne
--       nullable, greatest(0, NULL + 1) vaut 0 et non 1. Sans ce coalesce, le
--       premier clic sur + d'une journée non mesurée écrirait zéro.
--
--    b) le garde-fou de bump_metric parlait d'administrateurs alors que la RLS
--       n'autorise l'écriture chez autrui qu'au propriétaire depuis la v4. Un
--       administrateur passait le garde-fou, puis son UPDATE ne trouvait
--       aucune ligne et la fonction renvoyait NULL en silence, ce que le
--       navigateur affichait comme une réussite. Même règle et même message
--       que set_metric, et une erreur explicite si aucune ligne n'est touchée.
-- ----------------------------------------------------------------------------
create or replace function public.bump_metric(
  p_metric  text,
  p_delta   integer default 1,
  p_date    date default current_date,
  p_user_id uuid default null
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
                      'calls_connected','calls_engaged','meetings_booked','emails_sent') then
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
$$;

revoke all on function public.bump_metric(text, integer, date, uuid) from public, anon;
grant execute on function public.bump_metric(text, integer, date, uuid) to authenticated;

create or replace function public.set_metric(
  p_metric  text,
  p_value   integer,
  p_date    date default current_date,
  p_user_id uuid default null
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
                      'calls_connected','calls_engaged','meetings_booked','emails_sent') then
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
$$;

revoke all on function public.set_metric(text, integer, date, uuid) from public, anon;
grant execute on function public.set_metric(text, integer, date, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 4) LES VUES
--    Recréées et non remplacées : create or replace view n'accepte pas
--    l'insertion d'une colonne au milieu de la liste, et calls_engaged doit
--    se lire juste après calls_connected.
--    security_invoker=true est indispensable et doit être reconduit : sans
--    cette option, une vue appartenant à postgres contournerait la RLS et
--    chacun verrait les journées de tous.
--    L'ordre de suppression suit les dépendances : v_best_day et v_team_daily
--    lisent v_daily_kpi.
-- ----------------------------------------------------------------------------
drop view if exists public.v_best_day;
drop view if exists public.v_team_daily;
drop view if exists public.v_daily_kpi;

create view public.v_daily_kpi with (security_invoker = true) as
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
  end as connect_rate,
  -- Taux d'échange : NULL quand la journée n'a pas été mesurée, jamais zéro.
  case when d.calls_engaged is not null and d.calls_connected > 0
       then round(100.0 * d.calls_engaged::numeric / d.calls_connected::numeric, 1)
  end as engage_rate,
  -- Taux de RDV historique, sur les aboutis. Conservé tel quel : c'est la
  -- seule série continue depuis le 22 mai.
  case when d.calls_connected > 0
       then round(100.0 * d.meetings_booked::numeric / d.calls_connected::numeric, 1)
  end as meeting_rate,
  -- Taux de RDV sur les échanges : le chiffre honnête, mais qui ne commence
  -- qu'à la date de première mesure.
  case when d.calls_engaged is not null and d.calls_engaged > 0
       then round(100.0 * d.meetings_booked::numeric / d.calls_engaged::numeric, 1)
  end as meeting_rate_engaged,
  case when d.meetings_booked > 0
       then round(1.0 * d.calls_made::numeric / d.meetings_booked::numeric, 1)
  end as calls_per_meeting,
  d.calls_made + d.emails_sent + d.companies_created + d.contacts_created as total_actions,
  d.calls_made * 1
    + d.calls_connected * 2
    + coalesce(d.calls_engaged, 0) * 4
    + d.meetings_booked * 25
    + d.emails_sent * 1
    + d.companies_created * 2
    + d.contacts_created * 2 as productivity_score,
  d.updated_at,
  d.updated_by,
  d.created_by,
  d.updated_by is not null and d.updated_by <> d.user_id as is_correction
from public.daily_activity d;

create view public.v_team_daily with (security_invoker = true) as
select
  k.id, k.user_id, k.activity_date,
  k.companies_created, k.contacts_created,
  k.calls_made, k.calls_connected, k.calls_engaged,
  k.meetings_booked, k.emails_sent, k.notes,
  k.connect_rate, k.engage_rate, k.meeting_rate, k.meeting_rate_engaged,
  k.calls_per_meeting, k.total_actions, k.productivity_score,
  k.updated_at, k.updated_by, k.created_by, k.is_correction,
  p.display_name, p.email, p.is_admin, p.is_bdr, p.is_demo, p.is_active, p.access_level
from public.v_daily_kpi k
join public.profiles p on p.user_id = k.user_id;

create view public.v_best_day with (security_invoker = true) as
select distinct on (user_id)
  id, user_id, activity_date,
  companies_created, contacts_created,
  calls_made, calls_connected, calls_engaged,
  meetings_booked, emails_sent, notes,
  connect_rate, engage_rate, meeting_rate, meeting_rate_engaged,
  calls_per_meeting, total_actions, productivity_score,
  updated_at, updated_by, created_by, is_correction
from public.v_daily_kpi
order by user_id, productivity_score desc, activity_date desc;

-- Les droits disparaissent avec les vues supprimées : ils sont reconduits à
-- l'identique. anon garde le select, comme avant, et ne voit rien : la RLS
-- filtre sur auth.uid(), nul pour un visiteur non connecté.
grant select on public.v_daily_kpi  to authenticated, anon;
grant select on public.v_team_daily to authenticated, anon;
grant select on public.v_best_day   to authenticated, anon;


-- ============================================================================
--  CONTRÔLE
--  Trois blocs. Tout doit être vrai.
-- ============================================================================
select 'colonnes' as bloc,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='daily_activity' and column_name='calls_engaged') = 1 as calls_engaged_presente,
       (select is_nullable = 'YES' from information_schema.columns
         where table_schema='public' and table_name='daily_activity' and column_name='calls_engaged') as bien_nullable,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='daily_targets' and column_name='engaged_target') = 1 as objectif_present,
       (select count(*) from public.daily_activity where calls_engaged is not null) as journees_deja_mesurees;

select 'vues' as bloc, c.relname, c.reloptions,
       has_table_privilege('authenticated', c.oid, 'select') as select_authenticated
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname='public' and c.relkind='v' order by c.relname;

select 'score' as bloc,
       round(avg(productivity_score), 1) as moyenne_nouvelle_formule,
       count(*) as journees
  from public.v_daily_kpi
 where total_actions > 0 or meetings_booked > 0 or calls_connected > 0;
