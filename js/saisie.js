/* ==========================================================================
   SAISIE.JS — Page de saisie quotidienne.
   Principe : aucune action de validation. Chaque clic ou frappe est
   persistée (incrément atomique côté base pour les boutons, upsert
   débattu de 600 ms pour la frappe directe).
   ========================================================================== */

import {
    requireAuth, METRICS, EMPTY_DAY, METRIC_BY_KEY, todayISO,
    addDaysISO, formatLong, relativeLabel, diffDays, fetchDay,
    saveDay, bump, fetchTargets, saveTargets, humanError,
    SCORE_WEIGHTS, scoreOf, isViewingOther, viewedProfile
} from './api.js';
import { $, toast, fmtInt, fmtDec, delta, hideVeil, escapeHtml } from './ui.js';
import { renderNav } from './nav.js';

let session = null;
let day = todayISO();       // date en cours de saisie
let row = { ...EMPTY_DAY };  // valeurs affichées
let prevRow = null;          // veille, pour la comparaison
let targets = {};
const timers = {};           // debounce par champ

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
        row.notes = e.target.value;
        schedule('notes', () => persist({ notes: e.target.value }), 900);
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

function schedule(key, fn, ms = 600) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(fn, ms);
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

async function persist(patch) {
    if (!allowWrite()) return;
    status('Enregistrement…', 'saving');
    try {
        const saved = await saveDay(day, patch, session);
        row = saved;
        paint();
        status('✓ Enregistré', 'saved');
    } catch (e) {
        status('⚠ Non enregistré', 'error');
        toast(humanError(e), 'error', 5000);
        await load(day);   // on resynchronise sur la vérité de la base
    }
}

async function onBump(key, d) {
    const before = Number(row[key]) || 0;
    if (d < 0 && before === 0) return;
    if (!allowWrite()) return;

    // Retour visuel immédiat, correction si la base refuse.
    row[key] = Math.max(0, before + d);
    paint();
    flash(key);
    status('Enregistrement…', 'saving');

    try {
        row = await bump(key, d, day);
        paint();
        status('✓ Enregistré', 'saved');
    } catch (e) {
        row[key] = before;
        paint();
        status('⚠ Non enregistré', 'error');
        toast(humanError(e), 'error', 5000);
    }
}

function onType(input) {
    const key = input.dataset.key;
    let v = parseInt(input.value, 10);
    if (Number.isNaN(v) || v < 0) v = 0;
    if (v > 9999) v = 9999;
    row[key] = v;
    paintDerived();
    paintGauge(METRIC_BY_KEY[key]);
    schedule(key, () => persist({ [key]: v }));
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
    const v = Number(row[m.key]) || 0;
    const pct = t > 0 ? Math.min(100, (v / t) * 100) : 0;
    const fill = document.getElementById(`gauge-${m.key}`);
    if (!fill) return;
    fill.style.width = `${pct}%`;
    fill.classList.toggle('gauge-fill--done', t > 0 && v >= t);
    document.getElementById(`target-${m.key}`).textContent = t > 0 ? fmtInt(t) : 'non défini';
    document.getElementById(`gauge-pct-${m.key}`).textContent =
        t > 0 ? `${Math.round((v / t) * 100)} %` : '—';
}

function paintDerived() {
    const calls = Number(row.calls_made) || 0;
    const conn = Number(row.calls_connected) || 0;
    const rdv = Number(row.meetings_booked) || 0;

    $('#kpi-connect').textContent = calls > 0 ? `${fmtDec((conn / calls) * 100)} %` : '–';
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
        if (input && document.activeElement !== input) input.value = Number(row[m.key]) || 0;
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
