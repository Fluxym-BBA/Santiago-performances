/* ===========================================================================
   v30 — LE BARÈME REJOINT L'ENTONNOIR
   30/08/2026

   POURQUOI

   L'entonnoir de la v14 a coupé deux totaux en catégories : un appel abouti est
   désormais « sans échange », « échange avec un nouveau contact » ou « échange
   avec un contact connu », et un rendez-vous obtenu est « reprogrammé »,
   « nouveau contact » ou « contact connu ». La page de saisie compte ces six
   catégories depuis un an. Le barème, lui, est resté celui de la v8 : douze
   colonnes, écrites avant que ces catégories existent.

   Conséquence, visible à l'écran : les trois rendez-vous valent 25 points tous
   les trois, et les deux échanges valent 9 points tous les deux. Impossible de
   dire qu'un rendez-vous reposé après une annulation pèse moins qu'un rendez-vous
   arraché à un contact qui n'avait jamais répondu. Le propriétaire de l'outil ne
   peut pas régler ce qu'il voit régler ailleurs.

   CE QUE FAIT CETTE MIGRATION

   Elle donne un poids propre aux six catégories, et met à zéro les trois totaux
   qui les contiennent. Les totaux ne disparaissent pas : ils restent des colonnes
   du barème, réglables, parce qu'ils sont la seule chose qui donne encore des
   points aux journées d'avant l'entonnoir, celles où les catégories sont vides.

   CE QUI NE CHANGE PAS AU MOMENT OÙ TU LA PASSES

   Rien. La migration recopie les valeurs actuelles dans les catégories avant de
   remettre les totaux à zéro : un rendez-vous vaut le même nombre de points
   après qu'avant, un échange aussi. Le score de toutes les journées postérieures
   à l'entonnoir est rigoureusement identique.

   CE QUI CHANGE QUAND MÊME, ET IL FAUT LE SAVOIR

   Les journées ANTÉRIEURES À L'ENTONNOIR, celles où calls_connected ou
   meetings_booked était rempli alors que les six catégories étaient nulles,
   perdent ces points. Leur score baisse rétroactivement, et le « meilleur jour
   de tous les temps » peut changer de date. C'est une décision prise en connais-
   sance de cause le 30/08/2026, préférée à un barème que personne ne comprend.

   Pour savoir combien de journées sont touchées AVANT de lancer, voir la requête
   de contrôle tout en bas du fichier. Elle ne modifie rien.

   ORDRE : cette migration passe AVANT le code de la v30. Le code sans la
   migration écrit des colonnes qui n'existent pas et l'enregistrement du barème
   échoue. La migration sans le code fonctionne : les scores restent exacts, seul
   l'écran Barème continue de n'afficher que douze champs.

   IDEMPOTENTE : relançable sans dommage, SAUF l'étape 3, qui est protégée par un
   garde-fou explicite. Lire son commentaire.
   =========================================================================== */

begin;

/* ---------------------------------------------------------------------------
   1. LES SIX COLONNES
   Défaut à zéro, jamais nulles, comme les douze autres. L'étape 3 leur donne
   leur vraie valeur juste après.
   --------------------------------------------------------------------------- */
alter table public.score_weights
    add column if not exists calls_dead_end       integer not null default 0,
    add column if not exists calls_engaged_new    integer not null default 0,
    add column if not exists calls_engaged_known  integer not null default 0,
    add column if not exists meetings_rescheduled integer not null default 0,
    add column if not exists meetings_new         integer not null default 0,
    add column if not exists meetings_known       integer not null default 0;

comment on column public.score_weights.calls_dead_end is
    'Points par appel abouti sans échange. Le contact a décroché, la conversation n''a pas eu lieu.';
comment on column public.score_weights.calls_engaged_new is
    'Points par échange avec un nouveau contact. Première conversation, ou plus de 24 mois sans contact.';
comment on column public.score_weights.calls_engaged_known is
    'Points par échange avec un contact connu. Déjà une interaction dans les 24 derniers mois.';
comment on column public.score_weights.meetings_rescheduled is
    'Points par rendez-vous reprogrammé après une annulation.';
