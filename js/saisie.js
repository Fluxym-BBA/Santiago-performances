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
    addDaysISO, formatLong, relativeLabel, diffDays, fetchDay,
    saveDay, bump, setMetric, loadTargets, targetFor, targetsLoaded, humanError,
    SCORE_WEIGHTS, scoreOf, isViewingOther, viewedProfile, metricsFor,
    SALES_EVENT_KINDS, isEventMetric, cleanAccountName, accountKey,
    loadAccounts, searchAccounts, ensureAccount, accountByName, similarAccounts,
    fetchDayEvents, addSalesEvent, deleteSalesEvent,
    accountHistory, agoLabel, formatDMY
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
function gaugeHtml(m) {
    if (!m.target) return '';
    return `
        <div class="gauge">
            <div class="gauge-track"><div class="gauge-fill" id="gauge-${m.key}" style="width:0%"></div></div>
            <div class="gauge-legend">
                <span>Objectif : <b id="target-${m.key}">–</b></span>
                <span id="gauge-pct-${m.key}">0 %</span>
            </div>
        </div>`;
}

function metricRowHtml(m) {
    return `
    <div class="metric" data-metric="${m.key}">
        <div class="metric-top">
            <div class="metric-label">
                <b>${escapeHtml(m.label)}</b>
                <span>${escapeHtml(m.hint)}</span>
            </div>
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
   sous-titres de la carte Prospection. On masque en style plutôt qu'en
   supprimant : les éléments de total restent dans le document, ce qui évite un
   garde-fou dans chaque fonction d'affichage. */
function buildCards() {
    ['crm', 'calls', 'emails', 'pipeline', 'outcome'].forEach(group => {
        const host = document.querySelector(`[data-metrics="${group}"]`);
        if (!host) return;
        const list = myMetrics.filter(m => m.group === group);
        host.innerHTML = list.map(m => isEventMetric(m.key) ? eventRowHtml(m) : metricRowHtml(m)).join('');
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

/* Chaîne des appels, du plus large au plus étroit. La base impose
   appels ⊇ aboutis ⊇ échanges, et c'est voulu. */
const CALL_CHAIN = [
    { key: 'calls_made', label: 'appels passés' },
    { key: 'calls_connected', label: 'appels aboutis' },
    { key: 'calls_engaged', label: 'appels avec échange' }
];

/**
 * Plutôt que d'envoyer une écriture qui sera refusée par la base, on dit tout
 * de suite ce qui bloque et ce qu'il faut faire. Le contrôle porte sur ce qui
 * est à l'écran, frappe en attente comprise, pas sur ce que la base contient.
 * Renvoie null si la valeur est acceptable, sinon le message à afficher.
 */
function incoherence(key, v) {
    const rang = CALL_CHAIN.findIndex(s => s.key === key);
    if (rang < 0) return null;
    const val = i => (CALL_CHAIN[i].key === key ? v : Number(row[CALL_CHAIN[i].key]) || 0);

    for (let i = 1; i < CALL_CHAIN.length; i++) {
        const haut = val(i - 1);
        const bas = val(i);
        if (bas <= haut) continue;
        const nomHaut = CALL_CHAIN[i - 1].label;
        const nomBas = CALL_CHAIN[i].label;
        // Le champ que l'on est en train de saisir est-il celui du bas ?
        if (i === rang) {
            return `${fmtInt(bas)} ${nomBas} pour ${fmtInt(haut)} ${nomHaut} : saisissez d'abord `
                 + `le nombre d'${nomHaut}, la valeur sera enregistrée juste après.`;
        }
        return `${fmtInt(bas)} ${nomBas} sont déjà saisis : le nombre d'${nomHaut} ne peut pas `
             + `descendre à ${fmtInt(haut)}. Corrigez les ${nomBas} d'abord.`;
    }
    return null;
}

