/* ==========================================================================
   SAISIE.JS — Page de saisie quotidienne.
   Principe : aucune action de validation. Chaque clic ou frappe est persistée.

   Quatre chemins d'écriture :
     - boutons + / −  : bump_metric, incrément atomique côté base ;
     - frappe directe : set_metric, valeur exacte, anti-rebond de 600 ms ;
     - note du jour   : upsert classique, aucune contrainte ne la relie à rien ;
     - cycle de vente : insertion ou suppression d'une ligne dans sales_events.
       Aucun compteur n'est écrit sur ce chemin : depuis la migration v10, les
       cinq compteurs du cycle de vente sont le DÉCOMPTE de ces lignes, tenu par
       un trigger. La liste dit la vérité, le nombre en découle. C'est pourquoi
       ces cinq métriques n'ont ni bouton + / − ni champ numérique : ils
       laisseraient croire à un enregistrement que la base ignore.

   La frappe directe passait par le même upsert que la note. C'était le bogue
   du 24/08/2026 : PostgreSQL contrôle les contraintes CHECK sur la ligne
   proposée avant de résoudre le ON CONFLICT, donc un upsert ne portant que
   calls_connected était contrôlé avec calls_made à zéro, et la base refusait
   « plus d'aboutis que d'appels » sur une journée pourtant cohérente.

   Les écritures partent une par une, dans l'ordre où elles ont été
   programmées : deux écritures concurrentes sur les appels et les aboutis
   peuvent arriver dans le mauvais ordre et faire refuser une journée qui est
   cohérente à l'écran.
   ========================================================================== */

import {
    requireAuth, METRICS, EMPTY_DAY, METRIC_BY_KEY, todayISO,
    addDaysISO, formatLong, relativeLabel, diffDays, minISO, maxISO, fetchDay,
    saveDay, bump, setMetric, loadTargets, targetFor, targetsLoaded, humanError,
    SCORE_WEIGHTS, scoreOf, isViewingOther, viewedProfile, metricsFor,
    SALES_EVENT_KINDS, isEventMetric, cleanAccountName, accountKey,
    loadAccounts, searchAccounts, ensureAccount, accountByName, similarAccounts,
    fetchDayEvents, addSalesEvent, deleteSalesEvent,
    accountHistory, agoLabel, formatDMY,
    TARGET_SCALES, scaleOf, saveGaugeScale, periodBounds, periodLabel,
    fetchRange, joursOuvres, loadSettings,
    loadVisibility, targetVisible, setVisibility,
    fmtCible, auDixieme, canWriteViewed, metricScalesOf, saveMetricScales,
    DAY_PROFILE_KINDS, PROFILE_BY_KIND, profileTotal, fetchDayProfile, saveDayProfile
} from './api.js';
import { $, toast, fmtInt, fmtDec, delta, hideVeil, escapeHtml } from './ui.js';
import { renderNav } from './nav.js';

let session = null;
let day = todayISO();       // date en cours de saisie
let row = { ...EMPTY_DAY };  // valeurs affichées
let prevRow = null;          // veille, pour la comparaison
/* Plus de tableau d'objectifs local depuis la v12 : la résolution se fait à la
   demande par targetFor(), qui applique la règle « valeur de la personne, sinon
   de son métier, sinon aucun objectif ». Garder une copie ici obligerait à la
   tenir à jour, et une jauge qui affiche un objectif périmé est pire que pas de
   jauge. */

/* Compteurs de la personne dont on saisit la journée, pas les miens : quand un
   administrateur remplit la journée de quelqu'un d'autre, ce sont les compteurs
   de cette personne qui doivent s'afficher. Renseigné dans init(), après
   requireAuth() qui charge les profils. */
let myMetrics = METRICS;

/* --------------------------------------------------------------------------
   L'ÉCHELLE DE LECTURE (v13)

   Dominique ne compte pas ses rendez-vous à la journée : elle en veut dix-huit
   dans le mois. Une jauge journalière ne lui dit donc rien, et l'objectif
   mensuel posé en v12 restait invisible faute d'écran pour le lire.

   CE QUI CHANGE ET CE QUI NE CHANGE PAS. La saisie reste quotidienne, toujours,
   quelle que soit l'échelle : les champs et les boutons plus et moins portent sur
   le jour affiché, exactement comme avant. Seules les JAUGES changent d'échelle.
   C'est une décision, pas une facilité : une saisie qui se verrouille dès qu'on
   regarde le mois est une saisie qu'on remet à plus tard, et le seul test qui
   compte pour cet outil est que les chiffres soient saisis tous les jours.

   POURQUOI « HORS JOUR AFFICHÉ ». Le cumul de la période est stocké sans la
   journée en cours d'édition, et la jauge affiche « cumul hors jour + valeur du
   jour ». La valeur du jour vit déjà dans `row`, tenue à jour à chaque frappe :
   la jauge mensuelle avance donc à chaque clic sur « + » sans une requête de
   plus. Stocker le cumul complet aurait obligé à relire la période après chaque
   frappe, ou à bricoler un delta entre l'ancienne et la nouvelle valeur.

   NULL SE PROPAGE. Un compteur qu'aucune journée de la période n'a renseigné
   reste « non mesuré ». Le remplacer par zéro affirmerait un chiffre que
   personne n'a déclaré, ce que cet écran ne fait nulle part ailleurs.
   -------------------------------------------------------------------------- */

/* Valeur de départ écrasée par init() avant tout rendu, avec la préférence de la
   personne ou le défaut de scaleOf, qui est le mois depuis le 27/08. Elle n'est
   donc jamais à l'écran ; elle vaut 'day' pour que les fonctions appelées avant
   init, s'il en apparaissait un jour, ne demandent pas de cumul de période. */
let scale = 'day';           // 'day' | 'week' | 'month' | 'year' — le défaut de la page
let periodes = {};           // { échelle: { from, to } } pour les échelles réellement utilisées
let cumuls = {};             // { échelle: { métrique: nombre|null } }, jour affiché exclu

/* --------------------------------------------------------------------------
   UNE ÉCHELLE PAR COMPTEUR (v20)

   Le bandeau du haut donne le défaut, `echelles` porte les exceptions. Les
   appels se pilotent à la semaine, les rendez-vous au mois, le chiffre
   d'affaires à l'exercice : une échelle unique obligeait à choisir la moins
   mauvaise pour treize compteurs qui n'ont pas le même rythme.

   CONSÉQUENCE SUR LES DONNÉES. Il ne suffit plus d'un cumul, il en faut un par
   échelle affichée. Ils sont calculés en une SEULE requête, sur la plage qui
   englobe toutes les périodes en jeu, puis découpés en mémoire : demander
   quatre fois la base pour quatre échelles qui se chevauchent presque
   entièrement serait absurde, et l'exercice fiscal représente environ deux cent
   cinquante lignes, soit quelques dizaines de kilo-octets.
   -------------------------------------------------------------------------- */

let echelles = {};           // { métrique: échelle } — exceptions au défaut de la page

/** L'échelle de lecture d'un compteur : la sienne si elle existe, sinon celle de la page. */
function echelleDe(key) {
    return echelles[key] || scale;
}

/**
 * Les échelles réellement à l'écran, hors jour.
 *
 * Le jour n'a pas de cumul à calculer : la valeur affichée est celle de `row`,
 * qui suit la frappe en cours.
 */
function echellesAffichees() {
    const s = new Set();
    myMetrics.forEach(m => { const e = echelleDe(m.key); if (e !== 'day') s.add(e); });
    return [...s];
}

/** Combien de compteurs s'écartent du défaut de la page, parmi ceux affichés. */
function nbExceptions() {
    return myMetrics.filter(m => echelles[m.key] && echelles[m.key] !== scale).length;
}

/* Trois états à distinguer, sans quoi l'écran et la base finissent par
   raconter deux histoires différentes :
     - timers  : frappe programmée, pas encore envoyée (anti-rebond) ;
     - pending : valeur tapée et affichée, pas encore confirmée par la base.
       La ligne renvoyée par la base est fusionnée AVEC elle, sinon la réponse
       d'un champ écrase la frappe en cours d'un autre champ ;
     - blocked : valeur refusée faute de cohérence. Elle reste à l'écran et
       elle est rejouée dès que la journée redevient cohérente, plutôt que
       d'être perdue en silence. */
const timers = {};
const pending = {};
const blocked = {};
let inflight = 0;

/* Cycle de vente. `events` porte les lignes de la journée AFFICHÉE, du plus
   ancien au plus récent, telles qu'elles sont en base — sauf celles qui
   attendent leur confirmation, marquées `pending` et identifiées « tmp-n ».
   `hasEvents` évite deux requêtes et un carnet d'entreprises inutiles à un BDR,
   qui ne saisit aucun de ces cinq compteurs. */
let events = [];
let hasEvents = false;
let tmpSeq = 0;

/* État de la liste d'autocomplétion, une entrée par champ. `index` vaut -1
   quand aucune suggestion n'est sélectionnée, ce qui est l'état de départ et le
   plus important : voir onEventKey(). */
const sugg = {};

/* Question de ressemblance en attente, par compteur : { nom, proches }.
   Voir la section « Ressemblance » plus bas. */
const ask = {};

/* Le score est calculé côté client pour un affichage instantané, à partir de
   SCORE_WEIGHTS (source unique partagée avec le dashboard). La vue SQL
   v_daily_kpi reste la référence côté base. */

/* --------------------------------------------------------------------------
   Rendu des lignes de métriques
   -------------------------------------------------------------------------- */

/* Un compteur sans objectif n'a pas de jauge : afficher une barre vide et
   « non défini » sous un NO GO laisserait croire qu'on attend un chiffre.

   Écrite une fois et partagée par les deux sortes de lignes : les identifiants
   gauge-*, target-* et gauge-pct-* sont lus par paintGauge(), et deux gabarits
   qui les composent chacun de leur côté finiraient par ne plus les écrire
   pareil. */
/**
 * Les quatre lettres qui règlent l'échelle d'UN compteur : J, S, M, A.
 *
 * POURQUOI À LA PLACE DU TEXTE. La légende disait « Objectif : 40 du mois ».
 * Le texte est remplacé plutôt que complété : quatre lettres ET « du mois » sur
 * la même ligne, à côté de l'objectif et du pourcentage, ne tiennent pas dans
 * les colonnes étroites de l'entonnoir. Chaque lettre porte donc son intitulé
 * complet en info-bulle, et le bandeau du haut continue d'écrire l'échelle de
 * la page en toutes lettres.
 *
 * POURQUOI PAS data-act. La page branche l'incrémentation sur tout élément
 * portant data-act : une lettre d'échelle qui le porterait ajouterait un appel
 * au compteur à chaque changement de vue. Même précaution que pour l'œil de la
 * v16, et un test le vérifie.
 *
 * Ces boutons ne sont pas rendus quand l'objectif est masqué (v16), puisque
 * toute la jauge disparaît avec lui : sans objectif affiché, l'échelle de
 * lecture de l'objectif n'a plus d'objet.
 */
function echSegHtml(m) {
    const btn = sc => `<button type="button" class="ech-btn" data-ech="${sc.key}"
        data-ech-key="${m.key}" aria-pressed="false"
        title="Objectif ${escapeHtml(sc.article)}">${escapeHtml(sc.label[0])}</button>`;
    return `<span class="ech-seg" id="ech-${m.key}"
                  role="group" aria-label="Échelle de l'objectif">${TARGET_SCALES.map(btn).join('')}</span>`;
}

function gaugeHtml(m) {
    if (!m.target) return '';
    /* L'identifiant sur le conteneur, et pas seulement sur la barre : depuis la
       v16 un objectif peut être masqué, et c'est tout le bloc qui disparaît,
       légende et ligne de reste comprises. */
    return `
        <div class="gauge" id="gaugewrap-${m.key}">
            <div class="gauge-track">
                <div class="gauge-fill" id="gauge-${m.key}" style="width:0%"></div>
                <i class="gauge-mark" id="gaugemark-${m.key}" hidden></i>
            </div>
            <div class="gauge-legend">
                <span>Objectif : <b id="target-${m.key}">–</b>${echSegHtml(m)}</span>
                <span id="gauge-pct-${m.key}">0 %</span>
            </div>
            <div class="gauge-rest" id="gauge-rest-${m.key}" hidden></div>
        </div>`;
}

/**
 * L'œil qui montre ou masque l'objectif d'un compteur (v16).
 *
 * POURQUOI IL RESTE VISIBLE UNE FOIS L'OBJECTIF MASQUÉ. C'est le seul chemin de
 * retour : si l'œil disparaissait avec la jauge, le réglage serait sans marche
 * arrière et il faudrait aller le défaire ailleurs. Masqué, il se barre d'un
 * trait et son libellé devient « Afficher cet objectif ».
 *
 * PAS D'ŒIL QUAND ON CONSULTE QUELQU'UN D'AUTRE. Un administrateur qui ouvre la
 * journée d'un membre voit ce que ce membre voit, et ne peut pas régler son
 * écran d'un clic distrait. Le forçage se fait dans l'écran « Barème et
 * objectifs », où il est explicite et où il porte un nom.
 *
 * Pas d'œil non plus sur un compteur sans objectif possible : il n'y aurait rien
 * à montrer ni à cacher.
 */
function oeilHtml(m) {
    /* v19 : l'œil reste à l'écran en consultation. Il fait partie de la vue de
       la personne, et son état (barré ou non) dit quelque chose d'utile sur ce
       qu'elle a choisi de regarder. Le clic, lui, reste soumis au droit
       d'écrire, que basculeObjectif vérifie. */
    if (!m.target) return '';
    return `
        <button class="oeil" type="button" id="oeil-${m.key}" data-oeil="${m.key}"
                aria-pressed="false" title="Masquer cet objectif"
                aria-label="Masquer l'objectif : ${escapeHtml(m.label)}">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M1.8 12S5.4 5.8 12 5.8 22.2 12 22.2 12 18.6 18.2 12 18.2 1.8 12 1.8 12Z"/>
                <circle cx="12" cy="12" r="3.1"/>
                <line class="oeil-barre" x1="4.5" y1="19.5" x2="19.5" y2="4.5"/>
            </svg>
        </button>`;
}

