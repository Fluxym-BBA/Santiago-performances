/* ==========================================================================
   COCKPIT BDR — MIGRATION v8
   Le barème du score devient un réglage, modifiable par le propriétaire
   --------------------------------------------------------------------------
   Pourquoi
   Le barème était écrit deux fois : dans l'expression de v_daily_kpi et dans
   SCORE_WEIGHTS côté navigateur. Les deux disaient la même chose parce qu'on
   les alignait à la main, ce qui n'est pas une garantie mais une habitude. À
   partir du moment où le barème se modifie depuis un écran, la moindre
   divergence donnerait deux scores différents pour la même journée selon la
   page consultée. Une seule vérité, en base, lue par la vue ET par le
   navigateur.

   Le score n'est stocké nulle part : c'est une expression de la vue. Changer un
   poids renote donc tout l'historique de tout le monde à la lecture suivante,
   sans migration de données ni recalcul à lancer. C'est un choix assumé, tranché
   avec Bruno : une seule formule, valable pour tout le monde et pour toute la
   période, sinon deux personnes ne se comparent plus.

   Trois précautions qui ne se voient pas mais qui comptent

   1. La table est lue par une vue en security_invoker = true. Sans politique de
      lecture pour les utilisateurs authentifiés, la jointure ne verrait aucune
      ligne. C'est pour ça qu'elle est faite en LEFT JOIN avec des valeurs de
      repli : dans le pire des cas l'application continue de tourner sur le
      barème historique au lieu de se vider. Un droit manquant devient une
      valeur par défaut, pas une panne.

   2. Une seule ligne, garantie par la clé primaire booléenne contrainte à vrai.
      Il n'y a ni politique d'insertion ni politique de suppression : la ligne
      créée ici est la seule qui existera jamais, et personne ne peut la faire
      disparaître depuis l'application.

   3. L'horodatage et l'auteur sont posés par un trigger, jamais par le client.
      Un écran qui les enverrait lui-même pourrait mentir sur qui a changé quoi.

   Ordre de déploiement
   Cette migration passe AVANT le code. Elle est sans effet sur l'application
   telle qu'elle tourne aujourd'hui : le barème inséré est exactement celui qui
   était écrit en dur, donc aucun score ne bouge. Le code qui suit se contente
   d'aller lire cette table au lieu de croire ses constantes.
   ========================================================================== */

begin;

/* -- 1. La table de barème ------------------------------------------------- */
create table if not exists public.score_weights (
    id                 boolean primary key default true,

    calls_made         integer not null default 1,
    calls_connected    integer not null default 2,
    calls_engaged      integer not null default 4,
    meetings_booked    integer not null default 25,
    emails_sent        integer not null default 1,
    companies_created  integer not null default 2,
    contacts_created   integer not null default 2,

    updated_at         timestamptz not null default now(),
    updated_by         uuid references auth.users(id) on delete set null,

    -- Une ligne et une seule. La clé primaire empêche le doublon, la contrainte
    -- empêche la ligne « false » qui passerait sous le radar de la jointure.
    constraint score_weights_single_row check (id),

    -- Un poids négatif retirerait des points pour une action réalisée, ce qui
    -- n'a pas de sens dans un outil déclaratif. Le plafond n'est là que pour
    -- éviter la faute de frappe à trois zéros.
    constraint score_weights_bounds check (
        calls_made        between 0 and 1000 and
        calls_connected   between 0 and 1000 and
        calls_engaged     between 0 and 1000 and
        meetings_booked   between 0 and 1000 and
        emails_sent       between 0 and 1000 and
        companies_created between 0 and 1000 and
        contacts_created  between 0 and 1000
    ),

    -- Tous les poids à zéro donneraient un score nul pour tout le monde, donc
    -- un outil qui ne dit plus rien. On refuse au niveau de la base.
    constraint score_weights_not_all_zero check (
        calls_made + calls_connected + calls_engaged + meetings_booked
        + emails_sent + companies_created + contacts_created > 0
    )
);

comment on table public.score_weights is
    'Barème du score de productivité. Une seule ligne, modifiable par le propriétaire uniquement. Lue par v_daily_kpi et par le navigateur : c''est la seule définition du barème. Le score n''étant pas stocké, toute modification renote l''historique complet à la lecture suivante.';

/* -- 2. La ligne unique, avec le barème en vigueur aujourd'hui -------------
   Les valeurs sont exactement celles qui étaient écrites dans la vue, pour que
   la migration ne change aucun score. */
