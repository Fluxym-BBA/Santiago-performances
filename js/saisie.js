/* ==========================================================================
   SAISIE.JS — Page de saisie quotidienne.
   Principe : aucune action de validation. Chaque clic ou frappe est persistée.

   Trois chemins d'écriture, et un seul upsert :
     - boutons + / −  : bump_metric, incrément atomique côté base ;
     - frappe directe : set_metric, valeur exacte, anti-rebond de 600 ms ;
     - note du jour   : upsert classique, aucune contrainte ne la relie à rien.

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
    saveDay, bump, setMetric, fetchTargets, saveTargets, humanError,
    SCORE_WEIGHTS, scoreOf, isViewingOther, viewedProfile
} from './api.js';
import { $, toast, fmtInt, fmtDec, delta, hideVeil, escapeHtml } from './ui.js';
import { renderNav } from './nav.js';

let session = null;
let day = todayISO();       // date en cours de saisie
let row = { ...EMPTY_DAY };  // valeurs affichées
let prevRow = null;          // veille, pour la comparaison
let targets = {};

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

/* Le score est calculé côté client pour un affichage instantané, à partir de
   SCORE_WEIGHTS (source unique partagée avec le dashboard). La vue SQL
   v_daily_kpi reste la référence côté base. */

/* --------------------------------------------------------------------------
   Rendu des lignes de métriques
   -------------------------------------------------------------------------- */

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
        <div class="gauge">
            <div class="gauge-track"><div class="gauge-fill" id="gauge-${m.key}" style="width:0%"></div></div>
            <div class="gauge-legend">
                <span>Objectif : <b id="target-${m.key}">–</b></span>
                <span id="gauge-pct-${m.key}">0 %</span>
            </div>
        </div>
    </div>`;
}

function buildCards() {
    ['crm', 'calls', 'emails'].forEach(group => {
        const host = document.querySelector(`[data-metrics="${group}"]`);
        if (host) host.innerHTML = METRICS.filter(m => m.group === group).map(metricRowHtml).join('');
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
   Rendu
   -------------------------------------------------------------------------- */

function paintGauge(m) {
    const t = Number(targets[m.target]) || 0;
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
    const rdv = Number(row.meetings_booked) || 0;

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

    const crmTotal = (Number(row.companies_created) || 0) + (Number(row.contacts_created) || 0);
    const prospTotal = calls + (Number(row.emails_sent) || 0);
    document.querySelector('[data-total="crm"]').textContent = fmtInt(crmTotal);
    document.querySelector('[data-total="prospection"]').textContent = fmtInt(prospTotal);
    $('#day-score').textContent = fmtInt(scoreOf(row));

    const prevScore = prevRow ? scoreOf(prevRow) : 0;
    $('#kpi-prev').innerHTML = prevRow
        ? delta(scoreOf(row), prevScore).html
        : '<span class="delta delta--flat">pas de donnée</span>';
}

function paint() {
    METRICS.forEach(m => {
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
        const [current, previous] = await Promise.all([fetchDay(iso), fetchDay(addDaysISO(iso, -1))]);
        row = current || { ...EMPTY_DAY, activity_date: iso, notes: '' };
        prevRow = previous;
        paint();
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
    host.innerHTML = `
        <details class="chart-note">
            <summary>Comment est calculé ce score ?</summary>
            <p>
                Chaque action du jour est multipliée par un poids, puis tout est additionné.
                Un rendez-vous vaut 20 points parce qu'un BDR est jugé sur ses rendez-vous,
                pas sur son volume d'appels.
            </p>
            <div class="weights" style="margin:14px 0 0">
                ${SCORE_WEIGHTS.map(w => `
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

function buildTargets() {
    $('#targets-grid').innerHTML = METRICS.map(m => `
        <div class="field">
            <label for="t-${m.target}">${escapeHtml(m.short)}</label>
            <input type="number" min="0" step="1" id="t-${m.target}"
                   value="${Number(targets[m.target]) || 0}">
        </div>`).join('');

    $('#targets-save').addEventListener('click', async () => {
        const patch = {};
        METRICS.forEach(m => {
            const v = parseInt(document.getElementById(`t-${m.target}`).value, 10);
            patch[m.target] = Number.isNaN(v) || v < 0 ? 0 : v;
        });
        try {
            targets = { ...targets, ...(await saveTargets(patch, session)) };
            METRICS.forEach(paintGauge);
            toast('Objectifs enregistrés', 'success');
            $('#targets-panel').open = false;
        } catch (e) {
            toast(humanError(e), 'error', 5000);
        }
    });
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

(async function init() {
    session = await requireAuth({ needs: 'bdr' });
    renderNav();
    renderIdentity();
    buildCards();
    buildScoreExplain();

    try {
        targets = await fetchTargets();
    } catch (e) {
        toast(humanError(e), 'error');
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