comment on column public.score_weights.meetings_new is
    'Points par rendez-vous obtenu auprès d''un nouveau contact.';
comment on column public.score_weights.meetings_known is
    'Points par rendez-vous obtenu auprès d''un contact connu.';

/* ---------------------------------------------------------------------------
   2. LES GARDE-FOUS

   Bornes : les six nouvelles colonnes suivent la même règle que les autres.
   Zéro est permis, il veut dire « ne compte pas ». Le négatif reste refusé :
   retirer des points pour une action déclarée serait apprendre à Santiago à ne
   pas la déclarer. Mille est un plafond de bon sens, pas une limite technique.

   Somme non nulle : la contrainte de la v8 protégeait le score de prospection
   d'un barème entièrement remis à zéro. Depuis la v14 elle regardait les mauvaises
   colonnes, puisque les points sont passés dans les catégories. Elle est réécrite
   pour regarder les deux, totaux et catégories. Les métriques du cycle de vente
   restent hors de la somme, comme en v9 : un poids nul y est un réglage légitime.
   --------------------------------------------------------------------------- */
alter table public.score_weights
    drop constraint if exists score_weights_bounds;

alter table public.score_weights
    add constraint score_weights_bounds check (
        calls_made           between 0 and 1000 and
        calls_connected      between 0 and 1000 and
        calls_engaged        between 0 and 1000 and
        meetings_booked      between 0 and 1000 and
        calls_dead_end       between 0 and 1000 and
        calls_engaged_new    between 0 and 1000 and
        calls_engaged_known  between 0 and 1000 and
        meetings_rescheduled between 0 and 1000 and
        meetings_new         between 0 and 1000 and
        meetings_known       between 0 and 1000 and
        emails_sent          between 0 and 1000 and
        companies_created    between 0 and 1000 and
        contacts_created     between 0 and 1000 and
        first_meetings       between 0 and 1000 and
        proposals_sent       between 0 and 1000 and
        no_go                between 0 and 1000 and
        deals_dropped        between 0 and 1000 and
        deals_lost           between 0 and 1000
    );

alter table public.score_weights
    drop constraint if exists score_weights_not_all_zero;

alter table public.score_weights
    add constraint score_weights_not_all_zero check (
        calls_made + calls_connected + calls_engaged + meetings_booked
        + calls_dead_end + calls_engaged_new + calls_engaged_known
        + meetings_rescheduled + meetings_new + meetings_known
        + emails_sent + companies_created + contacts_created > 0
    );

/* ---------------------------------------------------------------------------
   3. LE TRANSFERT

   Une seule instruction, et c'est volontaire : en SQL, la partie droite d'un
   UPDATE lit la ligne AVANT modification. Les six catégories reçoivent donc les
   anciennes valeurs des totaux dans le même souffle où les totaux passent à
   zéro, sans état intermédiaire et sans ordre à respecter.

   Ce qu'un échange valait : le poids « abouti » plus le poids « avec échange »,
   parce qu'un échange alimente les deux totaux. C'est exactement le nombre qui
   s'affiche aujourd'hui sur la pastille de la page de saisie.

   PAS IDEMPOTENTE, d'où le garde-fou. Relancée après coup, elle recopierait des
   zéros par-dessus les poids réglés depuis. Le WHERE l'empêche : dès que les
   totaux sont à zéro, il n'y a plus rien à transférer.

   Le déclencheur d'horodatage est mis en sommeil le temps de l'instruction. Sans
   ça, l'écran Barème afficherait « Dernière modification aujourd'hui, par
   personne » : auth.uid() est nul dans l'éditeur SQL, et une migration n'est pas
   une décision d'utilisateur.
   --------------------------------------------------------------------------- */
alter table public.score_weights disable trigger trg_score_weights_touch;

update public.score_weights set
    calls_dead_end       = calls_connected,
    calls_engaged_new    = calls_connected + calls_engaged,
    calls_engaged_known  = calls_connected + calls_engaged,
    meetings_rescheduled = meetings_booked,
    meetings_new         = meetings_booked,
    meetings_known       = meetings_booked,
    calls_connected      = 0,
    calls_engaged        = 0,
    meetings_booked      = 0
