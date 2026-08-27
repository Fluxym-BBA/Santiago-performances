-- ============================================================================
-- COCKPIT BDR — MIGRATION v14
-- L'entonnoir à trois étages, chaque étage découpé en issues disjointes.
--
-- POURQUOI
--
-- Échange avec Dominique le 27/08/2026. Les compteurs d'appels ne disaient pas
-- ce qu'un BDR a besoin de savoir. « Appel abouti » mélangeait deux choses très
-- différentes : celui qui décroche et coupe court, et celui avec qui on a
-- réellement parlé. Et une conversation avec quelqu'un qu'on n'a jamais eu au
-- téléphone n'a rien à voir avec une conversation de suivi.
--
-- LE MODÈLE
--
--   Étage 1  calls_made              tous les appels passés, sans distinction
--
--   Étage 2  on a eu quelqu'un, TROIS ISSUES DISJOINTES :
--            calls_dead_end          il a décroché, la conversation n'a pas eu lieu
--            calls_engaged_new       conversation, contact nouveau
--            calls_engaged_known     conversation, contact déjà connu
--
--   Étage 3  meetings_rescheduled    un rendez-vous existant, reposé
--            meetings_new            rendez-vous, contact nouveau
--            meetings_known          rendez-vous, contact déjà connu
--
-- DISJOINTES est le mot important. Un appel se compte une fois et une seule.
-- L'ancien modèle imposait calls_engaged <= calls_connected : les échanges
-- étaient un sous-ensemble des aboutis, donc le même appel se comptait deux
-- fois, dans « aboutis » puis dans « échange ». C'est vérifiable mais ça se
-- trompe vite, et personne ne sait dire de tête si 20 aboutis dont 8 échanges
-- fait 20 ou 28 appels décrochés.
--
-- LES TOTAUX RESTENT, CALCULÉS
--
-- calls_connected et calls_engaged ne sont plus saisis mais restent en colonnes,
-- écrits par trigger. Ce n'est pas de la nostalgie : le score de productivité,
-- le classement d'équipe et les quatre taux de conversion s'appuient tous sur
-- eux. Les garder calculés laisse tout ce code intact et évite de changer la
-- mesure et la notation la même semaine — sinon, quand un score bougera,
-- personne ne saura si c'est le travail ou l'outil.
--
-- Même chose pour meetings_booked, somme des trois catégories de rendez-vous.
--
-- L'HISTORIQUE
--
-- La conversion est EXACTE, pas approchée. Sous l'ancien modèle, « décroché sans
-- conversation » valait calls_connected - calls_engaged : c'est une soustraction,
-- pas une estimation. Les échanges déjà saisis restent dans calls_engaged sans
-- répartition entre nouveau et connu, ce qui est honnête : personne n'a jamais
-- déclaré cette répartition, et l'inventer serait pire que de l'ignorer.
--
-- Les journées où calls_engaged est NULL — avant le 25/08, personne ne comptait —
-- gardent calls_dead_end = calls_connected : sans échange déclaré, tout appuie
-- sur la voie de garage. C'est le seul endroit où la conversion suppose quelque
-- chose, et elle le suppose dans le sens qui n'invente aucune conversation.
--
-- LE BARÈME NE CHANGE PAS
--
-- Aucune colonne ajoutée à score_weights, donc aucun poids pour les six
-- nouveaux compteurs. Les totaux calculés portent les poids existants. Donner un
-- poids à « RDV nouveau contact » alors que le total pèse 25 compterait le même
-- rendez-vous deux fois et doublerait le score sans qu'aucun travail n'ait
-- changé. Le jour où un RDV nouveau devra valoir plus qu'une reprogrammation, il
-- faudra basculer : les catégories prennent les poids, le total passe à zéro.
-- Cette décision mérite d'être prise seule, avec des chiffres réels sous les yeux.
--
-- ORDRE DE DÉPLOIEMENT : cette migration passe AVANT le code. Le code ne sait
-- pas vivre sans elle, contrairement aux v12 et v13 : il écrit dans des colonnes
-- qui n'existeraient pas et chaque saisie serait refusée.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. LES SIX NOUVEAUX COMPTEURS
--
-- NULL et non 0 par défaut, et c'est le point le plus important de ce bloc.
-- NULL veut dire « personne ne comptait ça ce jour-là », zéro veut dire « j'ai
-- compté, et il n'y en a pas eu ». Les deux se ressemblent dans une colonne et
-- racontent des histoires opposées dans une moyenne : mettre 0 sur les quatre-
-- vingt-dix jours d'historique ferait plonger toutes les courbes et donnerait à
-- voir une dégradation qui n'a jamais eu lieu. Le mécanisme existe déjà pour
-- calls_engaged, mesuré depuis le 25/08 seulement, et METRICS le porte côté code
-- avec son champ `since`.
-- ----------------------------------------------------------------------------