/**
 * Un total calculé : le chiffre, sa jauge, et pas de quoi le modifier.
 *
 * Ni bouton plus, ni champ. Le total est écrit par la base
 * (trg_daily_activity_entonnoir) et metric_allowed() refuse qu'un client y
 * touche : un stepper afficherait 20 pendant une seconde avant de retomber à 19,
 * ce qui est pire que pas de stepper du tout. C'est exactement le raisonnement
 * qui a retiré les boutons des compteurs du cycle de vente en v10.
 *
 * Il reste affiché parce que c'est ce qui permet de vérifier sa saisie d'un coup
 * d'œil : trois issues déclarées et un total qui ne correspond pas à ce qu'on
 * croyait, ça se voit immédiatement.
 *
 * DEUX GABARITS, LES MÊMES IDENTIFIANTS. totalHeadHtml() range le total dans
 * l'en-tête de son étage, à droite du titre : c'est la version utilisée par
 * l'entonnoir depuis la v15, et c'est ce qui a supprimé deux grandes lignes de la
 * hauteur de la page. totalRowHtml() garde l'ancienne présentation en ligne pour
 * un total qui n'appartiendrait à aucun étage. Les deux écrivent total-<clé> et
 * la jauge de gaugeHtml() : paint() et paintGauge() n'ont pas à savoir lequel des
 * deux a été rendu.
 */
function totalHeadHtml(m) {
    const parts = (m.derived || []).length;
    return `
    <div class="etage-tot" data-metric="${m.key}">
        <div class="etage-tot-num">
            <b id="total-${m.key}">0</b>
            <div>
                <span>${escapeHtml(m.label)}</span>
                <small>somme des ${parts} ci-contre</small>
            </div>
            ${oeilHtml(m)}
        </div>
        ${gaugeHtml(m)}
    </div>`;
}

function totalRowHtml(m) {
    const parts = (m.derived || []).length;
    return `
    <div class="metric metric--total" data-metric="${m.key}">
        <div class="metric-top">
            <div class="metric-label">
                <b>${escapeHtml(m.label)}</b>
                <span>${escapeHtml(m.hint)}</span>
            </div>
            <div class="metric-total-val">
                <b id="total-${m.key}">0</b>
                <small>somme de ${parts}</small>
            </div>
            ${oeilHtml(m)}
        </div>
        ${gaugeHtml(m)}
    </div>`;
}

/**
 * Compteur ordinaire : un libellé, un stepper, une jauge.
 *
 * TROIS PRÉSENTATIONS POUR UN SEUL GABARIT, choisies par l'appelant :
 *
 *   ''      liste verticale, telle qu'elle était avant la v15. Le CRM et les
 *           sorties de pipeline, où les compteurs n'ont pas de structure entre
 *           eux, s'en contentent très bien.
 *   'wide'  une seule ligne, du libellé à gauche à la jauge à droite. Réservée
 *           aux compteurs seuls de leur ligne : les appels passés, les e-mails.
 *           Trois zones côte à côte au lieu de trois empilées, donc trois fois
 *           moins de hauteur.
 *   'col'   une carte en colonne, stepper pleine largeur sous le libellé. C'est
 *           la présentation des issues de l'étage 2 et des rendez-vous de
 *           l'étage 3, celles qui se comparent entre elles.
 *
 * Le stepper pleine largeur en colonne n'est pas décoratif : le + devient une
 * cible de plus de deux cents pixels, ce qui compte sur un téléphone tenu d'une
 * main entre deux appels, et c'est ce geste-là qui décide si les chiffres sont
 * saisis ou non.
 */
function metricRowHtml(m, variante) {
    const v = variante ? ` metric--${variante}` : '';
    return `
    <div class="metric${v}" data-metric="${m.key}">
        <div class="metric-top">
            <div class="metric-label">
                <b>${escapeHtml(m.label)}</b>
                <span>${escapeHtml(m.hint)}</span>
            </div>
            ${oeilHtml(m)}
            <div class="stepper">
                <button class="stepper-btn stepper-btn--minus" type="button"
                        data-act="dec" data-key="${m.key}" aria-label="Retirer 1 ${escapeHtml(m.label)}">−</button>
                <input class="metric-input" type="number" inputmode="numeric" min="0" step="1"
                       id="in-${m.key}" data-key="${m.key}" value="0"
                       aria-label="${escapeHtml(m.label)}">
                <button class="stepper-btn stepper-btn--plus" type="button"
                        data-act="inc" data-key="${m.key}" aria-label="Ajouter 1 ${escapeHtml(m.label)}">+</button>
            </div>
        </div>
        ${gaugeHtml(m)}
    </div>`;
}

/**
 * Ligne d'un compteur du cycle de vente : une liste de ce qui a été déclaré, et
 * un seul champ pour en ajouter.
 *
 * Pas de bouton +, pas de champ numérique. Ce n'est pas un choix de style :
 * depuis la v10, écrire dans ces cinq colonnes n'a plus aucun effet, la base
 * les recalcule à partir des lignes. Un bouton + afficherait 3 pendant une
 * seconde puis retomberait à 2, ce qui est pire que pas de bouton du tout.
 *
 * Le champ reste UN champ par type, et non un champ unique avec un sélecteur de
 * type : la question « qu'est-ce que j'ajoute » se répond en regardant où l'on
 * tape, pas en manipulant une liste déroulante de plus.
 */
function eventRowHtml(m) {
    return `
    <div class="metric metric--events" data-metric="${m.key}">
        <div class="metric-top">
            <div class="metric-label">
                <b>${escapeHtml(m.label)}</b>
                <span>${escapeHtml(m.hint)}</span>
            </div>
            ${oeilHtml(m)}
            <div class="event-count"><b id="count-${m.key}">0</b></div>
        </div>
        <ul class="event-list" id="list-${m.key}"></ul>
        <div class="event-add">
            <label class="sr-only" for="ev-${m.key}">Ajouter : ${escapeHtml(m.label)}</label>
            <input class="event-input" type="text" id="ev-${m.key}" data-key="${m.key}"
                   autocomplete="off" spellcheck="false" maxlength="120"
                   enterkeyhint="done" role="combobox" aria-expanded="false"
                   aria-autocomplete="list" aria-controls="sugg-${m.key}"
                   placeholder="Nom du client, puis Entrée">
            <div class="event-sugg" id="sugg-${m.key}" role="listbox" hidden></div>
        </div>
        <p class="event-help"><b>Entrée</b> ajoute la ligne. Sans nom, elle compte quand même.</p>
        <div class="event-ask" id="ask-${m.key}" role="alert" hidden></div>
        <div class="event-warn" id="warn-${m.key}" role="status" aria-live="polite" hidden></div>
        ${gaugeHtml(m)}
    </div>`;
}

/* Les cartes dépendent du métier : un BDR ne voit pas le cycle de vente, un
   commercial ne voit ni les entreprises créées ni les e-mails. Une carte sans
   aucun compteur est masquée plutôt que laissée vide, et il en va de même des
   sous-cartes de la carte Prospection : depuis la v15 data-sub-for porte la
   sous-carte entière et non son seul titre, donc c'est le cadre qui disparaît. On masque en style plutôt qu'en
   supprimant : les éléments de total restent dans le document, ce qui évite un
   garde-fou dans chaque fonction d'affichage. */
function ligneHtml(m, variante) {
    if (isEventMetric(m.key)) return eventRowHtml(m);
    if (m.derived) return totalRowHtml(m);
    return metricRowHtml(m, variante);
}

/* Libellés des trois étages. Écrits ici et non dans METRICS : ils décrivent le
   déroulé d'un appel, pas un compteur, et le même mot « étage » n'aurait aucun
   sens dans les groupes CRM ou cycle de vente. */
const ETAGES = {
    1: { titre: 'Ce que j\'ai lancé', sous: 'Tous les appels passés, aboutis ou non' },
    2: { titre: "J'ai eu quelqu'un", sous: 'Trois issues, jamais deux fois le même appel' },
    3: { titre: "J'ai obtenu un rendez-vous", sous: "Trois catégories, jamais deux fois le même rendez-vous" }
};

function buildCards() {
    ['crm', 'calls', 'emails', 'pipeline', 'outcome'].forEach(group => {
        const host = document.querySelector(`[data-metrics="${group}"]`);
        if (!host) return;
        const list = myMetrics.filter(m => m.group === group);

        /* LE GROUPE DES APPELS EST RENDU EN GRILLE, pas en liste.

           Dix compteurs empilés dans une colonne de trois cent cinquante pixels,
           c'est huit cents pixels de haut et trois écrans de défilement : ce que
           quelqu'un abandonne au troisième jour. En v15 la carte Prospection
           occupe toute la largeur et chaque étage devient une LIGNE :

             étage 1  une seule ligne large, les appels passés
             étage 2  trois colonnes, les trois issues d'un appel décroché
             étage 3  trois colonnes, les trois catégories de rendez-vous

           Le total de l'étage est remonté DANS SON EN-TÊTE, à droite du titre,
           au lieu d'occuper une quatrième grande ligne sous les colonnes. Deux
           gains dans le même geste : la hauteur de deux blocs en moins, et le
           total placé là où on le cherche, en face de l'intitulé de l'étage.

           Le nombre de colonnes n'est pas écrit ici. Le CSS le déduit du nombre
           de compteurs avec un auto-fit, parce que ce nombre dépend du métier
           affiché : un étage à trois compteurs pour un BDR peut n'en avoir qu'un
           pour un commercial, et une grille à trois colonnes fixes lui aurait
           laissé deux trous.

           Un étage dont aucun compteur ne concerne le métier affiché n'est pas
           rendu du tout : un commercial n'a pas de rendez-vous obtenus, il ne
           voit donc pas d'étage 3 vide.

           Classes nommées « etage » et non « funnel-step » : app.css a déjà un
           .funnel-step, qui est l'entonnoir horizontal du tableau de bord et vaut
           display:flex. Mes étages s'y seraient rangés côte à côte au lieu de
           s'empiler, et cela ne se serait vu qu'à l'écran. */
        if (group === 'calls' && list.some(m => m.level)) {
            const etages = [1, 2, 3].map(n => {
                const dedans = list.filter(m => m.level === n);
                if (!dedans.length) return '';
                const e = ETAGES[n];
                const totaux = dedans.filter(m => m.derived);
                const saisis = dedans.filter(m => !m.derived);
                /* Un compteur seul dans son étage se lit en ligne large ; à
                   plusieurs, ils se comparent, donc ils se rangent en colonnes. */
                const variante = saisis.length > 1 ? 'col' : 'wide';
                return `
                <section class="etage" data-level="${n}">
                    <div class="etage-head">
                        <span class="etage-num">${n}</span>
                        <div class="etage-titre">
                            <b>${escapeHtml(e.titre)}</b>
                            <span>${escapeHtml(e.sous)}</span>
                        </div>
                        ${totaux.map(totalHeadHtml).join('')}
                    </div>
                    <div class="etage-cols" data-cols="${saisis.length}">
                        ${saisis.map(m => ligneHtml(m, variante)).join('')}
                    </div>
                </section>`;
            }).join('');
            // Les compteurs sans étage — calls_engaged est masqué, mais la règle
            // vaut pour toute métrique du groupe qui n'appartiendrait à aucun
            // étage — sont rendus à la suite plutôt que perdus.
            const hors = list.filter(m => !m.level).map(m => ligneHtml(m, 'wide')).join('');
            host.innerHTML = etages + hors;
        } else if (group === 'emails') {
            // Un seul compteur, et une carte pleine largeur pour l'accueillir :
            // la ligne large évite d'empiler libellé, stepper et jauge sur trois
            // niveaux dans un espace qui en tient un.
            host.innerHTML = list.map(m => ligneHtml(m, 'wide')).join('');
        } else {
            host.innerHTML = list.map(m => ligneHtml(m)).join('');
        }

        const titre = document.querySelector(`[data-sub-for="${group}"]`);
        if (titre) titre.style.display = list.length ? '' : 'none';
    });

    document.querySelectorAll('[data-card]').forEach(carte => {
        if (!carte.querySelector('.metric')) carte.style.display = 'none';
    });

    // Boutons + / −
    document.querySelectorAll('[data-act]').forEach(btn => {
        btn.addEventListener('click', () => onBump(btn.dataset.key, btn.dataset.act === 'inc' ? 1 : -1));
    });

    /* L'œil qui montre ou masque un objectif. Attribut distinct de data-act, et
       ce n'est pas un détail : la ligne au-dessus branche onBump() sur TOUT ce
       qui porte data-act, un œil ainsi nommé aurait incrémenté le compteur. */
    document.querySelectorAll('[data-oeil]').forEach(btn => {
        btn.addEventListener('click', () => basculeObjectif(btn.dataset.oeil));
    });

    /* Les quatre lettres d'échelle. Même précaution que pour l'œil : l'attribut
       n'est pas data-act, sans quoi chaque changement de vue passerait un appel
       de plus au compteur. */
    document.querySelectorAll('[data-ech]').forEach(btn => {
        btn.addEventListener('click', () => setEchelleMetrique(btn.dataset.echKey, btn.dataset.ech));
    });

    // Saisie directe au clavier
    document.querySelectorAll('.metric-input').forEach(input => {
        input.addEventListener('input', () => onType(input));
        input.addEventListener('focus', () => input.select());
        input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    });

    // Cycle de vente : un champ, une liste de suggestions, et la touche Entrée.
    document.querySelectorAll('.event-input').forEach(inp => {
        const key = inp.dataset.key;
        inp.addEventListener('input', () => openSugg(key, inp.value));
        inp.addEventListener('keydown', e => onEventKey(inp, e));
        // Le délai laisse passer un clic sur une suggestion en tactile, où
        // l'ordre des événements n'est pas celui de la souris.
        inp.addEventListener('blur', () => setTimeout(() => closeSugg(key), 140));
        const box = document.getElementById(`sugg-${key}`);
        if (!box) return;
        // mousedown et non click : le click arrive après le blur du champ, donc
        // après la fermeture de la liste, et ne trouverait plus sa cible.
        box.addEventListener('mousedown', ev => {
            const item = ev.target.closest('[data-i]');
            if (!item) return;
            ev.preventDefault();          // garde le focus dans le champ
            const choisie = suggState(key).list[Number(item.dataset.i)];
            closeSugg(key);
            inp.value = '';
            // Cliquer sur une entreprise déjà connue est un choix explicite :
            // aucune question de ressemblance à poser. Cliquer sur « Nouveau »
            // en pose une, comme la touche Entrée.
            if (choisie) submitEvent(key, choisie.name, { force: !!choisie.id });
            inp.focus();
        });
    });

    // Fermeture des avertissements de doublon. Délégué sur la carte : le contenu
    // du bloc est réécrit à chaque alerte, un écouteur posé sur le bouton
    // disparaîtrait avec lui.
    document.querySelectorAll('.metric--events').forEach(bloc => {
        bloc.addEventListener('click', ev => {
            const b = ev.target.closest('[data-warn-close]');
            if (b) { hideWarn(b.dataset.warnClose); return; }

            // Réponse à une question de ressemblance. Les deux boutons mènent à
            // une ligne enregistrée : l'un chez l'entreprise déjà connue,
            // l'autre chez celle qu'on vient de taper. Aucun chemin ne fait
            // perdre la saisie.
            const use = ev.target.closest('[data-ask-use]');
            if (use) {
                const key = use.dataset.askKey;
                const nom = (ask[key]?.proches || [])[Number(use.dataset.askUse)]?.name;
                hideAsk(key);
                if (nom) submitEvent(key, nom, { force: true });
                document.getElementById(`ev-${key}`)?.focus();
                return;
            }
            const neuf = ev.target.closest('[data-ask-new]');
            if (neuf) {
                const key = neuf.dataset.askNew;
                const nom = ask[key]?.nom;
                hideAsk(key);
                if (nom) submitEvent(key, nom, { force: true });
                document.getElementById(`ev-${key}`)?.focus();
            }
        });
    });

    $('#day-notes').addEventListener('input', e => {
        const v = e.target.value;
        const iso = day;   // journée figée ici : voir onType()
        row.notes = v;
        schedule('notes', () => enqueue(() => persist({ notes: v }, iso)), 900);
    });
}

