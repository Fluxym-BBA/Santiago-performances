/* ===========================================================================
   v31 — INSCRIPTION WEBINAR
   21/10/2026

   CE QUE C'EST
   Un compteur de plus : le nombre de prospects ou de clients inscrits à un
   webinar suite à une invitation. Il se saisit comme un e-mail envoyé, une
   unité à la fois, et il compte dans le score.

   POURQUOI UN COMPTEUR À PART, ET PAS UNE QUATRIÈME CATÉGORIE DE RENDEZ-VOUS
   Les trois catégories de rendez-vous alimentent meetings_booked, qui alimente
   le taux de rendez-vous et « appels par rendez-vous ». Une inscription à un
   webinar n'est pas un rendez-vous : la compter là gonflerait ces deux chiffres
   et ferait mentir l'entonnoir. Elle vaut autant de POINTS qu'un rendez-vous
   avec un contact connu, elle n'est pas un RENDEZ-VOUS.

   LE POIDS
   webinar_registrations est initialisé par COPIE de meetings_known, au moment
   de la création de la colonne, puis il vit sa vie : le régler depuis l'écran
   Barème ne touche pas meetings_known, et inversement. La copie ne se refait
   jamais : relancer cette migration ne remet pas le poids à la valeur de
   meetings_known (voir le garde-fou de l'étape 2).

   CE QUE LA MIGRATION CHANGE
     1. daily_activity.webinar_registrations, entier, jamais nul, zéro par défaut.
     2. score_weights.webinar_registrations, avec ses bornes 0 à 1000.
     3. metric_allowed() : sans cette ligne, chaque clic répond « Métrique non
        autorisée ».
     4. Les trois vues reçoivent la colonne en dernière position. v_daily_kpi
        ajoute en plus les points au score et l'inscription à total_actions :
        une journée où l'on ne saisit qu'une inscription est une journée active.

   CE QUI NE CHANGE PAS
   Le score et total_actions de toutes les journées existantes : la colonne
   vaut zéro partout, donc elle n'ajoute rien. Vérifié par le contrôle de
   neutralité en bas de fichier.

   ORDRE : cette migration passe AVANT le code de la v31. Le code sans la
   migration écrit une colonne qui n'existe pas, et l'enregistrement du barème
   échoue (saveScoreWeights envoie tous les poids d'un coup). La migration sans
   le code ne casse rien : la colonne reste à zéro, personne ne la voit.

   ⚠ LES TROIS VUES PORTENT « with (security_invoker = true) ». Un CREATE OR
   REPLACE VIEW sans cette clause efface l'option et ouvre une fuite de RLS.
   Voir l'incident documenté dans la v30. Le contrôle de sécurité en bas de
   fichier doit rendre trois lignes.

   IDEMPOTENTE : relançable sans dommage.
   =========================================================================== */

begin;

/* ---------------------------------------------------------------------------
   1. LA COLONNE DE SAISIE
   NOT NULL DEFAULT 0, comme emails_sent : aucun historique à distinguer, une
   journée sans inscription est une journée à zéro, pas une donnée manquante.
   --------------------------------------------------------------------------- */
alter table public.daily_activity
    add column if not exists webinar_registrations integer not null default 0;

alter table public.daily_activity
    drop constraint if exists daily_activity_webinar_registrations_positive;

alter table public.daily_activity
    add constraint daily_activity_webinar_registrations_positive
    check (webinar_registrations >= 0);

comment on column public.daily_activity.webinar_registrations is
    'Inscriptions à un webinar obtenues dans la journée. Compte dans le score et dans total_actions, jamais dans meetings_booked.';

/* ---------------------------------------------------------------------------
   2. LE POIDS
   Créé et copié dans le MÊME bloc conditionnel : la copie n'a lieu que si la
   colonne n'existait pas. Relancée après coup, la migration ne remet donc pas
   à meetings_known un poids que le propriétaire aurait réglé depuis.

   Le déclencheur d'horodatage est mis en sommeil le temps de la copie, comme en
   v30 : auth.uid() est nul dans l'éditeur SQL, et une migration n'est pas une
   décision d'utilisateur. Sans ça l'écran Barème afficherait « modifié
   aujourd'hui, par personne ».
   --------------------------------------------------------------------------- */
do $step2$
begin
    if not exists (
        select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name   = 'score_weights'
           and column_name  = 'webinar_registrations'
    ) then
        alter table public.score_weights
            add column webinar_registrations integer not null default 0;

        alter table public.score_weights disable trigger trg_score_weights_touch;
        update public.score_weights set webinar_registrations = meetings_known;
        alter table public.score_weights enable trigger trg_score_weights_touch;
    end if;