where calls_connected + calls_engaged + meetings_booked > 0;

alter table public.score_weights enable trigger trg_score_weights_touch;

/* ---------------------------------------------------------------------------
   4. LA VUE

   Le score serveur doit rester le jumeau exact du score calculé dans le
   navigateur par scoreOf(). Le tableau de bord et l'écran Équipe lisent
   productivity_score, la page de saisie calcule le sien : deux formules, un seul
   résultat, sans quoi le même jour affiche deux scores selon l'écran.

   coalesce sur la donnée ET sur le poids. Sur la donnée parce que les six
   colonnes de daily_activity sont nullables et le sont restées pour tout
   l'historique d'avant la v14 ; en SQL, un seul NULL dans une addition annule
   toute l'addition, et le score de ces journées serait devenu nul au lieu de
   baisser. Sur le poids parce que la jointure au barème est externe.

   Les valeurs de repli des trois totaux passent de 2, 4 et 25 à zéro : elles
   décrivent le modèle, et dans le nouveau modèle un total ne pèse rien.
   --------------------------------------------------------------------------- */
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
      /* Les trois totaux hérités. Leur poids est passé à zéro par la v30 : ils
         ne servent plus qu'aux journées d'avant l'entonnoir, où seul le total
         était rempli, et le jour où le propriétaire y remettrait un chiffre. */
      + d.calls_connected * coalesce(w.calls_connected, 0)
      + coalesce(d.calls_engaged, 0) * coalesce(w.calls_engaged, 0)
      + d.meetings_booked * coalesce(w.meetings_booked, 0)
      /* Les six catégories, qui portent désormais les points. coalesce sur la
         DONNÉE autant que sur le poids : ces colonnes sont nullables et le sont
         restées pour toutes les journées antérieures à la v14. */
      + coalesce(d.calls_dead_end, 0)       * coalesce(w.calls_dead_end, 2)
      + coalesce(d.calls_engaged_new, 0)    * coalesce(w.calls_engaged_new, 6)
      + coalesce(d.calls_engaged_known, 0)  * coalesce(w.calls_engaged_known, 6)
      + coalesce(d.meetings_rescheduled, 0) * coalesce(w.meetings_rescheduled, 25)
      + coalesce(d.meetings_new, 0)         * coalesce(w.meetings_new, 25)
      + coalesce(d.meetings_known, 0)       * coalesce(w.meetings_known, 25)
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

commit;

/* ---------------------------------------------------------------------------
   CONTRÔLE AVANT, À LANCER SÉPARÉMENT ET SANS RIEN VALIDER

   Combien de journées perdent des points, et combien elles en perdent. À lancer
   AVANT la migration, sinon les poids ont déjà changé et le calcul est faux.

   select count(*) as journees_touchees,
          sum(coalesce(calls_connected, 0) * 2
            + coalesce(calls_engaged, 0) * 4
            + coalesce(meetings_booked, 0) * 25) as points_perdus_environ
     from public.daily_activity
    where coalesce(calls_dead_end, 0) = 0
      and coalesce(calls_engaged_new, 0) = 0
      and coalesce(calls_engaged_known, 0) = 0
      and coalesce(meetings_rescheduled, 0) = 0
      and coalesce(meetings_new, 0) = 0
      and coalesce(meetings_known, 0) = 0
      and coalesce(calls_connected, 0) + coalesce(calls_engaged, 0)
        + coalesce(meetings_booked, 0) > 0;

   Remplace 2, 4 et 25 par tes poids réels si tu les as changés dans l'écran
   Barème.

   CONTRÔLE APRÈS

   select calls_made, calls_dead_end, calls_engaged_new, calls_engaged_known,
          meetings_rescheduled, meetings_new, meetings_known,
          calls_connected, calls_engaged, meetings_booked
     from public.score_weights;

   Les trois derniers doivent être à zéro, les six du milieu doivent porter ce
   que la page de saisie affichait hier sur ses pastilles.
   --------------------------------------------------------------------------- */