/* --------------------------------------------------------------------------
   Écriture
   -------------------------------------------------------------------------- */

function status(text, kind = '') {
    const el = $('#save-status');
    el.className = 'date-status' + (kind ? ` date-status--${kind}` : '');
    el.textContent = text;
}

/** Une écriture à la fois, dans l'ordre de programmation. */
let chain = Promise.resolve();
function enqueue(job) {
    chain = chain.then(job, job);
    return chain;
}

function schedule(key, run, ms = 600) {
    cancel(key);
    timers[key] = { run, id: setTimeout(() => { timers[key] = null; run(); }, ms) };
}

function cancel(key) {
    const t = timers[key];
    if (t) { clearTimeout(t.id); timers[key] = null; }
}

/** Envoie sans attendre la fin de l'anti-rebond. */
function flush(key) {
    const t = timers[key];
    if (!t) return;
    clearTimeout(t.id);
    timers[key] = null;
    t.run();
}

/** État de sauvegarde affiché, une fois la file vidée. */
function settle() {
    if (inflight > 0) { status('Enregistrement…', 'saving'); return; }
    if (Object.keys(blocked).length) { status('⚠ Non enregistré', 'error'); return; }
    status('✓ Enregistré', 'saved');
}

/* --------------------------------------------------------------------------
   LA SEULE INCOHÉRENCE POSSIBLE, DEPUIS LA v14

   L'ancienne version surveillait une chaîne : échanges <= aboutis <= appels.
   Elle n'a plus d'objet. Les trois issues de l'étage 2 sont disjointes, aucune
   n'est bornée par une autre, et « aboutis » n'est plus saisi mais calculé — il
   ne peut donc plus être incohérent avec quoi que ce soit.

   Reste une règle, celle que la base impose sous le nom
   daily_activity_etage2_coherent : on ne peut pas avoir joint plus de personnes
   qu'on a passé d'appels. Elle se déclenche dans deux situations, et le message
   doit les distinguer, parce que le geste à faire n'est pas le même : soit on
   déclare une issue de trop, soit on fait redescendre le nombre d'appels sous ce
   qui est déjà déclaré.

   Le contrôle porte sur ce qui est à l'écran, frappe en attente comprise, et non
   sur ce que la base contient : sinon deux clics rapides passeraient le premier
   contrôle et se feraient refuser par la base, ce qui donne un message d'erreur
   là où une phrase claire suffisait.
   -------------------------------------------------------------------------- */

const ETAGE2 = [
    { key: 'calls_dead_end',      label: 'sans échange' },
    { key: 'calls_engaged_new',   label: 'échanges avec un nouveau contact' },
    { key: 'calls_engaged_known', label: 'échanges avec un contact connu' }
];

function incoherence(key, v) {
    const estEtage2 = ETAGE2.some(x => x.key === key);
    if (key !== 'calls_made' && !estEtage2) return null;

    const val = k => (k === key ? v : Number(row[k]) || 0);
    const appels = val('calls_made');
    const joints = ETAGE2.reduce((n, x) => n + val(x.key), 0);
    if (joints <= appels) return null;

    if (estEtage2) {
        return `${fmtInt(joints)} appels décrochés pour ${fmtInt(appels)} appels passés : `
             + `saisissez d'abord le nombre d'appels, la valeur sera enregistrée juste après.`;
    }

    // On tente de faire descendre le nombre d'appels sous ce qui est déclaré.
    const detail = ETAGE2.filter(x => val(x.key) > 0)
        .map(x => `${fmtInt(val(x.key))} ${x.label}`).join(', ');
    return `${detail} sont déjà saisis, soit ${fmtInt(joints)} appels décrochés : le nombre `
         + `d'appels passés ne peut pas descendre à ${fmtInt(appels)}. Corrigez les issues d'abord.`;
}

/** Vrai si la base a refusé au nom de la cohérence de l'étage 2. */
function isCoherence(e) {
    /* Le nom de contrainte a changé en v14 : daily_activity_calls_coherent et
       daily_activity_engaged_coherent ont laissé place à
       daily_activity_etage2_coherent. Les trois motifs sont reconnus, le temps
       qu'aucun onglet resté ouvert depuis hier ne parle encore l'ancien nom. */
    return !!e && (e.code === '23514'
        || /calls_coherent|engaged_coherent|etage2_coherent/.test(e.message || ''));
}

/** La base a répondu : ses valeurs font foi, sauf celles encore en attente. */
function applyRow(saved, iso) {
    if (!saved || iso !== day) return;   // la journée affichée a changé entre-temps
    row = { ...saved, ...pending };
    paint();
}

/** Rejoue les valeurs refusées qui sont redevenues possibles. */
function retryBlocked() {
    Object.entries(blocked).forEach(([key, v]) => {
        if (incoherence(key, v)) return;
        delete blocked[key];
        pending[key] = v;
        const iso = day;
        schedule(key, () => enqueue(() => setOne(key, v, iso)), 150);
    });
}

/* --------------------------------------------------------------------------
   Mode correction

   Un administrateur peut écrire dans le compte d'un commercial, mais jamais
   sans le savoir. Une confirmation est demandée une seule fois par session de
   travail, avant la première écriture : redemander à chaque bouton rendrait la
   correction d'une journée entière insupportable, ne rien demander du tout
   ramènerait le risque de l'ancien sélecteur permanent.
   -------------------------------------------------------------------------- */

let fixConfirmed = false;

function allowWrite() {
    if (!isViewingOther()) return true;

    /* Le droit réel avant la question : demander « continuer ? » à quelqu'un
       qui n'a pas le droit d'écrire ne sert qu'à lui faire découvrir le refus
       une seconde plus tard, sous forme d'erreur de permission. */
    if (!canWriteViewed()) {
        const v = viewedProfile();
        toast(`Vous voyez l'écran de ${v.display_name || 'cette personne'}, `
            + `mais seul le propriétaire du Cockpit peut y modifier quelque chose.`,
            'error', 6000);
        return false;
    }
    if (fixConfirmed) return true;

    const v = viewedProfile();
    const name = v.display_name || v.email || 'cet utilisateur';
    const ok = confirm(
        `Vous allez modifier le compte de ${name}.\n\n`
        + `Journée concernée : ${formatLong(day)}.\n\n`
        + `Vos modifications seront enregistrées sur son compte et signalées `
        + `comme une correction dans son historique.\n\nContinuer ?`);
    if (ok) {
        fixConfirmed = true;
        status('Mode correction actif', 'saving');
    }
    return ok;
}

/** Adapte l'en-tête de la page quand on corrige le compte de quelqu'un. */
function renderIdentity() {
    if (!isViewingOther()) return;
    const v = viewedProfile();
    const name = v.display_name || v.email || 'cet utilisateur';

    /* v19 : LA PAGE N'EST PLUS RÉÉCRITE.
       Elle affichait « Corriger la saisie de X » à la place du titre habituel,
       avec un paragraphe d'avertissement en dessous. Résultat : on regardait un
       écran qui n'était pas celui de la personne, alors que le but même de la
       consultation est de voir ce qu'elle voit, avec ses compteurs, ses jauges
       et ses réglages.
       L'avertissement n'a pas disparu pour autant, il a changé de place : la
       barre de contexte de nav.js le porte, en haut de page, sur toutes les
       pages, et pas seulement sur celle-ci.
       Le titre de l'ONGLET du navigateur, lui, garde le nom : c'est invisible
       dans la page, et c'est ce qui permet de s'y retrouver quand trois fiches
       sont ouvertes côte à côte. */
    document.title = `${name} | Cockpit BDR — Fluxym`;
}

/** Écriture de la note du jour. Réservée aux colonnes libres de contrainte. */
async function persist(patch, iso) {
    if (!allowWrite()) return;
    inflight++;
    status('Enregistrement…', 'saving');
    let resync = false;
    try {
        applyRow(await saveDay(iso, patch, session), iso);
    } catch (e) {
        toast(humanError(e), 'error', 5000);
        resync = true;
    }
    inflight--;
    settle();
    if (resync) await load(day);   // on resynchronise sur la vérité de la base
}

/** Écriture d'une valeur exacte sur une métrique. */
async function setOne(key, v, iso) {
    if (!allowWrite()) return;
    inflight++;
    status('Enregistrement…', 'saving');
    let ok = false;
    let resync = false;
    try {
        const saved = await setMetric(key, v, iso);
        if (pending[key] === v) delete pending[key];
        delete blocked[key];
        applyRow(saved, iso);
        ok = true;
    } catch (e) {
        toast(humanError(e), 'error', 6000);
        // Refus de cohérence : la valeur reste à l'écran et sera rejouée dès
        // que la journée le permettra. Toute autre erreur veut dire que l'on
        // ne sait plus ce que contient la base : on relit.
        if (isCoherence(e)) blocked[key] = v;
        else resync = true;
    }
    inflight--;
    settle();
    if (resync) { await load(day); return; }
    if (ok) retryBlocked();
}

function onBump(key, d) {
    /* Les cinq compteurs du cycle de vente n'ont plus de bouton + / − : ce
       garde-fou n'existe que pour qu'un câblage fait par erreur ne parte pas
       vers une base qui ignorerait l'écriture en silence. */
    if (isEventMetric(key)) return;
    const before = Number(row[key]) || 0;
    if (d < 0 && before === 0) return;
    const next = Math.max(0, before + d);

    const refus = incoherence(key, next);
    if (refus) { toast(refus, 'error', 7000); return; }
    if (!allowWrite()) return;

    const iso = day;
    // Une frappe encore en attente sur ce champ part avant l'incrément, sinon
    // la base incrémenterait une valeur que l'écran a déjà oubliée.
    flush(key);
    delete pending[key];
    delete blocked[key];

    // Retour visuel immédiat, correction si la base refuse.
    row[key] = next;
    paint();
    showValue(key);
    flash(key);
    inflight++;
    status('Enregistrement…', 'saving');

    enqueue(async () => {
        try {
            applyRow(await bump(key, d, iso), iso);
            if (iso === day) showValue(key);
            inflight--;
            settle();
            retryBlocked();
        } catch (e) {
            inflight--;
            if (iso === day) { row[key] = before; paint(); showValue(key); }
            settle();
            toast(humanError(e), 'error', 5000);
        }
    });
}

function onType(input) {
    const key = input.dataset.key;
    if (isEventMetric(key)) return;   // même raison que dans onBump()
    // La journée visée est figée ici. Sans cela, changer de jour pendant
    // l'anti-rebond écrivait la valeur sur la mauvaise date.
    const iso = day;
    let v = parseInt(input.value, 10);
    if (Number.isNaN(v) || v < 0) v = 0;
    if (v > 9999) v = 9999;

    pending[key] = v;
    row[key] = v;
    paintDerived();
    paintGauge(METRIC_BY_KEY[key]);

    const refus = incoherence(key, v);
    if (refus) {
        cancel(key);
        blocked[key] = v;
        status('⚠ Non enregistré', 'error');
        toast(refus, 'error', 7000);
        return;
    }
    delete blocked[key];
    schedule(key, () => enqueue(() => setOne(key, v, iso)));
}

/**
 * Écrit la valeur dans le champ, focus ou pas. paint() épargne le champ actif
 * pour ne pas écraser une frappe en cours, mais un clic sur + ou − est une
 * intention explicite : si le champ gardait l'ancien nombre, l'écran et la base
 * afficheraient deux chiffres différents.
 */
/** Valeur à afficher dans un champ : vide quand la journée n'a pas été mesurée. */
function inputValue(key) {
    return row[key] == null ? '' : String(Number(row[key]) || 0);
}

function showValue(key) {
    const el = document.getElementById(`in-${key}`);
    if (el) el.value = inputValue(key);
}

function flash(key) {
    const el = document.getElementById(`in-${key}`);
    if (!el) return;
    el.classList.remove('metric-input--flash');
    void el.offsetWidth;
    el.classList.add('metric-input--flash');
}

/* --------------------------------------------------------------------------
   Cycle de vente : des lignes nommées plutôt qu'un compteur

   Le principe, décidé avec Bruno le 26/08/2026 : la liste dit la vérité, le
   nombre en découle. Nommer l'entreprise n'est pas obligatoire — la contrainte
   du Cockpit n'a jamais été de tout documenter, elle est de saisir tous les
   jours — mais c'est ce qui rendra les statistiques par client possibles, et
   c'est ce qui permettra d'avertir qu'une proposition est déjà partie chez le
   même client.

   L'affichage est optimiste : la ligne apparaît avant la réponse de la base,
   grisée, puis se fige ou disparaît. Sans cela, chaque ajout attendrait un
   aller-retour, et la saisie d'une journée de commercial deviendrait pénible.
   -------------------------------------------------------------------------- */

function eventItemHtml(e) {
    const id = escapeHtml(String(e.id));
    const nom = e.account_name
        ? `<span class="event-name">${escapeHtml(e.account_name)}</span>`
        : '<span class="event-name event-name--anon">client non nommé</span>';
    return `
    <li class="event-item${e.pending ? ' event-item--pending' : ''}" data-id="${id}">
        ${nom}
        <button class="event-del" type="button" data-del="${id}"${e.pending ? ' disabled' : ''}
                title="Supprimer cette ligne" aria-label="Supprimer cette ligne">×</button>
    </li>`;
}