end
$step2$;

/* Contrainte à part plutôt que réécriture de score_weights_bounds : une règle
   de plus ne justifie pas de recopier les dix-huit autres. */
alter table public.score_weights
    drop constraint if exists score_weights_webinar_bounds;

alter table public.score_weights
    add constraint score_weights_webinar_bounds
    check (webinar_registrations between 0 and 1000);

comment on column public.score_weights.webinar_registrations is
    'Points par inscription à un webinar. Initialisé à la valeur de meetings_known à la création, indépendant ensuite.';

/* ---------------------------------------------------------------------------
   3. LA LISTE BLANCHE
   Recopiée telle qu'elle est en base au 21/10/2026, plus une ligne.
   --------------------------------------------------------------------------- */
create or replace function public.metric_allowed(p_metric text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $fn$
  select p_metric = any (array[
    -- Carnet
    'companies_created', 'contacts_created',

    -- Entonnoir, étage 1 : tous les appels passés
    'calls_made',

    -- Entonnoir, étage 2 : on a eu quelqu'un, trois issues disjointes.
    -- calls_connected et calls_engaged n'y sont plus : ce sont des totaux.
    'calls_dead_end', 'calls_engaged_new', 'calls_engaged_known',

    -- Entonnoir, étage 3 : les rendez-vous, trois catégories.
    -- meetings_booked n'y est plus : c'est un total.
    'meetings_rescheduled', 'meetings_new', 'meetings_known',

    -- Hors entonnoir
    'emails_sent',

    -- v31 : inscription à un webinar. Hors entonnoir, comme l'e-mail : ce n'est
    -- pas une issue d'appel et elle ne s'additionne à aucun total.
    'webinar_registrations',

    -- Cycle de vente. Recalculés depuis sales_events depuis la v10, mais laissés
    -- dans la liste : la migration v10 les a rendus non saisissables par l'écran,
    -- pas non saisissables par la base, et les retirer ici dépasse ce lot.
    'first_meetings', 'proposals_sent', 'no_go', 'deals_dropped', 'deals_lost'
  ]);
$fn$;

/* ---------------------------------------------------------------------------
   4. LES VUES
   v_daily_kpi : recopiée de la v30, avec deux ajouts, repérés par « v31 ».
   La colonne arrive en DERNIÈRE position : create or replace view refuse
   d'en insérer une au milieu (42P16).
   --------------------------------------------------------------------------- */
create or replace view public.v_daily_kpi with (security_invoker = true) as
select d.id,
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
    case when d.calls_engaged is not null and d.calls_connected > 0
         then round(100.0 * d.calls_engaged::numeric / d.calls_connected::numeric, 1)
    end as engage_rate,
    case when d.calls_connected > 0
         then round(100.0 * d.meetings_booked::numeric / d.calls_connected::numeric, 1)
    end as meeting_rate,
    case when d.calls_engaged is not null and d.calls_engaged > 0
         then round(100.0 * d.meetings_booked::numeric / d.calls_engaged::numeric, 1)
    end as meeting_rate_engaged,
    case when d.meetings_booked > 0
         then round(1.0 * d.calls_made::numeric / d.meetings_booked::numeric, 1)
    end as calls_per_meeting,
    /* v31 : l'inscription est une action. Sans elle, une journée où l'on ne
       saisit qu'une inscription ne serait pas « active » et sortirait des
       moyennes. */
    d.calls_made + d.emails_sent + d.companies_created + d.contacts_created
      + d.first_meetings + d.proposals_sent + d.no_go + d.deals_dropped
      + d.deals_lost + d.webinar_registrations as total_actions,
    d.calls_made * coalesce(w.calls_made, 1)
      + d.calls_connected * coalesce(w.calls_connected, 0)
      + coalesce(d.calls_engaged, 0) * coalesce(w.calls_engaged, 0)
      + d.meetings_booked * coalesce(w.meetings_booked, 0)
      + coalesce(d.calls_dead_end, 0)       * coalesce(w.calls_dead_end, 2)
      + coalesce(d.calls_engaged_new, 0)    * coalesce(w.calls_engaged_new, 6)
      + coalesce(d.calls_engaged_known, 0)  * coalesce(w.calls_engaged_known, 6)
      + coalesce(d.meetings_rescheduled, 0) * coalesce(w.meetings_rescheduled, 25)
      + coalesce(d.meetings_new, 0)         * coalesce(w.meetings_new, 25)
      + coalesce(d.meetings_known, 0)       * coalesce(w.meetings_known, 25)
      + d.emails_sent * coalesce(w.emails_sent, 1)
      /* v31 : repli à 25, comme meetings_known, pour le cas où la table du
         barème serait injoignable. Même nombre que le repli de SCORE_WEIGHTS
         dans js/api.js. */
      + d.webinar_registrations * coalesce(w.webinar_registrations, 25)
      + d.companies_created * coalesce(w.companies_created, 2)
      + d.contacts_created * coalesce(w.contacts_created, 2)
      + d.first_meetings * coalesce(w.first_meetings, 25)
      + d.proposals_sent * coalesce(w.proposals_sent, 15)
      + d.no_go * coalesce(w.no_go, 0)
      + d.deals_dropped * coalesce(w.deals_dropped, 0)
      + d.deals_lost * coalesce(w.deals_lost, 0) as productivity_score,
    d.updated_at,
    d.updated_by,
    d.created_by,
    d.updated_by is not null and d.updated_by <> d.user_id as is_correction,
    d.first_meetings,
    d.proposals_sent,
    d.no_go,
    d.deals_dropped,
    d.deals_lost,
    d.calls_dead_end,
    d.calls_engaged_new,
    d.calls_engaged_known,
    d.meetings_rescheduled,
    d.meetings_new,
    d.meetings_known,
    d.webinar_registrations
from public.daily_activity d
    left join public.score_weights w on w.id = true;

/* v_team_daily et v_best_day lisent v_daily_kpi avec une liste de colonnes
   explicite : ils ne reçoivent rien tout seuls. L'écran Équipe lit v_team_daily
   avec select('*') et boucle sur METRICS, une colonne absente de la vue y
   vaudrait zéro sans le dire. Recopiées telles qu'en base, plus une colonne. */
create or replace view public.v_team_daily with (security_invoker = true) as
select k.id,
    k.user_id,
    k.activity_date,
    k.companies_created,
    k.contacts_created,
    k.calls_made,
    k.calls_connected,
    k.calls_engaged,
    k.meetings_booked,
    k.emails_sent,
    k.notes,
    k.connect_rate,
    k.engage_rate,
    k.meeting_rate,
    k.meeting_rate_engaged,
    k.calls_per_meeting,
    k.total_actions,
    k.productivity_score,
    k.updated_at,
    k.updated_by,
    k.created_by,
    k.is_correction,
    p.display_name,
    p.email,
    p.is_admin,
    p.is_bdr,
    p.is_demo,
    p.is_active,
    p.access_level,
    k.first_meetings,
    k.proposals_sent,
    k.no_go,
    k.deals_dropped,
    k.deals_lost,
    p.is_sales,
    k.webinar_registrations
from public.v_daily_kpi k
    join public.profiles p on p.user_id = k.user_id;

create or replace view public.v_best_day with (security_invoker = true) as
select distinct on (user_id)
    id,
    user_id,
    activity_date,
    companies_created,
    contacts_created,
    calls_made,
    calls_connected,
    calls_engaged,
    meetings_booked,
    emails_sent,
    notes,
    connect_rate,
    engage_rate,
    meeting_rate,
    meeting_rate_engaged,
    calls_per_meeting,
    total_actions,
    productivity_score,
    updated_at,
    updated_by,
    created_by,
    is_correction,
    first_meetings,
    proposals_sent,
    no_go,
    deals_dropped,
    deals_lost,
    webinar_registrations
from public.v_daily_kpi
order by user_id, productivity_score desc, activity_date desc;

commit;

/* ---------------------------------------------------------------------------
   CONTRÔLE DE SÉCURITÉ, à ne jamais oublier après avoir touché une vue

   select c.relname, c.reloptions
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v';

   Les trois vues doivent porter {security_invoker=true}.

   CONTRÔLE DU POIDS

   select meetings_known, webinar_registrations from public.score_weights;

   Les deux colonnes doivent être égales juste après la migration.

   CONTRÔLE DE NEUTRALITÉ, À LANCER AVANT LA MIGRATION POUR EN GARDER LA TRACE

   select count(*) as journees, sum(productivity_score) as score_total,
          sum(total_actions) as actions_total
     from public.v_daily_kpi;

   Les trois chiffres doivent être identiques avant et après : la colonne vaut
   zéro sur toutes les journées existantes.
   --------------------------------------------------------------------------- */