/** Vrai si la base a refusé au nom de la cohérence appels / aboutis. */
function isCoherence(e) {
    return !!e && (e.code === '23514' || /calls_coherent/.test(e.message || ''));
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
    if (!isViewingOther() || fixConfirmed) return true;
    const v = viewedProfile();
    const name = v.display_name || v.email || 'cet utilisateur';
    const ok = confirm(
        `Vous allez modifier la saisie de ${name}.\n\n`
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
    const badge = document.querySelector('.hero-badge');
    const title = document.querySelector('.page-hero h1');
    const sub = document.querySelector('.page-hero p');
    if (badge) badge.textContent = 'Correction';
    if (title) title.innerHTML = `Corriger la saisie de <em>${escapeHtml(name)}</em>`;
    if (sub) {
        sub.innerHTML = `Vous n'êtes pas sur votre propre journée. Chaque modification sera `
            + `enregistrée sur le compte de <b>${escapeHtml(name)}</b> et marquée comme une `
            + `correction. <a href="${escapeHtml(`./dashboard.html?u=${v.user_id}`)}">Retour à sa fiche</a>`;
    }
    document.title = `Corriger ${name} | Cockpit BDR — Fluxym`;
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

function paintGauge(m) {
    if (!m.target) return;   // compteur sans objectif : aucune jauge à peindre

    /* Depuis la v12, l'objectif vient de la base et non plus d'un réglage local :
       valeur de la personne si elle en a une, sinon celle de son métier, sinon
       aucune. Le troisième cas s'affiche « non défini », et c'est une
       information : personne n'a encore dit ce qu'on attendait ici. Un zéro
       affiché à la place aurait voulu dire « ne rien faire est l'objectif ». */
    const t = Number(targetFor(viewedProfile(), m.key, 'day').value) || 0;
    const mesure = row[m.key] != null;
    const v = Number(row[m.key]) || 0;
    const pct = mesure && t > 0 ? Math.min(100, (v / t) * 100) : 0;
    const fill = document.getElementById(`gauge-${m.key}`);
    if (!fill) return;
    fill.style.width = `${pct}%`;
    fill.classList.toggle('gauge-fill--done', mesure && t > 0 && v >= t);
    document.getElementById(`target-${m.key}`).textContent = t > 0 ? fmtInt(t) : 'non défini';
    // Journée non mesurée : ni pourcentage ni barre, sinon l'écran affirmerait
    // un zéro que personne n'a déclaré.
    document.getElementById(`gauge-pct-${m.key}`).textContent =
        !mesure ? 'non mesuré' : t > 0 ? `${Math.round((v / t) * 100)} %` : '—';
}

function paintDerived() {
    const calls = Number(row.calls_made) || 0;
    const conn = Number(row.calls_connected) || 0;
    /* Rendez-vous du jour : le RDV obtenu du BDR et le RDV1 tenu du commercial
       ne coexistent jamais chez la même personne, l'un des deux termes étant
       toujours nul. Pour qui a les deux métiers, les additionner est bien le
       sens voulu : ce sont deux rencontres différentes. */
    const rdv = (Number(row.meetings_booked) || 0) + (Number(row.first_meetings) || 0);

    $('#kpi-connect').textContent = calls > 0 ? `${fmtDec((conn / calls) * 100)} %` : '–';
    // Non mesuré et zéro ne s'affichent pas pareil : le premier est une absence
    // de donnée, le second un résultat.
    const eng = $('#kpi-engage');
    if (eng) {
        eng.textContent = row.calls_engaged == null ? 'non mesuré'
            : conn > 0 ? `${fmtDec(((Number(row.calls_engaged) || 0) / conn) * 100)} %` : '–';
    }
    $('#kpi-meeting').textContent = conn > 0 ? `${fmtDec((rdv / conn) * 100)} %` : '–';
    $('#kpi-effort').textContent = rdv > 0 ? `${fmtDec(calls / rdv)} appels` : '–';

    const total = (sel, v) => {
        const el = document.querySelector(`[data-total="${sel}"]`);
        if (el) el.textContent = fmtInt(v);
    };
    const num = k => Number(row[k]) || 0;
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

    $('#past-warning').innerHTML = isToday ? '' : `
        <div style="margin-top:14px">
            <span class="badge-past">✎ Vous modifiez une journée passée
            (${escapeHtml(relativeLabel(day))}). Les enregistrements restent immédiats.</span>
        </div>`;

    const prevIso = addDaysISO(day, -1);
    $('#kpi-prev-label').textContent = `Score du ${formatLong(prevIso).replace(/^\w+\s/, '')}`;
}

/* --------------------------------------------------------------------------
   Chargement d'un jour
   -------------------------------------------------------------------------- */

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
        // La troisième requête n'est envoyée que si la personne saisit un
        // compteur du cycle de vente : un BDR ne paie rien pour cette v10.
        const [current, previous, evts] = await Promise.all([
            fetchDay(iso),
            fetchDay(addDaysISO(iso, -1)),
            hasEvents ? fetchDayEvents(iso) : Promise.resolve([])
        ]);
        row = current || { ...EMPTY_DAY, activity_date: iso, notes: '' };
        prevRow = previous;
        events = evts;
        /* Les avertissements portent sur un ajout précis, pas sur la journée :
           les laisser en place après un changement de date les ferait lire comme
           s'ils concernaient le jour affiché. */
        SALES_EVENT_KINDS.forEach(hideWarn);
        paint();
        paintEventLists();
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
function buildTargets() {
    /* Seuls les compteurs affichés et pourvus d'un objectif : afficher un
       objectif de NO GO, ou l'objectif d'e-mails d'un commercial qui n'en saisit
       pas, serait afficher une ligne sans effet. */
    const montrables = myMetrics.filter(m => m.target);
    const qui = viewedProfile();

    const lignes = montrables.map(m => {
        const t = targetFor(qui, m.key, 'day');
        const val = t.source ? fmtInt(t.value) : '—';
        const src = t.source === 'user' ? 'objectif personnel'
                  : t.source === 'job'  ? 'objectif du métier'
                  : 'non défini';
        return `
        <div class="target-read">
            <div class="target-read-lab">${escapeHtml(m.short)}</div>
            <div class="target-read-val">${val}</div>
            <div class="target-read-src">${src}</div>
        </div>`;
    }).join('');

    const absent = !targetsLoaded();
    $('#targets-grid').innerHTML = lignes || '<p class="target-read-none">Aucun objectif ne '
        + "s'applique à ce profil.</p>";
    $('#targets-note').innerHTML = absent
        ? "Les objectifs n'ont pas pu être lus : la migration v12 n'est peut-être pas passée. "
        + 'La saisie fonctionne normalement, seules les jauges restent vides.'
        : 'Ces objectifs sont fixés par le propriétaire du Cockpit, écran « Barème et '
        + "objectifs ». Ils ne se règlent plus ici : un objectif se discute de vive voix.";
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

(async function init() {
    session = await requireAuth({ needs: 'bdr' });
    myMetrics = metricsFor(viewedProfile());
    hasEvents = myMetrics.some(m => isEventMetric(m.key));
    renderNav();
    renderIdentity();
    buildCards();
    buildScoreExplain();

    /* Les deux lectures partent ensemble : le carnet d'entreprises n'a aucune
       raison d'attendre les objectifs. allSettled et non all, parce que l'échec
       de l'un ne doit pas emporter l'autre. */
    const [, resAccounts] = await Promise.allSettled([
        loadTargets(),
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
    buildTargets();

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

    // Si l'onglet reste ouvert au passage de minuit, on recale la date du jour.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && day !== todayISO() && !new URLSearchParams(location.search).get('date')) {
            load(todayISO());
        }
    });

    hideVeil();
})();