/**
 * Repeint les cinq listes, puis réaligne `row` sur elles.
 *
 * L'ordre compte : c'est la LISTE qui met à jour row, jamais l'inverse. C'est
 * exactement la règle que le trigger applique en base, et c'est la seule façon
 * que le compteur affiché, le total de la carte et le score du jour racontent
 * la même histoire.
 *
 * Cette fonction ne touche jamais au champ de saisie ni à la liste de
 * suggestions : ils sont construits une fois par buildCards() et jamais
 * reconstruits, sinon un repeint pendant la frappe ferait perdre le focus et
 * les caractères en cours.
 */
function paintEventLists() {
    if (!hasEvents) return;
    SALES_EVENT_KINDS.forEach(key => {
        const host = document.getElementById(`list-${key}`);
        if (!host) return;
        const lignes = events.filter(e => e.kind === key);
        host.innerHTML = lignes.map(eventItemHtml).join('');
        row[key] = lignes.length;
        const m = METRIC_BY_KEY[key];
        if (m) paintGauge(m);
    });
    // Les boutons viennent d'être recréés en bloc : aucun risque de double écoute.
    document.querySelectorAll('.event-del').forEach(b => {
        b.addEventListener('click', () => removeEvent(b.dataset.del));
    });
    paintDerived();
}

/**
 * Ajoute une ligne. `saisi` vide est un cas normal et non une erreur : Entrée
 * sur un champ vide déclare un événement sans nommer le client.
 *
 * Le nom finalement retenu peut différer de ce qui a été tapé, parce que
 * ensureAccount() rattache « airbus » à « Airbus » déjà connu. C'est tout
 * l'intérêt du dispositif, donc on le DIT : un rattachement silencieux
 * laisserait croire à une faute de frappe de l'application.
 */
/* --- Ressemblance : « carefour » alors que CARREFOUR existe -----------------

   Cas réel du 26 août : le nom a été créé sans que rien ne le signale, et
   l'autocomplétion ne pouvait pas aider puisqu'elle cherche par début de nom.
   Deux entreprises pour un seul client, c'est un carnet qui se dégrade et des
   statistiques par client fausses avant d'exister.

   TROIS PARTIS PRIS.

   1. LA QUESTION EST POSÉE AVANT LA CRÉATION, pas après. Corriger ensuite
      demanderait de supprimer la ligne, de supprimer l'entreprise créée, puis
      de tout resaisir. Une seconde d'attente au bon moment coûte moins cher.

   2. CE N'EST PAS UN BLOCAGE, C'EST UNE QUESTION À DEUX RÉPONSES. « Utiliser
      CARREFOUR » et « Créer carefour » mènent tous deux à une ligne
      enregistrée. Rien n'est perdu, rien n'est imposé : deux sociétés peuvent
      réellement porter des noms voisins, et l'application n'en sait rien.

   3. ELLE NE SE POSE QUE SUR UN NOM INCONNU. Choisir une entreprise dans la
      liste, ou retaper à l'identique un nom déjà présent, ne déclenche rien.
      Le seuil de ressemblance est calibré sur le carnet réel, voir
      similarAccounts() dans api.js : une seule fausse alerte sur 445 noms.
   -------------------------------------------------------------------------- */

function hideAsk(key) {
    delete ask[key];
    const box = document.getElementById(`ask-${key}`);
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
}

function showAsk(key, nom, proches) {
    const box = document.getElementById(`ask-${key}`);
    if (!box) return;
    ask[key] = { nom, proches };
    const un = proches.length === 1;
    box.innerHTML = `
        <div class="event-ask-title">
            « ${escapeHtml(nom)} » n'est pas dans le carnet, mais
            ${un ? 'un nom très proche y est' : 'des noms très proches y sont'}.
        </div>
        <div class="event-ask-btns">
            ${proches.map((a, i) => `
                <button class="event-ask-btn event-ask-btn--use" type="button"
                        data-ask-use="${i}" data-ask-key="${key}">
                    Utiliser ${escapeHtml(a.name)}
                </button>`).join('')}
            <button class="event-ask-btn event-ask-btn--new" type="button" data-ask-new="${key}">
                Créer « ${escapeHtml(nom)} »
            </button>
        </div>`;
    box.hidden = false;
}

/**
 * Point d'entrée unique de l'ajout d'une ligne : pose la question de
 * ressemblance s'il y a lieu, sinon enregistre.
 *
 * `force` veut dire « la personne a déjà tranché » : elle a choisi dans la
 * liste, ou elle vient de répondre à la question. Ne jamais reposer une
 * question à laquelle on a déjà répondu, sinon la saisie tourne en rond.
 */
function submitEvent(key, saisi, { force = false } = {}) {
    const nom = cleanAccountName(saisi);
    if (!force && nom && !accountByName(nom)) {
        const proches = similarAccounts(nom, 3);
        if (proches.length) { showAsk(key, nom, proches); return; }
    }
    hideAsk(key);
    pushEvent(key, nom);
}

function pushEvent(key, saisi) {
    if (!allowWrite()) return;
    const nom = cleanAccountName(saisi);
    const iso = day;
    const tmp = {
        id: `tmp-${++tmpSeq}`, kind: key, account_id: null,
        account_name: nom || null, pending: true
    };
    events.push(tmp);
    paintEventLists();
    inflight++;
    status('Enregistrement…', 'saving');

    enqueue(async () => {
        try {
            const compte = nom ? await ensureAccount(nom) : null;

            /* Lu avant l'insertion, voir la note de la section « Avertissement ».
               Un échec ici ne doit rien empêcher : l'avertissement est un
               confort, saisir tous les jours est la mission. Une base sans la
               fonction account_history laisse donc la saisie intacte. */
            let histo = [];
            if (compte) {
                try { histo = await accountHistory(compte.id); }
                catch { histo = []; }
            }

            const ligne = await addSalesEvent(key, iso, compte ? compte.id : null);
            inflight--;
            if (iso !== day) { settle(); return; }   // la journée affichée a changé
            const i = events.indexOf(tmp);
            const finale = { ...ligne, account_name: compte ? compte.name : null };
            if (i >= 0) events[i] = finale; else events.push(finale);
            paintEventLists();
            settle();
            if (compte && nom && compte.name !== nom) {
                toast(`Rattaché à « ${compte.name} », déjà connu sous cette orthographe.`,
                      'success', 5000);
            }
            if (compte) {
                const lignes = warnLines(key, histo);
                if (lignes.length) showWarn(key, compte.name, lignes);
            }
        } catch (e) {
            inflight--;
            if (iso === day) {
                const i = events.indexOf(tmp);
                if (i >= 0) events.splice(i, 1);
                paintEventLists();
            }
            settle();
            toast(humanError(e), 'error', 7000);
        }
    });
}

/**
 * Retire une ligne. Pas de confirmation : la retaper coûte trois secondes, et
 * une boîte de dialogue à chaque suppression rendrait la correction d'une
 * journée pénible. En cas de refus de la base, la ligne revient à sa place.
 */
function removeEvent(id) {
    // Ligne encore en vol : elle n'a pas d'identifiant en base, rien à supprimer.
    if (!id || String(id).startsWith('tmp-')) return;
    if (!allowWrite()) return;
    const i = events.findIndex(e => String(e.id) === String(id));
    if (i < 0) return;

    const iso = day;
    const [otee] = events.splice(i, 1);
    paintEventLists();
    inflight++;
    status('Enregistrement…', 'saving');

    enqueue(async () => {
        try {
            await deleteSalesEvent(id);
            inflight--;
            settle();
        } catch (e) {
            inflight--;
            if (iso === day) { events.splice(i, 0, otee); paintEventLists(); }
            settle();
            toast(humanError(e), 'error', 6000);
        }
    });
}

/* --- Avertissement : ce client a déjà un antécédent -------------------------

   Demande de Bruno : « il y a tant de jours ou tant de mois, tu avais déjà
   envoyé une proposition pour tel client », pour éveiller la vigilance. Deux
   décisions de conception en découlent.

   1. ON AVERTIT, ON NE BLOQUE PAS. La ligne est enregistrée dans tous les cas.
      Deux propositions chez le même client sont parfois parfaitement légitimes,
      et une boîte de dialogue qui demande de confirmer une saisie exacte est le
      plus sûr moyen de faire cesser la saisie.

   2. L'HISTORIQUE EST LU AVANT L'INSERTION. account_history() ne renvoie pas
      d'identifiant d'événement : la ligne qu'on vient de créer y serait
      indiscernable d'un antécédent, et il faudrait la deviner en retirant « une
      occurrence du même type, à la même date, à moi ». Lire d'abord coûte un
      aller-retour de plus mais supprime le bricolage. L'affichage étant
      optimiste, la lenteur ne se voit pas : la ligne est déjà à l'écran.
   -------------------------------------------------------------------------- */

/* Les libellés de METRICS sont au pluriel parce qu'ils titrent un compteur.
   Dans une phrase il faut un singulier, et une forme qui évite l'accord :
   « une proposition, il y a 2 mois » se lit quel que soit le genre. */
const EVENT_ONE = {
    first_meetings: 'un RDV1',
    proposals_sent: 'une proposition',
    no_go:          'un NO GO',
    deals_dropped:  'une affaire abandonnée',
    deals_lost:     'une affaire perdue'
};

/* Les trois sorties de pipeline. Un client déjà classé NO GO ou perdu mérite un
   mot au moment où on lui envoie autre chose : c'est le seul antécédent, en
   dehors du même type, qui peut changer une décision. Un RDV1 avant une
   proposition est le cycle normal et n'a rien à signaler ; l'afficher ferait du
   bruit, et du bruit finit par se lire comme rien.

   Ce second motif est une proposition de ma part et non une demande de Bruno :
   vider ce tableau le désactive, sans autre effet. */
const WARN_EXITS = ['no_go', 'deals_lost', 'deals_dropped'];

const whoOf = h => (h.is_mine ? 'vous' : (h.who || 'un collègue'));

/**
 * Phrases à afficher pour un ajout de type `key` chez un client dont voici
 * l'historique, du plus récent au plus ancien. Tableau vide s'il n'y a rien à
 * dire, ce qui est le cas le plus fréquent.
 */
function warnLines(key, histo) {
    const out = [];
    const dit = h => `${EVENT_ONE[h.kind] || h.kind}, ${agoLabel(h.activity_date)} `
                   + `(le ${formatDMY(h.activity_date)}), par ${whoOf(h)}`;

    const meme = histo.filter(h => h.kind === key);
    if (meme.length) {
        out.push(`Déjà chez ce client : ${dit(meme[0])}.`
               + (meme.length > 1 ? ` ${meme.length} au total.` : ''));
    }
    const sorties = histo.filter(h => WARN_EXITS.includes(h.kind) && h.kind !== key);
    if (sorties.length) out.push(`Également : ${dit(sorties[0])}.`);
    return out;
}