alter table public.daily_activity
    add column if not exists calls_dead_end       integer,
    add column if not exists calls_engaged_new    integer,
    add column if not exists calls_engaged_known  integer,
    add column if not exists meetings_rescheduled integer,
    add column if not exists meetings_new         integer,
    add column if not exists meetings_known       integer;

comment on column public.daily_activity.calls_dead_end is
    'Étage 2 : il a décroché, la conversation n''a pas eu lieu. Disjoint des deux '
    'compteurs d''échange. NULL = non mesuré ce jour-là, 0 = mesuré et aucun.';
comment on column public.daily_activity.calls_engaged_new is
    'Étage 2 : conversation avec un contact nouveau, au sens du seuil défini dans '
    'app_settings.known_contact_months. NULL = non mesuré.';
comment on column public.daily_activity.calls_engaged_known is
    'Étage 2 : conversation avec un contact déjà connu. NULL = non mesuré.';
comment on column public.daily_activity.meetings_rescheduled is
    'Étage 3 : rendez-vous existant, annulé ou manqué, reposé. NULL = non mesuré.';
comment on column public.daily_activity.meetings_new is
    'Étage 3 : rendez-vous avec un contact nouveau. NULL = non mesuré.';
comment on column public.daily_activity.meetings_known is
    'Étage 3 : rendez-vous avec un contact déjà connu. NULL = non mesuré.';

comment on column public.daily_activity.calls_connected is
    'TOTAL CALCULÉ depuis la v14, plus saisi : calls_dead_end + calls_engaged_new '
    '+ calls_engaged_known. Écrit par trg_daily_activity_entonnoir. Conservé en '
    'colonne parce que le score, le classement et quatre taux s''appuient dessus.';
comment on column public.daily_activity.calls_engaged is
    'TOTAL CALCULÉ depuis la v14 : calls_engaged_new + calls_engaged_known. '
    'Conserve les valeurs saisies entre le 25/08 et le 27/08, non réparties.';
comment on column public.daily_activity.meetings_booked is
    'TOTAL CALCULÉ depuis la v14 : meetings_rescheduled + meetings_new + '
    'meetings_known. Conserve les valeurs antérieures, non réparties.';

-- ----------------------------------------------------------------------------
-- 2. LA CONTRAINTE DE COHÉRENCE, REFONDUE
--
-- L'ancienne, daily_activity_engaged_coherent, disait calls_engaged <=
-- calls_connected. Elle n'a plus de sens : calls_engaged est maintenant une part
-- de calls_connected par construction, et la contrainte serait toujours vraie.
--
-- La nouvelle porte sur ce que la personne saisit réellement : on ne peut pas
-- avoir joint plus de gens qu'on a passé d'appels. C'est la seule incohérence
-- qu'un humain produit vraiment, et elle est refusée à l'écriture avec un
-- message que la saisie sait déjà rattraper (voir incoherence() dans saisie.js).
--
-- daily_activity_calls_coherent, qui disait calls_connected <= calls_made, est
-- remplacée : calls_connected n'est plus saisi, contraindre une colonne écrite
-- par trigger reviendrait à faire échouer l'écriture au lieu de la refuser au
-- bon endroit. La nouvelle contrainte couvre exactement le même risque, sur les
-- colonnes que l'utilisateur remplit.
-- ----------------------------------------------------------------------------

