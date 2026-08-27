-- ============================================================================
-- COCKPIT BDR — MIGRATION v14.1
-- La liste blanche des métriques saisissables.
--
-- POURQUOI UN SCRIPT À PART
--
-- metric_allowed() est traversée par bump_metric et set_metric, c'est-à-dire par
-- tous les boutons plus et moins et toutes les frappes au clavier de la page de
-- saisie. Elle ne contenait pas les six compteurs de la v14 : sans ce script,
-- chaque clic sur un nouveau compteur répond « Métrique non autorisée » et rien
-- ne se saisit.
--
-- Elle est séparée de la v14 parce qu'elle a été oubliée dans la v14, et qu'un
-- script déjà passé ne se réécrit pas : on verrait dans le dépôt un fichier qui
-- ne correspond à aucun état par lequel la base est passée.
--
-- LES TROIS TOTAUX SONT RETIRÉS DE LA LISTE
--
-- calls_connected, calls_engaged et meetings_booked sont désormais écrits par
-- trg_daily_activity_entonnoir. Les laisser dans la liste blanche laisserait un
-- bouton d'une version antérieure du code, ou un onglet resté ouvert depuis la
-- veille, les incrémenter dans le dos du trigger : l'écriture passerait, le
-- trigger la corrigerait au prochain enregistrement d'une sous-catégorie, et
-- entre les deux quelqu'un lirait un chiffre faux sans jamais savoir pourquoi.
--
-- C'est aussi la seule barrière disponible. Le privilège INSERT/UPDATE de
-- daily_activity est accordé au niveau de la table et non colonne par colonne :
-- un revoke par colonne n'y fait rien, ce qui a été vérifié en écrivant la v14.
--
-- ORDRE DE DÉPLOIEMENT : après la v14, avant le code.
-- ============================================================================

begin;

create or replace function public.metric_allowed(p_metric text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
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

    -- Cycle de vente. Recalculés depuis sales_events depuis la v10, mais laissés
    -- dans la liste : la migration v10 les a rendus non saisissables par l'écran,
    -- pas non saisissables par la base, et les retirer ici dépasse ce lot.
    'first_meetings', 'proposals_sent', 'no_go', 'deals_dropped', 'deals_lost'
  ]);
$$;

comment on function public.metric_allowed(text) is
    'Liste blanche des compteurs qu''un client peut incrémenter ou fixer. Exclut '
    'depuis la v14.1 les trois totaux calls_connected, calls_engaged et '
    'meetings_booked, écrits par trg_daily_activity_entonnoir.';

commit;

-- ============================================================================
-- VÉRIFICATIONS
--
--   select metric_allowed('calls_dead_end')   as doit_etre_vrai,
--          metric_allowed('meetings_new')     as doit_etre_vrai_2,
--          metric_allowed('calls_connected')  as doit_etre_faux,
--          metric_allowed('meetings_booked')  as doit_etre_faux_2;
--
--   -- Toutes les métriques de METRICS (js/api.js) doivent être autorisées,
--   -- sauf les trois totaux :
--   select k, metric_allowed(k) from unnest(array[
--     'companies_created','contacts_created','calls_made','calls_dead_end',
--     'calls_engaged_new','calls_engaged_known','meetings_rescheduled',
--     'meetings_new','meetings_known','emails_sent','first_meetings',
--     'proposals_sent']) k;
-- ============================================================================