function showWarn(key, nom, lignes) {
    const box = document.getElementById(`warn-${key}`);
    if (!box || !lignes.length) return;
    box.innerHTML = `
        <button class="event-warn-close" type="button" data-warn-close="${key}"
                title="Masquer" aria-label="Masquer l'avertissement">×</button>
        <div class="event-warn-title">${escapeHtml(nom)}</div>
        <ul class="event-warn-list">${lignes.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
    box.hidden = false;
}

function hideWarn(key) {
    const box = document.getElementById(`warn-${key}`);
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
}

/* --- Autocomplétion ---------------------------------------------------------

   Liste maison plutôt qu'un <datalist> natif, pour une raison et une seule :
   elle doit pouvoir distinguer « choisir Airbus, déjà connu » de « créer
   Airbus Defence ». Un datalist affiche des options sans jamais dire laquelle
   existe déjà, ce qui est précisément l'information qui empêche le doublon.

   Elle est en flux normal et non en position absolue : .card porte
   overflow: hidden dans app.css, une liste flottante serait coupée dès que le
   champ est en bas de carte. Le contenu descend d'une centaine de pixels
   pendant la frappe, ce qui est le prix à payer, et il n'y a rien à recalculer
   au redimensionnement.
   -------------------------------------------------------------------------- */

function suggState(key) {
    if (!sugg[key]) sugg[key] = { list: [], index: -1, open: false };
    return sugg[key];
}

function closeSugg(key) {
    const st = suggState(key);
    st.open = false; st.index = -1; st.list = [];
    const box = document.getElementById(`sugg-${key}`);
    const inp = document.getElementById(`ev-${key}`);
    if (box) { box.hidden = true; box.innerHTML = ''; }
    if (inp) {
        inp.setAttribute('aria-expanded', 'false');
        inp.removeAttribute('aria-activedescendant');
    }
}

function paintSugg(key) {
    const st = suggState(key);
    const box = document.getElementById(`sugg-${key}`);
    const inp = document.getElementById(`ev-${key}`);
    if (!box || !inp) return;
    if (!st.list.length) { closeSugg(key); return; }

    box.innerHTML = st.list.map((x, i) => `
        <div class="event-sugg-item${i === st.index ? ' event-sugg-item--on' : ''}"
             id="sugg-${key}-${i}" role="option" aria-selected="${i === st.index}" data-i="${i}">
            ${x.id
                ? escapeHtml(x.name)
                : `<span class="event-sugg-new">Nouveau</span> ${escapeHtml(x.name)}`}
        </div>`).join('');
    box.hidden = false;
    st.open = true;
    inp.setAttribute('aria-expanded', 'true');
    if (st.index >= 0) inp.setAttribute('aria-activedescendant', `sugg-${key}-${st.index}`);
    else inp.removeAttribute('aria-activedescendant');
}

/**
 * Construit la liste des suggestions.
 *
 * `index` reste à -1 : AUCUNE suggestion n'est présélectionnée. C'est
 * volontaire et important. Présélectionner la première ferait qu'en tapant
 * « Airbus Defence » puis Entrée, la ligne partirait chez « Airbus », déjà
 * connu et proposé en tête. Une erreur silencieuse sur le nom du client est
 * exactement ce qu'on cherche à éviter. Entrée prend donc toujours ce qui est
 * tapé, et il faut une flèche ou un clic pour choisir une suggestion.
 *
 * La ligne « Nouveau » ferme la liste plutôt que de la laisser vide : sans
 * elle, taper un nom inconnu n'afficherait rien, et l'écran ressemblerait à une
 * autocomplétion en panne.
 */
function openSugg(key, texte) {
    const st = suggState(key);
    const q = cleanAccountName(texte);
    if (!q) { closeSugg(key); return; }
    const trouves = searchAccounts(q, 7);
    const cle = accountKey(q);
    st.list = trouves.map(a => ({ id: a.id, name: a.name }));
    if (!trouves.some(a => a.name_key === cle)) st.list.push({ id: null, name: q });
    st.index = -1;
    paintSugg(key);
}

function onEventKey(inp, e) {
    const key = inp.dataset.key;
    const st = suggState(key);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!st.open) openSugg(key, inp.value);
        if (!st.list.length) return;
        e.preventDefault();
        const n = st.list.length;
        st.index = e.key === 'ArrowDown'
            ? (st.index + 1 >= n ? 0 : st.index + 1)
            : (st.index - 1 < 0 ? n - 1 : st.index - 1);
        paintSugg(key);
        return;
    }
    if (e.key === 'Escape') {
        if (st.open) { e.preventDefault(); closeSugg(key); }
        return;
    }
    if (e.key !== 'Enter') return;

    e.preventDefault();
    const choisie = st.open && st.index >= 0 ? st.list[st.index] : null;
    const nom = choisie ? choisie.name : inp.value;
    closeSugg(key);
    inp.value = '';
    submitEvent(key, nom, { force: !!(choisie && choisie.id) });
    inp.focus();
}

/* --------------------------------------------------------------------------
   Rendu
   -------------------------------------------------------------------------- */

/**
 * Valeur du compteur à l'échelle de lecture en cours.
 *
 * Renvoie null quand rien n'a été mesuré sur toute la période, jamais zéro : un
 * zéro affiché serait une déclaration, et personne ne l'a faite.
 */
/**
 * Valeur d'un total, additionnée depuis ce qui est à l'écran.
 *
 * Renvoie 0 et non null quand rien n'est déclaré : un total est une somme, et la
 * somme de rien est zéro. C'est différent des compteurs qu'il additionne, où NULL
 * garde son sens de « non mesuré ». La base fait exactement la même chose pour
 * calls_connected et meetings_booked, qui sont NOT NULL depuis l'origine.
 */
function sommeDe(m) {
    if (!m.derived) return Number(row[m.key]) || 0;
    return m.derived.reduce((n, k) => n + (Number(row[k]) || 0), 0);
}

function periodValue(key) {
    const meta = METRIC_BY_KEY[key];
    if (meta && meta.derived) {
        /* Un total sur une période s'additionne à partir des totaux journaliers
           déjà calculés par la base, et non en réadditionnant les catégories :
           l'historique d'avant la v14 a des totaux mais pas de catégories, et
           réadditionner ferait disparaître deux cent dix-huit rendez-vous. Seule
           la journée affichée est recalculée depuis l'écran, pour suivre la frappe. */
        const jourEcran = sommeDe(meta);
        if (echelleDe(key) === 'day') return jourEcran;
        const hors = cumuls[echelleDe(key)] ? cumuls[echelleDe(key)][key] : null;
        return (hors || 0) + jourEcran;
    }
    const jour = row[key] != null ? Number(row[key]) : null;
    if (echelleDe(key) === 'day') return jour;
    const hors = cumuls[echelleDe(key)] ? cumuls[echelleDe(key)][key] : null;
    if (hors == null && jour == null) return null;
    return (hors || 0) + (jour || 0);
}

/**
 * La phrase sous la jauge, en mode période : ce qui est fait, ce qui reste, et
 * en combien de jours ouvrés.
 *
 * Trois situations, trois phrases. Une période terminée ne dit pas « il reste » :
 * il ne reste rien, c'est fini, et afficher un reste à faire sur un mois clos
 * ferait espérer une action impossible. Une période en cours sans jour ouvré
 * devant elle le dit aussi — un objectif de semaine consulté le dimanche soir
 * n'est plus rattrapable, et l'écran vaut mieux qu'un silence.
 */
function restLine(v, t, ech) {
    const periode = periodes[ech];
    if (ech === 'day' || !periode) return '';

    const finie = diffDays(todayISO(), periode.to) > 0;
    // joursOuvres compte aujourd'hui s'il est ouvré : la journée n'est pas
    // finie, et l'annoncer comme perdue découragerait pour rien.
    const jo = finie ? 0 : joursOuvres(todayISO(), periode.to);
    const nJours = n => `${n} jour${n > 1 ? 's' : ''} ouvré${n > 1 ? 's' : ''}`;

    /* Rien de mesuré n'est pas zéro fait. La jauge affiche « non mesuré » juste
       au-dessus : écrire « 0 sur 40 » ici la contredirait, et donnerait à lire
       comme un échec ce qui n'est qu'une absence de déclaration. */
    if (v == null) {
        if (finie) return `rien de mesuré sur la période`;
        return jo > 0
            ? `rien de mesuré · objectif de ${fmtCible(t)}, ${nJours(jo)} devant`
            : `rien de mesuré · plus de jour ouvré dans la période`;
    }

    /* Le fait reste entier — on ne passe pas 2,5 appels — mais l'objectif et le
       reste à faire sont décimaux depuis la v18. Les mélanger dans la même
       phrase est voulu : « 3 sur 12,5 » dit exactement la vérité des deux. */
    const faits = `${fmtInt(v)} sur ${fmtCible(t)}`;
    if (v >= t) return `${faits} · objectif atteint`;

    const reste = auDixieme(t - v);
    if (finie) return `${faits} · période terminée, ${fmtCible(reste)} de moins que l'objectif`;
    if (jo <= 0) return `${faits} · plus de jour ouvré dans la période`;

    return `${faits} · reste ${fmtCible(reste)} en ${nJours(jo)}`
         + ` (${fmtCible(parJour(reste, jo))} par jour)`;
}

/**
 * Le rythme à tenir : ce qui reste, réparti sur les jours ouvrés qui restent.
 *
 * DEUX ARRONDIS ET NON UN. Au-dessus de dix par jour, l'entier supérieur suffit
 * et se lit d'un coup d'œil : « 49 par jour ». En dessous, l'entier supérieur
 * ment beaucoup — un reste de 2,5 sur dix jours devient « 1 par jour », soit dix
 * au lieu de deux et demi. On descend alors au dixième.
 *
 * Toujours vers le HAUT dans les deux cas : arrondir un rythme à tenir vers le
 * bas, c'est promettre que l'objectif sera atteint en faisant moins.
 *
 * Le retrait d'un milliardième avant l'arrondi n'est pas une coquetterie :
 * 0,3 en virgule flottante vaut parfois 0,30000000000000004, et sans lui la
 * phrase afficherait « 0,4 par jour » pour un compte parfaitement rond.
 */
function parJour(reste, jo) {
    const brut = reste / jo;
    if (brut >= 10) return Math.ceil(brut - 1e-9);
    return Math.ceil(brut * 10 - 1e-9) / 10;
}

/* --------------------------------------------------------------------------
   LE REPÈRE DE RYTHME (v17)

   Une jauge dit « 12 % de l'objectif ». Sur une journée, c'est clair. Sur un
   exercice de douze mois, c'est trompeur dans les deux sens : au 27 août, 12 %
   d'un objectif annuel ressemble à un désastre et 66 % à un exploit, alors que
   66 % au 27 août, c'est exactement dans les temps.

   D'où ce trait posé sur la barre à la position du temps écoulé. Au-dessus, on
   est devant ; en dessous, on est derrière. Sans lui, l'échelle annuelle
   n'aurait produit que des barres rassurantes pendant onze mois puis une panique
   en septembre.

   COMPTÉ EN JOURS OUVRÉS, comme tout le reste de l'outil : un objectif ne se
   poursuit pas le dimanche, et le 15 août pèse zéro. La journée affichée est
   incluse, parce qu'elle est en cours de saisie et que ses chiffres comptent
   déjà dans la barre.

   Le résultat est mis en cache par période : joursOuvres() parcourt les jours un
   par un, et sur un exercice cela ferait deux cent cinquante tours par compteur
   et par peinture, soit quatre mille pour un simple clic sur un bouton plus.
   -------------------------------------------------------------------------- */

/* Depuis la v20 il y a jusqu'à quatre échelles à l'écran en même temps, donc
   jusqu'à quatre repères différents : le cache est une table indexée par
   échelle et par jour, et non plus une seule entrée. Il se vide de lui-même à
   chaque changement de journée, puisque la clé en tient compte. */
const _rythme = new Map();

function rythme(ech) {
    const cle = `${ech}|${day}`;
    if (_rythme.has(cle)) return _rythme.get(cle);
    const b = periodBounds(ech, day);
    const total = joursOuvres(b.from, b.to);
    const faits = joursOuvres(b.from, day);
    const r = {
        total,
        faits,
        pct: total > 0 ? Math.min(100, (faits / total) * 100) : 0
    };
    _rythme.set(cle, r);
    return r;
}