-- La nouvelle contrainte est retirée puis reposée, et non ajoutée : le script
-- doit pouvoir être rejoué sans échouer en 42710 sur une contrainte déjà là.
alter table public.daily_activity
    drop constraint if exists daily_activity_engaged_coherent,
    drop constraint if exists daily_activity_calls_coherent,
    drop constraint if exists daily_activity_etage2_coherent;

alter table public.daily_activity
    add constraint daily_activity_etage2_coherent check (
        coalesce(calls_dead_end, 0)
      + coalesce(calls_engaged_new, 0)
      + coalesce(calls_engaged_known, 0) <= calls_made
    );

-- Aucune contrainte entre l'étage 3 et l'étage 2, volontairement, et c'est
-- l'ancienne règle qui est conservée ici : un rendez-vous peut venir d'un
-- e-mail, d'un salon ou d'une recommandation. Refuser un RDV sans échange le
-- même jour empêcherait de déclarer un fait vrai.

-- ----------------------------------------------------------------------------
-- 3. LA CONVERSION DE L'EXISTANT
--
-- Exécutée AVANT la création du trigger, sinon le trigger recalculerait les
-- totaux à partir de sous-catégories encore vides et écraserait l'historique
-- avec des zéros.
-- ----------------------------------------------------------------------------

-- Journées où les échanges étaient mesurés : soustraction exacte.
update public.daily_activity
set calls_dead_end = calls_connected - calls_engaged
where calls_engaged is not null
  and calls_dead_end is null;

-- Journées antérieures au comptage des échanges : tout sur la voie de garage,
-- ce qui n'invente aucune conversation.
update public.daily_activity
set calls_dead_end = calls_connected
where calls_engaged is null
  and calls_dead_end is null;

-- ----------------------------------------------------------------------------
-- 4. LE TRIGGER QUI TIENT LES TOTAUX
--
-- UNE DATE DE BASCULE, ET POURQUOI IL EN FAUT UNE.
--
-- Première version : « recalculer seulement si au moins une sous-catégorie est
-- renseignée ». L'intention était de protéger l'historique, qui n'a pas de
-- ventilation et dont les totaux tomberaient à zéro à la première correction.
-- L'intention était bonne, la règle était trouée : testée pour de vrai, une
-- journée neuve sans catégorie de rendez-vous acceptait meetings_booked = 777.
-- Le total n'était donc protégé qu'une fois la ventilation commencée, c'est-à-dire
-- exactement quand on n'en avait plus besoin.
--
-- Version retenue : une date de bascule. À partir du 27/08/2026, les trois totaux
-- sont TOUJOURS recalculés, quoi qu'écrive le client, y compris à zéro quand rien
-- n'est ventilé — ce qui est juste, puisque à partir de cette date un rendez-vous
-- ne se déclare plus que par sa catégorie. Avant cette date, les totaux sont
-- laissés intacts : ce sont des chiffres que quelqu'un a saisis de bonne foi sous
-- l'ancien modèle, et une correction de notes sur une vieille journée ne doit pas
-- effacer ses rendez-vous.
--
-- La date est écrite ici et non dans une table de réglages : elle n'a de sens
-- qu'une fois, le jour du déploiement, et un réglage modifiable inviterait à la
-- déplacer, ce qui réécrirait l'histoire.
--
-- C'est le trigger qui garantit les totaux, et non les privilèges. daily_activity
-- accorde INSERT et UPDATE au niveau de la TABLE, pas colonne par colonne comme
-- profiles : on ne peut donc pas retirer à un client le droit d'écrire dans
-- calls_connected. Un REVOKE par colonne sur un privilège de table ne fait
-- silencieusement rien, ce qui a été vérifié ici avant d'être compris.
-- ----------------------------------------------------------------------------