insert into public.score_weights (id)
values (true)
on conflict (id) do nothing;

/* -- 3. Horodatage et auteur posés par la base, jamais par le client ------- */
create or replace function public.score_weights_touch()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
    new.id         := true;          -- on ne déplace pas la ligne unique
    new.updated_at := now();
    new.updated_by := auth.uid();
    return new;
end $$;

drop trigger if exists trg_score_weights_touch on public.score_weights;
create trigger trg_score_weights_touch
    before update on public.score_weights
    for each row execute function public.score_weights_touch();

/* -- 4. Qui lit, qui écrit -------------------------------------------------
   Lecture : tout utilisateur authentifié. Le barème n'est pas un secret, et
   l'écran des performances doit pouvoir expliquer son calcul.
   Écriture : le propriétaire seul, via can_write_any(), la même fonction qui
   autorise déjà la correction des chiffres d'autrui. Un barème est global : le
   modifier change le score de tout le monde, ce n'est pas un geste
   d'administration ordinaire.
   Ni insertion ni suppression : la ligne est unique et permanente. */
alter table public.score_weights enable row level security;

revoke all on public.score_weights from anon;
grant select, update on public.score_weights to authenticated;

drop policy if exists score_weights_read on public.score_weights;
create policy score_weights_read on public.score_weights
    for select to authenticated
    using (true);

drop policy if exists score_weights_write on public.score_weights;
create policy score_weights_write on public.score_weights
    for update to authenticated
    using (public.can_write_any())
    with check (public.can_write_any());

/* -- 5. La vue lit le barème au lieu de le porter --------------------------
   create or replace, et non drop puis create : les droits déjà accordés et les
   deux vues qui s'appuient sur celle-ci (v_team_daily, v_best_day) restent en
   place. Les colonnes ne changent ni d'ordre ni de type.

   LEFT JOIN et coalesce, jamais de jointure stricte : si la ligne de barème
   devenait invisible, par droit manquant ou par accident, la vue continuerait
   de servir l'activité avec le barème historique au lieu de renvoyer un
   ensemble vide. Une application qui se vide est bien plus coûteuse qu'un
   barème qui ne se met pas à jour. */
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
    d.calls_made + d.emails_sent + d.companies_created + d.contacts_created
        as total_actions,
    d.calls_made        * coalesce(w.calls_made, 1)
  + d.calls_connected   * coalesce(w.calls_connected, 2)
  + coalesce(d.calls_engaged, 0) * coalesce(w.calls_engaged, 4)
  + d.meetings_booked   * coalesce(w.meetings_booked, 25)
  + d.emails_sent       * coalesce(w.emails_sent, 1)
  + d.companies_created * coalesce(w.companies_created, 2)
  + d.contacts_created  * coalesce(w.contacts_created, 2)
        as productivity_score,
    d.updated_at,
    d.updated_by,
    d.created_by,
    d.updated_by is not null and d.updated_by <> d.user_id as is_correction
from public.daily_activity d
left join public.score_weights w on w.id = true;

comment on view public.v_daily_kpi is
    'Activité quotidienne enrichie des taux et du score. Le barème du score vient de score_weights, en LEFT JOIN avec repli sur les valeurs historiques : une ligne de barème invisible dégrade le barème, elle ne vide pas la vue.';

commit;

/* -- 6. Contrôle ----------------------------------------------------------
   Quatre lignes attendues : le barème en vigueur, la confirmation que la vue
   lit bien la table, le nombre de politiques posées, et le score moyen, qui
   doit être identique à celui d'avant la migration. */
select 'bareme' as controle,
       concat_ws(' / ', 'appel=' || calls_made, 'abouti=' || calls_connected,
                 'echange=' || calls_engaged, 'rdv=' || meetings_booked,
                 'mail=' || emails_sent, 'entr=' || companies_created,
                 'cont=' || contacts_created) as valeur
  from public.score_weights
union all
select 'vue_lit_la_table',
       case when pg_get_viewdef('public.v_daily_kpi'::regclass, true) like '%score_weights%'
            then 'oui' else 'NON' end
union all
select 'politiques_posees',
       count(*)::text from pg_policies
 where schemaname = 'public' and tablename = 'score_weights'
union all
select 'score_moyen_journees_actives',
       round(avg(productivity_score), 1)::text
  from public.v_daily_kpi where total_actions > 0;