function paintGauge(m) {
    if (!m.target) return;   // compteur sans objectif : aucune jauge à peindre

    /* Depuis la v12, l'objectif vient de la base et non plus d'un réglage local :
       valeur de la personne si elle en a une, sinon celle de son métier, sinon
       aucune. Le troisième cas s'affiche « non défini », et c'est une
       information : personne n'a encore dit ce qu'on attendait ici. Un zéro
       affiché à la place aurait voulu dire « ne rien faire est l'objectif ».

       Depuis la v13 l'objectif est demandé à l'échelle de lecture : un objectif
       mensuel n'est pas douze fois l'objectif du jour, et il n'est pas déduit
       ici. Ce qui n'a pas été posé pour l'échelle affichée reste « non défini ». */
    const ech = echelleDe(m.key);
    const t = Number(targetFor(viewedProfile(), m.key, ech).value) || 0;
    const v = periodValue(m.key);
    const mesure = v != null;
    const val = v || 0;
    const pct = mesure && t > 0 ? Math.min(100, (val / t) * 100) : 0;
    const fill = document.getElementById(`gauge-${m.key}`);
    if (!fill) return;
    fill.style.width = `${pct}%`;
    fill.classList.toggle('gauge-fill--done', mesure && t > 0 && val >= t);
    document.getElementById(`target-${m.key}`).textContent = t > 0 ? fmtCible(t) : 'non défini';

    /* L'échelle est marquée à côté de l'objectif, et pas seulement en haut de la
       page : sans elle, « Objectif : 40 » se lit comme un objectif du jour, et
       quarante appels dans le mois se prendraient pour une catastrophe. Depuis
       la v20 ce n'est plus un texte mais les quatre lettres, dont celle en
       cours est allumée. */
    const seg = document.getElementById(`ech-${m.key}`);
    if (seg) {
        seg.querySelectorAll('button[data-ech]').forEach(b => {
            const on = b.dataset.ech === ech;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        // Un compteur qui s'écarte du défaut de la page mérite d'être repérable
        // sans avoir à comparer les quatre lettres avec le bandeau du haut.
        seg.classList.toggle('ech-seg--part', ech !== scale);
    }

    // Période non mesurée : ni pourcentage ni barre, sinon l'écran affirmerait
    // un zéro que personne n'a déclaré.
    document.getElementById(`gauge-pct-${m.key}`).textContent =
        !mesure ? 'non mesuré' : t > 0 ? `${Math.round((val / t) * 100)} %` : '—';

    const rest = document.getElementById(`gauge-rest-${m.key}`);
    const txt = t > 0 ? restLine(v, t, ech) : '';
    rest.textContent = txt;
    rest.hidden = !txt;

    /* Le repère de rythme. Pas sur l'échelle du jour, où le temps écoulé vaut
       toujours cent pour cent, et pas sans objectif, où il n'y aurait rien à
       comparer : un trait seul sur une barre vide n'informe de rien. */
    const mark = document.getElementById(`gaugemark-${m.key}`);
    if (mark) {
        const montrer = ech !== 'day' && t > 0;
        mark.hidden = !montrer;
        if (montrer) {
            const r = rythme(ech);
            mark.style.left = `${r.pct}%`;
            const sc2 = TARGET_SCALES.find(x => x.key === ech);
            mark.title = `${Math.round(r.pct)} % du temps écoulé : `
                + `${r.faits} jours ouvrés sur ${r.total} ${sc2 ? sc2.article : ''}`.trim();
        }
    }
}

function paintDerived() {
    const calls = Number(row.calls_made) || 0;

    /* Les totaux de l'étage 2 et de l'étage 3 sont RECALCULÉS ICI, pas lus dans
       row. row porte la réponse de la base, qui arrive trois cents millisecondes
       après la frappe : lire row ferait un taux d'aboutissement encore calculé
       sur l'avant-dernière valeur, juste sous un total déjà à jour. Le trigger
       fait la même addition, donc les deux ne divergent jamais durablement. */
    const num = k => Number(row[k]) || 0;
    const conn = num('calls_dead_end') + num('calls_engaged_new') + num('calls_engaged_known');
    const eched = num('calls_engaged_new') + num('calls_engaged_known');
    const mesureEch = row.calls_engaged_new != null || row.calls_engaged_known != null
                   || row.calls_engaged != null;

    /* Rendez-vous du jour : le RDV obtenu du BDR et le RDV1 tenu du commercial
       ne coexistent jamais chez la même personne, l'un des deux termes étant
       toujours nul. Pour qui a les deux métiers, les additionner est bien le
       sens voulu : ce sont deux rencontres différentes. */
    const rdv = num('meetings_rescheduled') + num('meetings_new') + num('meetings_known')
              + num('first_meetings');

    $('#kpi-connect').textContent = calls > 0 ? `${fmtDec((conn / calls) * 100)} %` : '–';
    // Non mesuré et zéro ne s'affichent pas pareil : le premier est une absence
    // de donnée, le second un résultat.
    const eng = $('#kpi-engage');
    if (eng) {
        eng.textContent = !mesureEch ? 'non mesuré'
            : conn > 0 ? `${fmtDec((eched / conn) * 100)} %` : '–';
    }
    $('#kpi-meeting').textContent = conn > 0 ? `${fmtDec((rdv / conn) * 100)} %` : '–';
    $('#kpi-effort').textContent = rdv > 0 ? `${fmtDec(calls / rdv)} appels` : '–';

    const total = (sel, v) => {
        const el = document.querySelector(`[data-total="${sel}"]`);
        if (el) el.textContent = fmtInt(v);
    };
    total('crm', num('companies_created') + num('contacts_created'));
    total('prospection', calls + num('emails_sent'));
    total('pipeline', num('first_meetings') + num('proposals_sent'));
    total('outcome', num('no_go') + num('deals_dropped') + num('deals_lost'));

    /* Compteurs du cycle de vente : lus dans row comme tous les autres. row a
       été réaligné sur les listes par paintEventLists(), donc le nombre affiché,
       le total de la carte et le score viennent bien du même endroit. */
    SALES_EVENT_KINDS.forEach(k => {
        const el = document.getElementById(`count-${k}`);
        if (el) el.textContent = fmtInt(num(k));
    });

    $('#day-score').textContent = fmtInt(scoreOf(row));

    const prevScore = prevRow ? scoreOf(prevRow) : 0;
    $('#kpi-prev').innerHTML = prevRow
        ? delta(scoreOf(row), prevScore).html
        : '<span class="delta delta--flat">pas de donnée</span>';
}

function paint() {
    myMetrics.forEach(m => {
        const input = document.getElementById(`in-${m.key}`);
        if (input && document.activeElement !== input) input.value = inputValue(m.key);

        /* Un total est recalculé À L'ÉCRAN à partir des valeurs affichées, et
           non lu dans la réponse de la base. La base a raison, mais elle répond
           trois cents millisecondes plus tard : lire sa valeur ferait un total
           qui reste sur l'ancien chiffre le temps de l'aller-retour, à côté de
           trois compteurs déjà à jour. Le trigger et ce calcul appliquent la
           même addition, donc les deux tombent toujours d'accord. */
        const total = document.getElementById(`total-${m.key}`);
        if (total) total.textContent = fmtInt(sommeDe(m));

        paintGauge(m);
    });
    const notes = $('#day-notes');
    if (document.activeElement !== notes) notes.value = row.notes || '';
    paintDerived();
}

function paintDateBar() {
    const isToday = day === todayISO();
    $('#day-label').innerHTML =
        `${escapeHtml(formatLong(day))}<small>${escapeHtml(relativeLabel(day))}</small>`;
    $('#day-picker').value = day;
    $('#day-picker').max = todayISO();
    $('#day-next').disabled = isToday;
    $('#chip-today').classList.toggle('chip--active', isToday);
    $('#chip-yesterday').classList.toggle('chip--active', day === addDaysISO(todayISO(), -1));

    paintScaleBar();

    $('#past-warning').innerHTML = isToday ? '' : `
        <div style="margin-top:14px">
            <span class="badge-past">✎ Vous modifiez une journée passée
            (${escapeHtml(relativeLabel(day))}). Les enregistrements restent immédiats.</span>
        </div>`;

    const prevIso = addDaysISO(day, -1);
    $('#kpi-prev-label').textContent = `Score du ${formatLong(prevIso).replace(/^\w+\s/, '')}`;
}

/**
 * Le sélecteur d'échelle, et la phrase qui dit ce qu'il change.
 *
 * La phrase n'est pas décorative : elle est la réponse au seul vrai risque de
 * cet écran. En vue Mois deux chiffres cohabitent, celui du jour dans le champ
 * et celui du mois dans la jauge, et rien dans un champ à « 12 » ne dit lequel
 * des deux on regarde. La phrase le dit, à chaque changement, en nommant les
 * deux dates. Elle disparaît en vue Jour, où il n'y a plus d'ambiguïté à lever.
 */
function paintScaleBar() {
    const seg = $('#scale-seg');
    if (seg) {
        seg.querySelectorAll('button').forEach(b => {
            const on = b.dataset.scale === scale;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    const hint = $('#period-hint');
    if (!hint) return;

    /* Le compte des compteurs à part n'est pas cosmétique : sans lui, la phrase
       « Jauges du mois » serait fausse pour ceux qui regardent l'exercice, et
       un chiffre inexpliqué sur une jauge est pire qu'un chiffre absent. */
    const ex = nbExceptions();
    if (scale === 'day' && !ex) { hint.hidden = true; hint.innerHTML = ''; return; }

    const sc = TARGET_SCALES.find(x => x.key === scale);
    const bouts = [];
    if (scale === 'day') {
        bouts.push(`Jauges ${escapeHtml(sc.article)}`);
    } else {
        const b = periodBounds(scale, day);
        bouts.push(`Jauges ${escapeHtml(sc.article)}, <b>${escapeHtml(periodLabel(b.from, b.to))}</b>`);
        bouts.push(`la saisie ci-dessous reste celle du <b>${escapeHtml(formatLong(day))}</b>`);
    }
    if (ex) {
        bouts.push(`<b>${ex} compteur${ex > 1 ? 's' : ''}</b> à ${ex > 1 ? 'leur' : 'sa'} propre échelle`);
    }
    hint.hidden = false;
    hint.innerHTML = bouts.join(' · ');
}

/**
 * Change l'échelle de lecture.
 *
 * L'écran est repeint avant que la base ait répondu, et la préférence est
 * enregistrée sans qu'on l'attende : un sélecteur qui met une demi-seconde à
 * réagir donne l'impression d'un clic manqué, et on le clique deux fois. Si
 * l'enregistrement échoue, le choix vaut pour la session en cours, ce que
 * saveGaugeScale annonce dans la console sans embêter personne à l'écran — une
 * préférence d'affichage non retenue n'est pas une panne.
 */
async function setScale(next) {
    if (!TARGET_SCALES.some(x => x.key === next)) return;

    /* Compté AVANT de toucher à `scale`, et sur la totalité des exceptions et
       non sur celles qui s'écartent du défaut : après l'affectation, une
       exception « semaine » deviendrait invisible au comptage sur un passage à
       la semaine, et l'écran l'effacerait sans l'enregistrer. L'écran et la base
       auraient alors divergé jusqu'au prochain rechargement. */
    const avait = Object.keys(echelles).length;
    if (next === scale && !avait) return;

    scale = next;

    /* LE BANDEAU EFFACE LES EXCEPTIONS. C'est ce que Bruno a demandé : le
       réglage du haut est le défaut de tout le monde. C'est aussi, et surtout,
       le seul moyen simple de revenir à un écran homogène quand treize
       compteurs ont fini par regarder quatre périodes différentes. Sans cela,
       il faudrait treize clics pour se remettre d'aplomb, et le réglage du haut
       donnerait l'impression d'être cassé. */
    echelles = {};
    paintScaleBar();
    buildTargets();
    paint();                    // les jauges affichent tout de suite la bonne échelle
    const ok = await loadPeriode();
    paint();                    // puis le cumul, dès qu'il est là
    if (!ok && scale !== 'day') {
        toast('Le cumul de la période n\'a pas pu être lu : les jauges restent vides, '
            + 'la saisie du jour fonctionne normalement.', 'error', 6000);
    }
    /* Chez quelqu'un d'autre, le changement d'échelle ne vaut que pour le coup
       d'œil en cours. Deux raisons : la politique RLS de profiles n'autorise
       l'update que sur sa propre ligne — même le propriétaire ne peut pas
       écrire le gauge_scale d'un tiers, l'appel échouerait en silence — et
       surtout, regarder la semaine de quelqu'un ne doit pas lui changer son
       écran pour le lendemain matin. */
    if (!isViewingOther()) {
        saveGaugeScale(scale);
        if (avait) saveMetricScales({});
    }
    if (avait) {
        toast(`${avait} compteur${avait > 1 ? 's' : ''} ${avait > 1 ? 'suivaient' : 'suivait'} `
            + `sa propre échelle : tout est revenu ${TARGET_SCALES.find(x => x.key === next).article}.`,
            'info', 5000);
    }
}

/**
 * Change l'échelle d'UN compteur.
 *
 * Revenir sur le défaut de la page EFFACE l'exception au lieu de l'enregistrer
 * à l'identique. Sans cela, un compteur remis « au mois » alors que la page est
 * au mois resterait figé au mois pour toujours, et ne suivrait plus le bandeau
 * du haut : le réglage aurait l'air de fonctionner une fois, puis plus jamais.
 * Même principe que le forçage des objectifs, où l'on efface l'exception plutôt
 * que de recopier le défaut.
 */
async function setEchelleMetrique(key, next) {
    if (!TARGET_SCALES.some(x => x.key === next)) return;
    if (echelleDe(key) === next) return;

    if (next === scale) delete echelles[key];
    else echelles[key] = next;

    paintScaleBar();
    buildTargets();
    paint();                    // la bonne échelle tout de suite, le cumul ensuite

    const avant = JSON.stringify(cumuls);
    const ok = await loadPeriode();
    if (avant !== JSON.stringify(cumuls)) paint();

    if (!ok) {
        toast('Le cumul de la période n\'a pas pu être lu : cette jauge reste vide, '
            + 'la saisie du jour fonctionne normalement.', 'error', 6000);
    }

    /* Chez quelqu'un d'autre, c'est un coup d'œil et non un réglage : même
       raisonnement que pour l'échelle de la page. La colonne metric_scales
       n'est de toute façon accessible en écriture que sur sa propre ligne. */
    if (!isViewingOther()) saveMetricScales(echelles);
}

/* --------------------------------------------------------------------------
   Chargement d'un jour
   -------------------------------------------------------------------------- */

/**
 * Relit le cumul de la période, journée affichée exclue.
 *
 * Une seule requête, sur la vue v_daily_kpi, et seulement quand l'échelle n'est
 * pas le jour : en mode jour la valeur affichée est déjà celle de `row`, il n'y
 * a rien à additionner et rien à demander.
 *
 * Ne lève pas. Un cumul de période qui ne se charge pas doit laisser la saisie
 * du jour intacte : les jauges retombent alors sur « non mesuré », ce qui est
 * désagréable mais honnête, là où une exception aurait vidé l'écran.
 */
async function loadPeriode() {
    const utiles = echellesAffichees();
    periodes = {};
    utiles.forEach(e => { periodes[e] = periodBounds(e, day); });

    if (!utiles.length) { cumuls = {}; return true; }

    /* UNE seule requête, sur la plage qui contient toutes les périodes. Une
       semaine à cheval sur deux mois, ou un exercice fiscal qui commence en
       octobre, font que les bornes ne s'emboîtent pas toujours proprement :
       prendre le minimum des débuts et le maximum des fins est plus sûr que de
       supposer que la plus large contient les autres. */
    let from = null, to = null;
    utiles.forEach(e => {
        from = from === null ? periodes[e].from : minISO(from, periodes[e].from);
        to = to === null ? periodes[e].to : maxISO(to, periodes[e].to);
    });

    try {
        const rows = await fetchRange(from, to);
        const parEchelle = {};
        utiles.forEach(e => {
            const b = periodes[e];
            const somme = {};
            myMetrics.forEach(m => {
                let acc = null;
                rows.forEach(r => {
                    // La journée affichée est écartée : sa valeur vient de `row`,
                    // qui suit la frappe en cours. La compter deux fois doublerait
                    // chaque chiffre saisi aujourd'hui.
                    if (r.activity_date === day) return;
                    /* Hors des bornes de CETTE échelle : la même requête sert
                       quatre découpages, chacun ne prend que ce qui le concerne.
                       diffDays(a, b) est positif quand a est postérieur à b. */
                    if (diffDays(b.from, r.activity_date) > 0) return;   // avant le début
                    if (diffDays(r.activity_date, b.to) > 0) return;     // après la fin
                    if (r[m.key] != null) acc = (acc || 0) + Number(r[m.key]);
                });
                somme[m.key] = acc;
            });
            parEchelle[e] = somme;
        });
        cumuls = parEchelle;
        return true;
    } catch (e) {
        cumuls = {};
        console.warn('Cumul de période non chargé :', e.message);
        return false;
    }
}

async function load(iso) {
    // Ce qui attendait part maintenant, avec sa propre date : une frappe
    // programmée sur la journée que l'on quitte ne doit pas être perdue, et
    // encore moins atterrir sur la journée suivante.
    Object.keys(timers).forEach(flush);
    Object.keys(pending).forEach(k => delete pending[k]);
    Object.keys(blocked).forEach(k => delete blocked[k]);

    day = iso;
    paintDateBar();
    status('Chargement…');

    // On met à jour l'URL pour qu'un jour précis soit partageable / rechargeable.
    const url = new URL(location.href);
    if (iso === todayISO()) url.searchParams.delete('date');
    else url.searchParams.set('date', iso);
    history.replaceState({}, '', url);

    try {
        /* La troisième requête n'est envoyée que si la personne saisit un
           compteur du cycle de vente : un BDR ne paie rien pour cette v10. La
           quatrième ne part qu'en lecture semaine ou mois, et loadPeriode ne
           lève pas : le cumul est un confort, la saisie du jour est l'essentiel. */
        /* La cinquième lit le profil de la journée (v22). Elle ne peut pas
           faire échouer le chargement : une base où la migration v22 n'est pas
           passée doit continuer à saisir ses chiffres, et le profil se met
           simplement en retrait. C'est la même logique que loadPeriode. */
        const [current, previous, evts, prof] = await Promise.all([
            fetchDay(iso),
            fetchDay(addDaysISO(iso, -1)),
            hasEvents ? fetchDayEvents(iso) : Promise.resolve([]),
            loadPeriode(),
            fetchDayProfile(iso).catch(() => null)
        ]);
        row = current || { ...EMPTY_DAY, activity_date: iso, notes: '' };
        prevRow = previous;
        events = evts;
        /* Les avertissements portent sur un ajout précis, pas sur la journée :
           les laisser en place après un changement de date les ferait lire comme
           s'ils concernaient le jour affiché. */
        SALES_EVENT_KINDS.forEach(hideWarn);
        profilLisible = prof !== null;
        profil = prof || [];
        paint();
        paintEventLists();
        paintProfil();
        status(current ? '✓ À jour' : 'Aucune saisie pour ce jour', current ? 'saved' : '');
    } catch (e) {
        status('⚠ Lecture impossible', 'error');
        toast(humanError(e), 'error', 6000);
    }
}

/* --------------------------------------------------------------------------
   Explication du score, directement sous le score du jour
   -------------------------------------------------------------------------- */

function buildScoreExplain() {
    const host = $('#score-explain');
    if (!host) return;
    /* Le barème est réglable depuis la page Barème depuis la v8 : citer un
       nombre en dur dans la phrase mentirait dès le premier réglage. Et on ne
       liste que les poids des compteurs affichés, sinon un commercial lirait le
       tarif d'actions qu'il ne saisit pas. */
    const mine = new Set(myMetrics.map(m => m.key));
    host.innerHTML = `
        <details class="chart-note">
            <summary>Comment est calculé ce score ?</summary>
            <p>
                Chaque action du jour est multipliée par un poids, puis tout est additionné.
                Un rendez-vous pèse beaucoup plus lourd qu'un appel, parce qu'on est jugé
                sur ses rendez-vous et pas sur son volume d'appels. Les poids exacts sont
                ci-dessous.
            </p>
            ${SCORE_WEIGHTS.some(w => mine.has(w.key) && w.w === 0) ? `
            <p>
                Les compteurs à zéro point ne sont pas des oublis : ils se comptent, ils ne
                se notent pas. Perdre une affaire ne peut pas faire monter un score.
            </p>` : ''}
            <div class="weights" style="margin:14px 0 0">
                ${SCORE_WEIGHTS.filter(w => mine.has(w.key)).map(w => `
                    <div class="weight" style="background:var(--gray-100);border-color:var(--gray-200)">
                        <span style="font-size:15px">${w.icon}</span>
                        <span class="weight-label" style="color:var(--gray-600)">${w.label}</span>
                        <span class="weight-x">× ${w.w}</span>
                    </div>`).join('')}
            </div>
            <p style="margin-top:12px">
                Le score n'a pas de valeur absolue : il sert à comparer deux journées ou deux périodes.
                La page <b>Performances</b> en donne la décomposition chiffrée.
            </p>
        </details>`;
}

/* --------------------------------------------------------------------------
   Objectifs
   -------------------------------------------------------------------------- */

/* Le panneau n'est plus un formulaire depuis la v12, mais un affichage.

   POURQUOI ON RETIRE UNE LIBERTÉ. Chacun réglait ses propres objectifs, et voilà
   ce que la base en disait au 26 août : Dominique avait mis zéro partout le 25,
   Santiago le 26. Les deux avaient éteint leurs jauges. Ce n'était pas de la
   mauvaise volonté, c'était la seule sortie possible face à un objectif
   journalier de rendez-vous, qui n'a pas de sens pour un BDR. Mais un objectif
   qu'on peut mettre à zéro soi-même n'est plus un objectif, et un classement ne
   veut plus rien dire si chacun a fixé sa propre barre.

   Les objectifs sont donc fixés par le propriétaire, écran « Barème et
   objectifs », et lus ici. Ce qui reste affiché : la valeur, et d'où elle vient.
   Savoir que son objectif est celui de son métier ou un objectif personnel
   change la conversation qu'on aura à son sujet. */
/* --------------------------------------------------------------------------
   AFFICHER OU MASQUER SES OBJECTIFS (v16)

   Le réglage est rangé en base (target_visibility) avec la règle des objectifs :
   ce que la personne a choisi l'emporte sur le défaut de son métier, et sans
   rien de posé l'objectif est affiché.

   Rien n'est retiré du DOM, tout est masqué : les identifiants de jauge
   continuent d'exister, donc paintGauge() n'a pas eu à apprendre qu'un objectif
   peut être caché. Une jauge masquée est simplement peinte pour personne, ce qui
   coûte quelques microsecondes et évite une branche de plus dans le code le plus
   souvent exécuté de l'écran.
   -------------------------------------------------------------------------- */

/** Applique l'état d'affichage à tous les compteurs de l'écran. */
function appliqueVisibilite() {
    const qui = viewedProfile();
    myMetrics.forEach(m => {
        if (!m.target) return;
        const visible = targetVisible(qui, m.key);

        const bloc = document.getElementById(`gaugewrap-${m.key}`);
        if (bloc) bloc.hidden = !visible;

        const oeil = document.getElementById(`oeil-${m.key}`);
        if (oeil) {
            oeil.classList.toggle('oeil--off', !visible);
            oeil.setAttribute('aria-pressed', String(!visible));
            const quoi = visible ? 'Masquer' : 'Afficher';
            oeil.title = `${quoi} cet objectif`;
            oeil.setAttribute('aria-label', `${quoi} l'objectif : ${m.label}`);
        }
    });
    majCompteMasques();
}

/**
 * Bascule l'affichage d'un objectif.
 *
 * Optimiste, comme les steppers : l'écran répond au clic, et il ne revient en
 * arrière que si la base refuse. L'inverse — attendre la réponse réseau pour
 * cacher une jauge — donnerait l'impression d'un bouton qui ne marche pas.
 */
async function basculeObjectif(key) {
    const qui = viewedProfile();
    if (!qui) return;

    /* Chez quelqu'un d'autre, le même garde-fou que pour la saisie : une seule
       confirmation par session, et rien du tout pour qui n'a pas le droit.
       La politique RLS de target_visibility accepte l'exception « user » posée
       par le propriétaire, et refuse celle des autres. */
    if (isViewingOther() && !allowWrite()) return;

    const avant = targetVisible(qui, key);
    const apres = !avant;

    /* Peinture immédiate depuis la valeur voulue, sans attendre le cache. */
    const bloc = document.getElementById(`gaugewrap-${key}`);
    if (bloc) bloc.hidden = !apres;
    const oeil = document.getElementById(`oeil-${key}`);
    if (oeil) oeil.classList.toggle('oeil--off', !apres);

    try {
        await setVisibility({ scope: 'user', userId: qui.user_id, metric: key, visible: apres });
        appliqueVisibilite();
    } catch (err) {
        appliqueVisibilite();   // remet l'écran sur ce que dit vraiment le cache
        toast(humanError(err), 'error', 7000);
    }
}

/**
 * Rappelle discrètement le nombre d'objectifs masqués.
 *
 * Sans ce compte, quelqu'un qui a caché six jauges en janvier ouvre en mars un
 * écran sans objectifs et croit que le propriétaire n'en a jamais posé. Le
 * volet du bas continue de les lister tous : c'est le rappel de ce qui est
 * attendu, et le second chemin de retour.
 */
function majCompteMasques() {
    const somme = $('#targets-summary');
    if (!somme) return;
    const qui = viewedProfile();
    const n = myMetrics.filter(m => m.target && !targetVisible(qui, m.key)).length;
    const sc = TARGET_SCALES.find(x => x.key === scale);
    /* Le volet du bas reste à l'échelle de la PAGE, même quand des compteurs
       s'en écartent : c'est le rappel de ce que le propriétaire attend, sur une
       période unique et comparable. Les exceptions sont signalées à part, sinon
       la liste dirait « objectifs du mois » au-dessus de valeurs annuelles. */
    const ex = nbExceptions();
    somme.textContent = `🎚️ Mes objectifs ${sc ? sc.article : ''}`.trim()
        + (n ? ` · ${n} masqué${n > 1 ? 's' : ''}` : '')
        + (ex ? ` · ${ex} à part` : '');
}

function buildTargets() {
    /* Seuls les compteurs affichés et pourvus d'un objectif : afficher un
       objectif de NO GO, ou l'objectif d'e-mails d'un commercial qui n'en saisit
       pas, serait afficher une ligne sans effet. */
    const montrables = myMetrics.filter(m => m.target);
    const qui = viewedProfile();

    const lignes = montrables.map(m => {
        const t = targetFor(qui, m.key, scale);
        const val = t.source ? fmtCible(t.value) : '—';
        const src = t.source === 'user' ? 'objectif personnel'
                  : t.source === 'job'  ? 'objectif du métier'
                  : 'non défini';
        /* Un objectif masqué reste listé ici, marqué comme tel. Le volet du bas
           rappelle ce que le propriétaire attend, ce qui ne dépend pas de ce
           qu'on a choisi de voir sur les cartes, et c'est accessoirement le
           second chemin pour se souvenir qu'on a masqué quelque chose. */
        const cache = !targetVisible(qui, m.key);
        return `
        <div class="target-read${cache ? ' target-read--off' : ''}">
            <div class="target-read-lab">${escapeHtml(m.short)}</div>
            <div class="target-read-val">${val}</div>
            <div class="target-read-src">${cache ? 'masqué sur la carte' : src}</div>
        </div>`;
    }).join('');

    const absent = !targetsLoaded();
    const sc = TARGET_SCALES.find(x => x.key === scale);
    majCompteMasques();

    $('#targets-grid').innerHTML = lignes || '<p class="target-read-none">Aucun objectif ne '
        + "s'applique à ce profil.</p>";

    /* Un objectif absent à l'échelle affichée n'est pas la même chose qu'une
       migration manquante, et les deux se ressemblaient à l'écran : dans les
       deux cas les jauges sont vides. On distingue, sinon on cherchera une
       panne de base là où il manque simplement une décision. */
    const rien = montrables.length > 0
        && montrables.every(m => !targetFor(qui, m.key, scale).source);

    $('#targets-note').innerHTML = absent
        ? "Les objectifs n'ont pas pu être lus : la migration v12 n'est peut-être pas passée. "
        + 'La saisie fonctionne normalement, seules les jauges restent vides.'
        : rien
        ? `Aucun objectif n'a encore été posé ${escapeHtml(sc.article)} pour ce profil. Les jauges `
        + "restent donc vides à cette échelle : ce n'est pas une panne, c'est une décision qui "
        + "n'a pas été prise. Le propriétaire du Cockpit les règle sur l'écran « Barème et objectifs »."
        : 'Ces objectifs sont fixés par le propriétaire du Cockpit, écran « Barème et '
        + "objectifs ». Ils ne se règlent plus ici : un objectif se discute de vive voix.";
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

/* ==========================================================================
   LE PROFIL DE LA JOURNÉE (v22)

   POURQUOI. Une journée à quatre appels ressemble à une journée ratée. Si elle
   s'est passée en salon, elle est normale. La note du jour dit déjà ce genre de
   chose, mais en texte libre : aucune moyenne, aucune jauge, aucun graphique ne
   sait la lire. Ce bloc rend calculable ce que la note raconte. Il ne la
   remplace pas, elle reste en place pour tout le reste.

   CE QU'IL N'EST PAS. Une feuille de temps. Facultatif, absent du score, sans
   effet sur aucun compteur ni aucun objectif. Le jour où il se lit comme un
   contrôle horaire, il cesse d'être rempli, et l'application entière repose sur
   le fait qu'elle soit remplie tous les jours.

   TROIS RÈGLES D'ERGONOMIE, tenues partout dans ce module :

   1. UNE SEULE ACTIVITÉ VAUT 100 %, SANS RIEN SAISIR. Tant qu'il n'y a qu'une
      ligne, aucun pourcentage n'apparaît. La journée de salon complète se
      déclare en un clic, et c'est le cas le plus fréquent après la journée de
      prospection complète.

   2. UNE SOMME QUI NE FAIT PAS 100 N'EST NI BLOQUÉE NI CORRIGÉE EN SILENCE.
      Cette page n'a pas de bouton valider, tout part au fil de la frappe :
      bloquer y serait un corps étranger. L'écran écrit ce qui manque et laisse
      finir. Normaliser d'office fabriquerait un chiffre que personne n'a
      déclaré, ce que cette application ne fait nulle part.

   3. RIEN N'EST PRÉ-REMPLI. Une journée sans profil veut dire « non renseigné »,
      pas « journée normale ». Conséquence assumée : au début, seuls les jours
      atypiques seront décrits. C'est suffisant pour l'usage visé, et plus
      honnête que d'inventer cent pour cent de prospection sur tous les jours
      déjà passés.

   ÉCRITURE. Tout le profil part en une seule fois, par set_day_profile.
   Ajouter une deuxième activité fait passer la première de 100 % à 50 % : deux
   lignes changent d'un seul geste, et trois requêtes PostgREST dont la deuxième
   échoue laisseraient un profil à 150 % en base.
   ========================================================================== */

/* La liste affichée. Une entrée dont kind vaut '' est une ligne en attente :
   elle existe à l'écran, elle n'existe pas en base. */
let profil = [];

/* Faux quand la lecture a échoué, typiquement une migration v22 non passée. Le
   bloc se met alors en retrait au lieu de crier : la saisie du jour, elle,
   fonctionne parfaitement sans lui. */
let profilLisible = true;

/* 25, 50 et 75 couvrent la quasi-totalité des journées réellement partagées.
   Un pas de 10 offrirait dix boutons pour une précision que personne ne possède
   sur son propre emploi du temps ; ce qui n'entre pas dans ces trois valeurs se
   tape dans le champ à côté. */
const PARTS_RAPIDES = [25, 50, 75];

/** Les lignes réellement déclarées. Une ligne sans catégorie n'existe pas encore. */
const profilVrai = () => profil.filter(l => l.kind);

/**
 * Part attribuée à une ligne qui vient de recevoir sa catégorie. Deux cas, et
 * deux seulement :
 *
 *  - c'est la seule activité : 100 %, et le pourcentage reste invisible ;
 *  - il y en avait exactement une, à 100 % : on partage en deux. C'est le seul
 *    endroit où une ligne existante est modifiée sans qu'on l'ait touchée, et
 *    c'est défendable : ce 100 % n'a jamais été choisi, il était implicite.
 *
 * Sinon la nouvelle ligne prend ce qui reste, ou 25 % s'il ne reste rien.
 */
function attribuePart(i) {
    const autres = profil.filter((x, k) => k !== i && x.kind);
    if (!autres.length) { profil[i].share = 100; return; }
    if (autres.length === 1 && autres[0].share === 100) {
        autres[0].share = 50;
        profil[i].share = 50;
        return;
    }
    const reste = 100 - profileTotal(autres);
    profil[i].share = reste > 0 ? reste : 25;
}

/** Une ligne, en HTML. `parts` dit si les pourcentages sont visibles. */
function profilLigneHtml(l, i, parts) {
    const meta = PROFILE_BY_KIND[l.kind] || null;
    const pris = new Set(profil.filter((x, k) => k !== i && x.kind).map(x => x.kind));

    /* Chaque liste déroulante masque ce que les autres lignes ont déjà pris :
       le doublon de catégorie devient impossible par construction, plutôt que
       refusé après coup par une contrainte de base que personne ne comprend. */
    const options = DAY_PROFILE_KINDS
        .filter(k => !pris.has(k.key))
        .map(k => `<option value="${k.key}"${k.key === l.kind ? ' selected' : ''}>`
            + `${escapeHtml(k.label)}</option>`)
        .join('');

    const boutons = PARTS_RAPIDES.map(p =>
        `<button type="button" class="dp-part${l.share === p ? ' is-on' : ''}" `
        + `data-dp-part="${p}">${p} %</button>`).join('');

    const part = parts && l.kind
        ? `<span class="dp-parts">${boutons}</span>`
          + `<input type="text" class="dp-pct" data-dp-pct inputmode="numeric" maxlength="3" `
          + `value="${l.share == null ? '' : l.share}" aria-label="Part de la journée, en pourcentage">`
          + `<span class="dp-pct-unit">%</span>`
        : '';

    /* La précision libre n'apparaît que sur Webinar, Salon et Autre : nommer un
       salon apporte quelque chose, « préciser la prospection » ferait doublon
       avec la note du jour, qui est juste en dessous. */
    const precision = meta && meta.named
        ? `<input type="text" class="dp-label" data-dp-label maxlength="80" `
          + `value="${escapeHtml(l.label || '')}" `
          + `placeholder="${escapeHtml(meta.key === 'autre' ? 'Préciser (facultatif)' : 'Nom de l\'événement (facultatif)')}" `
          + `aria-label="Précision">`
        : '';

    return `<li class="dp-line" data-i="${i}">`
        + `<span class="dp-dot" style="background:${meta ? meta.color : 'var(--gray-300)'}"></span>`
        + `<select class="dp-kind" data-dp-kind aria-label="Type d'activité">`
        + `<option value="">Choisir une activité…</option>${options}</select>`
        + part + precision
        + `<button type="button" class="dp-del" data-dp-del aria-label="Retirer cette activité">×</button>`
        + `</li>`;
}

/** Le bloc entier. Reconstruit à chaque changement de structure, jamais pendant une frappe. */
function paintProfil() {
    const box = $('#day-profile');
    if (!box) return;

    if (!profilLisible) {
        box.hidden = false;
        box.innerHTML = `<div class="dp-head"><span class="dp-title">🕘 Profil de la journée</span>`
            + `<span class="dp-sub">Indisponible pour le moment. La saisie du jour, elle, `
            + `fonctionne normalement.</span></div>`;
        return;
    }

    const vraies = profilVrai();
    const parts = vraies.length >= 2;
    const complet = vraies.length >= DAY_PROFILE_KINDS.length || profil.some(l => !l.kind);

    box.hidden = false;
    box.innerHTML =
        `<div class="dp-head">`
        + `<span class="dp-title">🕘 Profil de la journée</span>`
        + `<span class="dp-sub">À quoi la journée a servi. Facultatif, sans effet sur le score.</span>`
        + `<span class="dp-state" data-dp-state></span>`
        + `</div>`
        + `<div class="dp-bar" data-dp-bar hidden></div>`
        + `<ul class="dp-lines">${profil.map((l, i) => profilLigneHtml(l, i, parts)).join('')}</ul>`
        + `<button type="button" class="dp-add" data-dp-add${complet ? ' hidden' : ''}>`
        + `${profil.length ? '+ Ajouter une activité' : '+ Décrire cette journée'}</button>`
        + `<p class="dp-rest" data-dp-rest></p>`;

    paintProfilMeta();
}

/**
 * La barre, le reste et l'état. Séparés du reste du rendu parce qu'ils changent
 * à chaque frappe dans le champ des pourcentages : reconstruire les lignes
 * ferait perdre le focus au caractère près.
 */
function paintProfilMeta() {
    const box = $('#day-profile');
    if (!box || !profilLisible) return;

    const vraies = profilVrai();
    const total = profileTotal(vraies);

    const bar = box.querySelector('[data-dp-bar]');
    if (bar) {
        /* Une barre d'une seule couleur n'apprend rien que le libellé ne dise
           déjà : elle n'apparaît qu'à partir de deux activités. */
        bar.hidden = vraies.length < 2;
        bar.innerHTML = vraies.map(l => {
            const m = PROFILE_BY_KIND[l.kind];
            return `<span class="dp-seg" style="width:${Math.max(0, Math.min(100, l.share))}%;`
                + `background:${m ? m.color : 'var(--gray-300)'}"></span>`;
        }).join('') + (total < 100
            ? `<span class="dp-seg dp-seg--rest" style="width:${100 - total}%"></span>` : '');
    }

    const rest = box.querySelector('[data-dp-rest]');
    if (rest) {
        if (vraies.length < 2 || total === 100) {
            rest.className = 'dp-rest';
            rest.innerHTML = vraies.length === 1
                ? 'Une seule activité : elle occupe toute la journée.'
                : (vraies.length ? 'La journée est répartie en entier.' : '');
        } else if (total < 100) {
            rest.className = 'dp-rest';
            rest.innerHTML = `Il reste <b>${100 - total} %</b> de la journée non affectés. `
                + `Rien n'oblige à arriver à cent.`;
        } else {
            rest.className = 'dp-rest dp-rest--over';
            rest.innerHTML = `<b>${total} %</b> déclarés, soit ${total - 100} de plus qu'une journée.`;
        }
    }

    const st = box.querySelector('[data-dp-state]');
    if (st) st.textContent = vraies.length ? '' : 'Non renseigné';
}

/**
 * Envoi du profil complet. Anti-rebond court : cliquer trois fois de suite sur
 * les boutons de part ne doit pas produire trois écritures, et la date est
 * capturée à la programmation pour qu'un envoi en retard n'atterrisse jamais
 * sur la journée suivante.
 */
function pousseProfil(ms = 500) {
    if (!allowWrite()) return;
    const iso = day;
    const lignes = profilVrai().map(l => ({ kind: l.kind, share: l.share, label: l.label }));

    schedule('profil', () => {
        inflight++;
        status('Enregistrement…', 'saving');
        enqueue(async () => {
            try {
                await saveDayProfile(iso, lignes);
                inflight--;
                settle();
            } catch (e) {
                inflight--;
                settle();
                toast(humanError(e), 'error', 6000);
                /* On ne sait plus ce que contient la base : on relit plutôt que
                   de laisser à l'écran une répartition qui n'y est pas. */
                if (iso === day) {
                    try { profil = await fetchDayProfile(iso); paintProfil(); }
                    catch { /* la relecture a échoué aussi, l'écran garde son état */ }
                }
            }
        });
    }, ms);
}

function ajouteProfilLigne() {
    if (profil.some(l => !l.kind)) return;                       // déjà une ligne en attente
    if (profilVrai().length >= DAY_PROFILE_KINDS.length) return; // les cinq sont prises
    profil.push({ kind: '', share: null, label: '' });
    paintProfil();
    const sels = $('#day-profile').querySelectorAll('.dp-kind');
    if (sels.length) sels[sels.length - 1].focus();
}

function poseProfilKind(i, kind) {
    const l = profil[i];
    if (!l) return;
    if (!kind) { retireProfilLigne(i); return; }
    if (!allowWrite()) { paintProfil(); return; }

    const nouvelle = !l.kind;
    l.kind = kind;
    if (nouvelle || l.share == null) attribuePart(i);
    // Changer Salon en Prospection efface la précision : elle nommait le salon.
    if (!PROFILE_BY_KIND[kind].named) l.label = '';
    paintProfil();
    pousseProfil();
}

function retireProfilLigne(i) {
    const l = profil[i];
    if (!l) return;
    if (l.kind && !allowWrite()) { paintProfil(); return; }

    const avaitUneCategorie = !!l.kind;
    profil.splice(i, 1);

    /* Quand il ne reste qu'une activité, elle reprend toute la journée. Laisser
       une ligne unique à 50 % obligerait à lire « il reste 50 % » sur une
       journée qui n'a plus qu'une seule chose dedans. */
    const restantes = profilVrai();
    if (restantes.length === 1) restantes[0].share = 100;

    paintProfil();
    if (avaitUneCategorie) pousseProfil(200);
}

/** Valeur tapée dans le champ. Une frappe intermédiaire vide ne remet rien à zéro. */
function poseProfilPart(i, brut, { repeint = false } = {}) {
    const l = profil[i];
    if (!l || !l.kind) return;
    const n = parseInt(String(brut).replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(n) || n <= 0) return;
    l.share = Math.min(100, n);
    if (repeint) paintProfil(); else paintProfilMeta();
    pousseProfil(repeint ? 300 : 800);
}

function poseProfilLabel(i, v) {
    const l = profil[i];
    if (!l || !l.kind) return;
    l.label = String(v).slice(0, 80);
    pousseProfil(1000);
}

/** Branchements. Une seule délégation sur le conteneur, qui est reconstruit sans arrêt. */
function brancheProfil() {
    const box = $('#day-profile');
    if (!box) return;
    const rang = el => {
        const li = el.closest('.dp-line');
        return li ? Number(li.dataset.i) : -1;
    };

    box.addEventListener('click', ev => {
        if (ev.target.closest('[data-dp-add]')) { ajouteProfilLigne(); return; }
        const del = ev.target.closest('[data-dp-del]');
        if (del) { retireProfilLigne(rang(del)); return; }
        const part = ev.target.closest('[data-dp-part]');
        if (part) { poseProfilPart(rang(part), part.dataset.dpPart, { repeint: true }); }
    });

    box.addEventListener('change', ev => {
        const sel = ev.target.closest('[data-dp-kind]');
        if (sel) poseProfilKind(rang(sel), sel.value);
    });

    box.addEventListener('input', ev => {
        const pct = ev.target.closest('[data-dp-pct]');
        if (pct) { poseProfilPart(rang(pct), pct.value); return; }
        const lab = ev.target.closest('[data-dp-label]');
        if (lab) poseProfilLabel(rang(lab), lab.value);
    });

    /* À la sortie du champ, la valeur est remise au propre : « 007 » redevient
       7, un champ vidé retrouve sa valeur, et les boutons se rallument sur la
       bonne part. Pendant la frappe, on ne touche à rien. */
    box.addEventListener('focusout', ev => {
        if (ev.target.closest('[data-dp-pct]')) paintProfil();
    });
}

(async function init() {
    session = await requireAuth({ needs: 'bdr' });

    /* Les réglages avant la construction des cartes : les aides de saisie citent
       le seuil « contact connu », et loadSettings le substitue dans METRICS. Les
       construire avant afficherait la valeur de repli, puis plus rien ne la
       corrigerait — les libellés ne sont écrits qu'une fois. Ne lève pas : un
       seuil illisible ne doit pas empêcher de saisir sa journée. */
    await loadSettings();

    myMetrics = metricsFor(viewedProfile());
    hasEvents = myMetrics.some(m => isEventMetric(m.key));

    /* v19 : L'ÉCHELLE EST CELLE DE LA PERSONNE REGARDÉE, et non plus celle du
       lecteur. La règle précédente se défendait — une préférence d'affichage
       appartient à celui qui lit — mais elle produisait un écran qui n'était
       celui de personne : les compteurs de Santiago, ses objectifs, et le
       découpage du temps de son manager. Voir ce qu'il voit suppose de le voir
       à son échelle, sinon la comparaison des jauges ne veut rien dire.

       Le changement d'échelle reste possible pendant la consultation, mais il
       n'est PAS enregistré chez elle : voir setScale.

       Posée avant tout rendu : buildTargets() et paintDateBar() la lisent, et
       les voir afficher le jour une fraction de seconde avant de sauter au mois
       serait le genre de clignotement qui fait douter de ce qu'on lit. */
    scale = scaleOf(viewedProfile());

    /* Les exceptions par compteur suivent la même règle que l'échelle de la
       page : ce sont celles de la personne regardée, pas celles du lecteur. */
    echelles = metricScalesOf(viewedProfile());
    renderNav();
    renderIdentity();
    buildCards();
    buildScoreExplain();

    /* Les deux lectures partent ensemble : le carnet d'entreprises n'a aucune
       raison d'attendre les objectifs. allSettled et non all, parce que l'échec
       de l'un ne doit pas emporter l'autre. */
    const [, , resAccounts] = await Promise.allSettled([
        loadTargets(),
        loadVisibility(),
        hasEvents ? loadAccounts() : Promise.resolve([])
    ]);
    /* loadTargets ne lève pas : une migration non passée laisse les jauges
       vides, ce que le panneau des objectifs annonce en clair, mais n'empêche
       personne de saisir sa journée. C'est la seule chose qui compte ici. */
    /* Le carnet est un confort, pas une condition : sans lui l'autocomplétion
       ne propose rien, mais on peut toujours taper un nom et la base le créera,
       en refusant le doublon comme d'habitude. On ne bloque donc pas la page. */
    if (resAccounts.status === 'rejected') {
        toast("Le carnet d'entreprises n'a pas pu être chargé : les suggestions sont "
            + 'indisponibles, la saisie fonctionne normalement.', 'error', 7000);
    }
    /* Après les objectifs, jamais avant : la visibilité se peint sur des jauges
       qui doivent déjà exister. loadVisibility() ne lève pas non plus, et son
       échec laisse tous les objectifs affichés, ce qui est le bon défaut. */
    appliqueVisibilite();
    buildTargets();

    /* Le profil de la journée (v22). La délégation est posée une bonne fois sur
       le conteneur, qui n'est jamais remplacé : seul son contenu est reconstruit,
       et il l'est à chaque geste. Poser les écouteurs sur les boutons eux-mêmes
       obligerait à les reposer à chaque rendu. */
    brancheProfil();

    const wanted = new URLSearchParams(location.search).get('date');
    const valid = wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) && diffDays(todayISO(), wanted) >= 0;
    await load(valid ? wanted : todayISO());

    $('#day-prev').addEventListener('click', () => load(addDaysISO(day, -1)));
    $('#day-next').addEventListener('click', () => {
        const next = addDaysISO(day, 1);
        if (diffDays(todayISO(), next) >= 0) load(next);
    });
    $('#day-picker').addEventListener('change', e => {
        const v = e.target.value;
        if (!v) return;
        if (diffDays(todayISO(), v) < 0) { toast('On ne saisit pas une journée à venir.', 'error'); e.target.value = day; return; }
        load(v);
    });
    $('#chip-today').addEventListener('click', () => load(todayISO()));
    $('#chip-yesterday').addEventListener('click', () => load(addDaysISO(todayISO(), -1)));

    /* Délégation sur le conteneur : trois boutons écrits en dur dans la page,
       donc trois écouteurs auraient tout aussi bien marché, mais la délégation
       survit au jour où une quatrième échelle serait ajoutée au HTML. */
    $('#scale-seg').addEventListener('click', ev => {
        const b = ev.target.closest('button[data-scale]');
        if (b) setScale(b.dataset.scale);
    });

    // Si l'onglet reste ouvert au passage de minuit, on recale la date du jour.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && day !== todayISO() && !new URLSearchParams(location.search).get('date')) {
            load(todayISO());
        }
    });

    hideVeil();
})();