create or replace function public.daily_activity_entonnoir()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
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

        new.meetings_booked := coalesce(new.meetings_rescheduled, 0)
                             + coalesce(new.meetings_new, 0)
                             + coalesce(new.meetings_known, 0);

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
                                 + coalesce(new.meetings_known, 0);
        end if;
    end if;

    return new;
end $$;

comment on function public.daily_activity_entonnoir() is
    'Tient calls_connected, calls_engaged et meetings_booked comme sommes de leurs '
    'sous-catégories. Recalcul systématique à partir du 27/08/2026 ; avant cette '
    'date, les totaux saisis sous l''ancien modèle sont laissés intacts.';

drop trigger if exists trg_daily_activity_entonnoir on public.daily_activity;

-- BEFORE et non AFTER : on modifie la ligne en cours d'écriture, ce qui évite
-- une seconde écriture et laisse PostgREST renvoyer les totaux à jour dans sa
-- réponse. La saisie affiche donc le bon total sans requête supplémentaire.
create trigger trg_daily_activity_entonnoir
    before insert or update on public.daily_activity
    for each row execute function public.daily_activity_entonnoir();

-- ----------------------------------------------------------------------------
-- 5. LE SEUIL « CONTACT CONNU »
--
-- Une personne connue redevient inconnue au bout d'un certain temps sans
-- interaction. Dominique dit deux ans. Ce seuil est stocké et non écrit en dur
-- pour deux raisons : il s'affiche dans six aides de saisie qui doivent toutes
-- dire la même chose, et le passer à dix-huit mois ne doit pas demander un
-- redéploiement.
--
-- Il est DÉCLARATIF. L'outil ne vérifie rien : au moment de la saisie, personne
-- ne dit avec qui il a parlé, et aucune règle ne peut donc se calculer. Le seuil
-- est une consigne commune, affichée là où la question se pose.
--
-- Une table de réglages plutôt qu'une colonne sur score_weights : ce n'est pas un
-- poids, et le prochain réglage global n'aura pas plus sa place dans une table
-- qui s'appelle « poids du score ».
-- ----------------------------------------------------------------------------

create table if not exists public.app_settings (
    id                   boolean primary key default true check (id),
    known_contact_months integer not null default 24
                         check (known_contact_months between 1 and 120),
    updated_at           timestamptz not null default now(),
    updated_by           uuid references auth.users(id)
);

comment on table public.app_settings is
    'Réglages globaux du Cockpit, une seule ligne. Le contrainte id = true '
    'interdit d''en créer une seconde : deux lignes de réglages, et plus personne '
    'ne sait laquelle s''applique.';
comment on column public.app_settings.known_contact_months is
    'Au-delà de ce nombre de mois sans interaction, un contact est considéré '
    'comme nouveau. Purement déclaratif : affiché dans les aides de saisie, '
    'jamais vérifié par l''outil, qui ne sait pas avec qui l''appel a eu lieu.';

insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings
    for select to authenticated using (true);

drop policy if exists app_settings_write on public.app_settings;
create policy app_settings_write on public.app_settings
    for all to authenticated using (can_write_any()) with check (can_write_any());

grant select on public.app_settings to authenticated;
grant update (known_contact_months) on public.app_settings to authenticated;

create or replace function public.app_settings_touch()
returns trigger language plpgsql security invoker set search_path = public
as $$
begin
    new.updated_at := now();
    new.updated_by := auth.uid();
    return new;
end $$;

drop trigger if exists trg_app_settings_touch on public.app_settings;
create trigger trg_app_settings_touch
    before update on public.app_settings
    for each row execute function public.app_settings_touch();

