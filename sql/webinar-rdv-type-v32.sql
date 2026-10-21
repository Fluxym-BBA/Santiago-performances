/* ===========================================================================
   v32 — L'INSCRIPTION WEBINAR DEVIENT UN TYPE DE RENDEZ-VOUS
   21/10/2026

   POURQUOI CETTE MIGRATION CORRIGE LA v31
   La v31 rangeait l'inscription à un webinar HORS entonnoir, « parce que ce
   n'est pas un rendez-vous ». C'était une hypothèse, et elle était fausse pour
   ce processus : l'inscription naît d'un appel téléphonique préalable, et c'est
   une issue de cet appel, au même titre que le rendez-vous obtenu. Elle devient
   donc la QUATRIÈME catégorie de l'étage 3 :

     meetings_rescheduled   rendez-vous reprogrammé
     meetings_new           rendez-vous, nouveau contact
     meetings_known         rendez-vous, contact connu
     webinar_registrations  rendez-vous, inscription à un webinar   (v32)

   La colonne et son poids (créés en v31, copiés de meetings_known) ne bougent
   pas : rien à migrer, aucune donnée à reprendre, la colonne vaut zéro partout.

   CE QUE LA MIGRATION CHANGE
     1. daily_activity_entonnoir() : meetings_booked, le total de l'étage 3,
        additionne désormais quatre catégories. Conséquence voulue : le taux de
        rendez-vous et « appels par rendez-vous » les comptent.
     2. v_daily_kpi : total_actions n'inclut PLUS l'inscription. Elle en faisait
        partie en v31 (hors entonnoir). Comme les trois autres rendez-vous, elle
        découle d'un appel déjà compté dans calls_made : l'ajouter ici la
        compterait deux fois.

   CE QUI NE CHANGE PAS
   Les points : l'inscription pèse son propre poids (webinar_registrations) et
   le total meetings_booked reste à zéro dans le barème. Aucun double compte.
   Le score, total_actions et meetings_booked de toutes les journées existantes
   sont strictement inchangés : la colonne vaut zéro partout.

   ⚠ « with (security_invoker = true) » sur la vue : voir l'incident de la v30.

   ORDRE : cette migration passe AVANT le code de la v32. Le code sans elle
   afficherait un total de rendez-vous qui ignore l'inscription. La migration
   sans le code ne casse rien.

   IDEMPOTENTE : relançable sans dommage.
   =========================================================================== */

begin;

/* ---------------------------------------------------------------------------
   1. LE TRIGGER D'ENTONNOIR
   Recopié tel qu'il est en base au 21/10/2026, avec l'inscription ajoutée à la
   somme de meetings_booked dans les deux branches. Avant la bascule, la
   condition de déclenchement ne change pas : une journée d'avant l'entonnoir
   dont aucune catégorie n'est renseignée garde son total saisi à la main.
   --------------------------------------------------------------------------- */
create or replace function public.daily_activity_entonnoir()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
    -- Jour de mise en service du modèle en entonnoir.
    bascule constant date := date '2026-08-27';
begin
    if new.activity_date >= bascule then
        new.calls_connected := coalesce(new.calls_dead_end, 0)
                             + coalesce(new.calls_engaged_new, 0)
                             + coalesce(new.calls_engaged_known, 0);

        /* calls_engaged reste NULL tant que rien n'est déclaré, là où
           calls_connected tombe à zéro. La différence n'est pas une étourderie :
           calls_connected est NOT NULL depuis l'origine et vaut zéro quand on n'a
           joint personne, tandis que calls_engaged distingue depuis la v10
           « mesuré, aucun échange » de « on ne comptait pas ». Écraser ce NULL
           avec un zéro ferait apparaître un taux d'engagement de 0 % sur des
           journées où la question ne se posait pas. */
        if new.calls_engaged_new is not null or new.calls_engaged_known is not null then
            new.calls_engaged := coalesce(new.calls_engaged_new, 0)
                               + coalesce(new.calls_engaged_known, 0);
        else
            new.calls_engaged := null;
        end if;

        -- v32 : quatrième catégorie de l'étage 3.
        new.meetings_booked := coalesce(new.meetings_rescheduled, 0)
                             + coalesce(new.meetings_new, 0)
                             + coalesce(new.meetings_known, 0)
                             + coalesce(new.webinar_registrations, 0);

    else
        -- Avant la bascule : on ne touche aux totaux que si une ventilation
        -- apparaît, ce qui n'arrive que si quelqu'un reprend la journée exprès.
        if new.calls_dead_end is not null
           or new.calls_engaged_new is not null
           or new.calls_engaged_known is not null then
            new.calls_connected := coalesce(new.calls_dead_end, 0)
                                 + coalesce(new.calls_engaged_new, 0)
                                 + coalesce(new.calls_engaged_known, 0);
        end if;
        if new.calls_engaged_new is not null or new.calls_engaged_known is not null then
            new.calls_engaged := coalesce(new.calls_engaged_new, 0)
                               + coalesce(new.calls_engaged_known, 0);
        end if;
        if new.meetings_rescheduled is not null
           or new.meetings_new is not null
           or new.meetings_known is not null then
            new.meetings_booked := coalesce(new.meetings_rescheduled, 0)
                                 + coalesce(new.meetings_new, 0)
                                 + coalesce(new.meetings_known, 0)
                                 + coalesce(new.webinar_registrations, 0);
        end if;
    end if;

    return new;
end $function$;

/* ---------------------------------------------------------------------------
   2. LA VUE
   Identique à la v31, sauf total_actions : l'inscription en sort.
   v_team_daily et v_best_day lisent v_daily_kpi avec une liste de colonnes
   explicite et n'ont pas à changer.
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
    d.calls_made + d.emails_sent + d.companies_created + d.contacts_created
      + d.first_meetings + d.proposals_sent + d.no_go + d.deals_dropped
      + d.deals_lost as total_actions,
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

commit;

/* ---------------------------------------------------------------------------
   CONTRÔLE DE NEUTRALITÉ, À LANCER AVANT ET APRÈS

   select count(*) as journees, sum(productivity_score) as score_total,
          sum(total_actions) as actions_total, sum(meetings_booked) as rdv_total,
          sum(webinar_registrations) as inscriptions
     from public.v_daily_kpi;

   Les quatre premiers chiffres doivent être identiques, les inscriptions à zéro
   tant que personne n'en a saisi.

   CONTRÔLE DE SÉCURITÉ

   select c.relname, c.reloptions
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v';

   Les trois vues doivent porter {security_invoker=true}.
   --------------------------------------------------------------------------- */