-- ----------------------------------------------------------------------------
-- 6. LA VUE
--
-- Les six colonnes sont exposées, et les cinq taux existants sont repris à
-- l'identique. Aucun nouveau taux ici : « part des nouveaux contacts dans les
-- échanges » et ses semblables demandent qu'on décide ce qu'on veut lire, et
-- rien ne presse tant que personne n'a saisi une semaine de chiffres.
--
-- productivity_score est recopié tel quel. Il porte sur les totaux, qui gardent
-- leur sens : le score d'hier et celui de demain restent comparables.
-- ----------------------------------------------------------------------------

create or replace view public.v_daily_kpi as
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
      + d.calls_connected * coalesce(w.calls_connected, 2)
      + coalesce(d.calls_engaged, 0) * coalesce(w.calls_engaged, 4)
      + d.meetings_booked * coalesce(w.meetings_booked, 25)
      + d.emails_sent * coalesce(w.emails_sent, 1)
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
    /* Les six colonnes de la v14 sont AJOUTÉES EN FIN DE VUE, et pas rangées à
       côté des compteurs auxquels elles se rapportent. Ce n'est pas de la
       négligence : create or replace view refuse d'insérer une colonne au milieu
       (42P16, « cannot change name of view column »), il faudrait drop cascade et
       reconstruire tout ce qui en dépend. L'ordre des colonnes d'une vue n'a
       aucune conséquence pour du code qui les nomme. */
    d.calls_dead_end,
    d.calls_engaged_new,
    d.calls_engaged_known,
    d.meetings_rescheduled,
    d.meetings_new,
    d.meetings_known
from public.daily_activity d
    left join public.score_weights w on w.id = true;

-- ----------------------------------------------------------------------------
-- 7. LES PRIVILÈGES
--
-- Rien à faire, et c'est une découverte de cette migration plutôt qu'un choix.
--
-- daily_activity accorde INSERT et UPDATE à authenticated au niveau de la TABLE,
-- contrairement à profiles où le privilège est accordé colonne par colonne. Deux
-- conséquences :
--
--   - les six nouvelles colonnes sont écrivables sans qu'on ait rien à accorder ;
--   - on ne peut PAS retirer à un client le droit d'écrire dans les trois totaux.
--     Un « revoke update (calls_connected) » sur un privilège de table ne lève
--     aucune erreur et ne change rien. Testé, constaté, puis compris.
--
-- La protection des totaux repose donc entièrement sur le trigger de la section 4,
-- qui écrase ce qu'un client aurait écrit. Ce n'est pas une faiblesse nouvelle :
-- meetings_booked était librement saisi avant la v14. Passer daily_activity en
-- privilèges par colonne serait plus propre, mais c'est vingt-six GRANT à écrire
-- et une occasion de casser une écriture qui marche, pour un gain nul tant que
-- le trigger est en place. À faire un jour, pas dans ce lot.
-- ----------------------------------------------------------------------------

commit;

-- ============================================================================
-- VÉRIFICATIONS APRÈS PASSAGE
--
--   -- La conversion est-elle exacte partout :
--   select count(*) as incoherentes from daily_activity
--   where calls_dead_end + coalesce(calls_engaged, 0) <> calls_connected;
--   -- doit renvoyer 0
--
--   -- Le trigger tient-il les totaux :
--   select activity_date, calls_dead_end, calls_engaged_new, calls_engaged_known,
--          calls_connected, calls_engaged
--   from daily_activity order by activity_date desc limit 5;
--
--   -- Les privilèges sont-ils au bon endroit :
--   select column_name, privilege_type from information_schema.column_privileges
--   where table_name = 'daily_activity' and grantee = 'authenticated'
--     and column_name in ('calls_connected', 'calls_engaged', 'meetings_booked',
--                         'calls_dead_end', 'meetings_new')
--   order by column_name;
--   -- calls_connected, calls_engaged et meetings_booked ne doivent PAS y être
-- ============================================================================
