/* ==========================================================================
   DASHBOARD.JS (v2) — Analyse de performance par comparaison de PÉRIODES.

   Modèle unique : une période A (analysée) face à une période B (référence).
   Une journée n'est qu'une période d'un jour, donc « aujourd'hui vs hier » et
   « juillet vs juin » empruntent exactement le même chemin de code.
   ========================================================================== */

import {
    requireAuth, METRICS, todayISO, addDaysISO, diffDays,
    formatLong, isWeekend, startOfWeek, endOfWeek, startOfMonth,
    endOfMonth, addMonthsISO, startOfQuarter, endOfQuarter, periodLength,
    previousPeriod, samePeriodLastYear, periodLabel, periodLabelShort, minISO,
    maxISO, fetchRange, fetchBestDay, humanError, SCORE_WEIGHTS,
    isViewingOther, viewedProfile, isAdmin, linkFor
} from './api.js';
import {
    num, score, isActive, zeroDay, rowsForRange, agg, valOf, bucketize,
    autoGran, granWord, isMeasured, measuredSince, MEASURED_KEY
} from './analytics.js';
import {
    $, toast, fmtInt, fmtDec, delta,
    escapeHtml, hideVeil, lineChart, barChart, compareChart,
    funnel, legendHtml, onResize
} from './ui.js';
import { renderNav } from './nav.js';

/* --------------------------------------------------------------------------
   État
   -------------------------------------------------------------------------- */

const T = todayISO();

const state = {
    a: { from: addDaysISO(T, -6), to: T },
    b: { from: addDaysISO(T, -13), to: addDaysISO(T, -7) },
    preset: '7v7',
    gran: 'auto',
    mode: 'total',
    modeTouched: false,
    cumulMetric: 'meetings_booked'
};

let byDate = new Map();   // toutes les lignes chargées, indexées par date ISO
let loaded = { from: null, to: null };
let bestEver = null;      // meilleur jour absolu (vue v_best_day)

/* --------------------------------------------------------------------------
   Accès aux données
   -------------------------------------------------------------------------- */

/** Lignes d'une période, jours manquants complétés à zéro. */
const rowsFor = p => rowsForRange(byDate, p.from, p.to);

/** Valeur d'un agrégat selon le mode de lecture, avec le mode courant par défaut. */
const val = (a, key, mode = effMode()) => valOf(a, key, mode);

/* --------------------------------------------------------------------------
   Granularité et mode effectifs
   -------------------------------------------------------------------------- */

function effGran() {
    return state.gran === 'auto' ? autoGran(state.a.from, state.a.to) : state.gran;
}

const lengthsDiffer = () =>
    periodLength(state.a.from, state.a.to) !== periodLength(state.b.from, state.b.to);

/** Si les périodes n'ont pas la même longueur, comparer des cumuls n'a pas de sens. */
function effMode() {
    if (state.modeTouched) return state.mode;
    return lengthsDiffer() ? 'avg' : 'total';
}

/* --------------------------------------------------------------------------
   Périodes : raccourcis et recherche de la meilleure période équivalente
   -------------------------------------------------------------------------- */

const PRESETS = [
    { id: 'today', label: "Aujourd'hui vs hier", make: () => ({
        a: { from: T, to: T }, b: { from: addDaysISO(T, -1), to: addDaysISO(T, -1) } }) },
    { id: '7v7', label: '7 derniers jours vs 7 précédents', make: () => ({
        a: { from: addDaysISO(T, -6), to: T },
        b: { from: addDaysISO(T, -13), to: addDaysISO(T, -7) } }) },
    { id: '30v30', label: '30 derniers jours vs 30 précédents', make: () => ({
        a: { from: addDaysISO(T, -29), to: T },
        b: { from: addDaysISO(T, -59), to: addDaysISO(T, -30) } }) },
    { id: 'week', label: 'Cette semaine vs la dernière', make: () =>
        toDate({ from: startOfWeek(T), to: endOfWeek(T) },
               addDaysISO(startOfWeek(T), -7), addDaysISO(startOfWeek(T), -1)) },
    { id: 'month', label: 'Ce mois vs le mois dernier', make: () =>
        toDate({ from: startOfMonth(T), to: endOfMonth(T) },
               startOfMonth(addMonthsISO(T, -1)), endOfMonth(addMonthsISO(T, -1))) },
    { id: 'monthY', label: 'Ce mois vs le même mois un an avant', make: () =>
        toDate({ from: startOfMonth(T), to: endOfMonth(T) },
               startOfMonth(addMonthsISO(T, -12)), endOfMonth(addMonthsISO(T, -12))) },
    { id: 'quarter', label: 'Ce trimestre vs le précédent', make: () =>
        toDate({ from: startOfQuarter(T), to: endOfQuarter(T) },
               startOfQuarter(addMonthsISO(startOfQuarter(T), -1)),
               endOfQuarter(addMonthsISO(startOfQuarter(T), -1))) }
];

/**
 * Comparaison « à date » : une période en cours est tronquée à aujourd'hui,
 * et la référence est tronquée à la même durée. Sans cela, comparer le 1-19 août
 * à un mois de juillet complet ferait croire à un effondrement de l'activité.
 */
function toDate(a, bFrom, bTo) {
    const aTo = minISO(a.to, T);
    const len = periodLength(a.from, aTo);
    return {
        a: { from: a.from, to: aTo },
        b: { from: bFrom, to: minISO(addDaysISO(bFrom, len - 1), bTo) }
    };
}

/**
 * Meilleure période de même longueur dans l'historique chargé, hors chevauchement
 * avec la période analysée. Généralise le « mon record » à n'importe quelle durée :
 * la meilleure semaine, le meilleur mois, la meilleure journée.
 */
function bestEquivalentPeriod(len, avoid) {
    let best = null;
    const last = addDaysISO(T, -len + 1);
    for (let start = loaded.from; diffDays(last, start) >= 0; start = addDaysISO(start, 1)) {
        const end = addDaysISO(start, len - 1);
        // On écarte toute fenêtre qui recouvre la période analysée
        if (!(diffDays(avoid.from, end) > 0 || diffDays(start, avoid.to) > 0)) continue;
        const s = rowsFor({ from: start, to: end }).reduce((t, r) => t + score(r), 0);
        if (s > 0 && (!best || s > best.score)) best = { from: start, to: end, score: s };
    }
    return best;
}

/* --------------------------------------------------------------------------
   Couleurs : deux familles, jamais du gris pour porter du sens.
   Période analysée  → camaïeu de bleu Fluxym.
   Période référence → camaïeu de violet.
   L'intensité distingue les métriques à l'intérieur d'une même famille.
   -------------------------------------------------------------------------- */

const A_SHADES = ['#00A7E1', '#0369a1', '#0B2046'];
const B_SHADES = ['#8b5cf6', '#6d28d9', '#4c1d95'];
const A_MAIN = A_SHADES[0];
const B_MAIN = B_SHADES[0];

/* Camaïeux à quatre crans, pour tout ce dont le nombre de séries dépend de
   METRICS ou du nombre d'étages d'un entonnoir.

   Le groupe « appels » est passé de trois à quatre métriques avec l'arrivée des
   appels avec échange : A_SHADES[3] valait undefined, donc la quatrième série,
   les rendez-vous, était dessinée avec une couleur vide. Les trois premiers
   crans des rampes restent volontairement proches des A_SHADES pour ne pas
   changer la lecture des graphiques qui n'ont pas bougé. */
const A_RAMP = ['#00A7E1', '#0284c7', '#0369a1', '#0B2046'];
const B_RAMP = ['#a78bfa', '#8b5cf6', '#6d28d9', '#4c1d95'];

/* --------------------------------------------------------------------------
   Métrique mesurée en cours de route

   Les appels avec échange ne sont comptés que depuis le 25/08/2026 : avant, le
   compteur n'existait pas à l'écran. Un écran qui afficherait zéro raconterait
   une progression qui n'a jamais eu lieu, et un taux calculé sur toute la
   période diviserait un numérateur de trois semaines par un dénominateur de
   trois mois. La frontière est la date, pas le fait d'avoir touché le compteur :
   ne rien saisir vaut zéro, comme pour les six autres.

   Règle appliquée partout dans ce fichier :
   - un volume peut s'afficher sur la sous-période mesurée, en le disant ;
   - un TAUX ne s'affiche que si la période est mesurée de bout en bout, sinon
     ses deux termes ne portent pas sur le même périmètre ;
   - un étage d'entonnoir n'apparaît que si les DEUX périodes le sont, sinon on
     comparerait un entonnoir à quatre étages à un entonnoir à trois.
   -------------------------------------------------------------------------- */

/** Vrai si l'agrégat porte au moins une journée mesurée. */
const hasMeasured = a => (a?.measuredDays || 0) > 0;

/**
 * Phrase courte sur la couverture de mesure, ou chaîne vide s'il n'y a rien à
 * signaler. La référence est la date : les journées antérieures à l'ouverture
 * du compteur sont hors calcul, celles d'après y sont toutes, qu'elles aient
 * été renseignées ou non.
 */
function measureGap(a) {
    if (!a || !a.activeDays) return '';
    const m = a.measuredActiveDays || 0;
    if (m === a.activeDays) return '';
    return m === 0
        ? 'compteur pas encore ouvert sur cette période'
        : `${a.activeDays - m} des ${a.activeDays} journées saisies sont antérieures à l'ouverture du compteur`;
}

// granWord vient d'analytics.js
const granWordPlural = g => ({ day: 'jours', week: 'semaines', month: 'mois' }[g || effGran()]);

/** Libellé de période prêt à afficher dans une légende. */
const pLab = p => periodLabelShort(p.from, p.to);

function currentStreak() {
    let n = 0;
    let iso = T;
    if (!isActive(byDate.get(iso))) iso = addDaysISO(iso, -1);
    while (diffDays(iso, loaded.from) >= 0) {
        if (isWeekend(iso)) { iso = addDaysISO(iso, -1); continue; }
        if (!isActive(byDate.get(iso))) break;
        n++;
        iso = addDaysISO(iso, -1);
    }
    return n;
}

/* --------------------------------------------------------------------------
   Identité consultée

   Quand un administrateur ouvre la fiche de quelqu'un, la page doit dire de
   qui il s'agit dès le premier coup d'oeil, et rester en lecture seule. La
   correction reste possible mais demande un geste explicite : c'est ce qui
   remplace l'ancien sélecteur permanent, où l'on pouvait écrire dans le
   mauvais compte sans s'en rendre compte.
   -------------------------------------------------------------------------- */

/** Adapte le titre de la page au profil consulté. */
function renderIdentity() {
    if (!isViewingOther()) return;
    const v = viewedProfile();
    const name = v.display_name || v.email || 'cet utilisateur';

    const badge = document.querySelector('.hero-badge');
    const title = document.querySelector('.page-hero h1');
    const sub = document.querySelector('.page-hero p');
    if (badge) badge.textContent = 'Fiche d\'un BDR';
    if (title) title.innerHTML = `${escapeHtml(name)}, <em>en détail</em>`;
    if (sub) {
        sub.innerHTML = `Vous consultez les performances de <b>${escapeHtml(name)}</b>`
            + `${v.email ? ` (${escapeHtml(v.email)})` : ''}, en lecture seule. `
            + `Les mêmes périodes, les mêmes graphiques et les mêmes info-bulles que sur votre propre page. `
            + `<a href="./team.html">Retour à l'équipe</a>`;
    }
    document.title = `${name} | Cockpit BDR — Fluxym`;
}

/**
 * Lien de modification d'une journée.
 * Sur sa propre fiche, c'est un lien direct. Sur celle de quelqu'un d'autre,
 * c'est une correction : le mot le dit, et la page de saisie demandera
 * confirmation avant d'écrire.
 */
function editLink(iso) {
    if (!isViewingOther()) {
        return `<a class="link-edit" href="./index.html?date=${iso}">modifier</a>`;
    }
    if (!isAdmin()) return '<span class="td-muted">—</span>';
    const v = viewedProfile();
    return `<a class="link-edit link-edit--fix"
               href="${linkFor('./index.html', v.user_id, { date: iso })}"
               title="Corriger cette journée sur le compte de ${escapeHtml(v.display_name || v.email)}">corriger</a>`;
}

/* --------------------------------------------------------------------------
   Info-bulles

   Règle appliquée partout : on ne survole pas une série, on survole un MOMENT.
   Quel que soit l'élément visé (une barre, un point, une courbe de tendance,
   une ligne de référence), l'info-bulle donne l'ensemble des valeurs de ce
   moment sur la période analysée, les mêmes valeurs sur la période de
   référence, puis les écarts. Il n'y a donc jamais à survoler deux endroits
   pour comparer deux chiffres.

   Les modèles sont construits ici, dans le registre des graphiques, parce que
   c'est le seul endroit qui connaît à la fois les deux périodes. ui.js ne fait
   que déclencher l'affichage.
   -------------------------------------------------------------------------- */

/** Titre riche d'un paquet : date longue pour un jour, plage de dates sinon. */
function bucketTitle(b, gran) {
    if (!b || !b.rows.length) return '—';
    if (gran === 'day') return formatLong(b.key);
    const rs = b.rows;
    return `${b.label} · ${periodLabelShort(rs[0].activity_date, rs[rs.length - 1].activity_date)}`;
}

/**
 * Écart formaté entre deux valeurs, avec flèche, valeur absolue et pourcentage.
 * `dec` passe en décimal pour les moyennes, où arrondir à l'entier masquerait
 * l'écart réel entre 2,4 et 2,6.
 */
function dl(a, b, dec = false) {
    const va = Number(a) || 0, vb = Number(b) || 0;
    const diff = va - vb;
    const pct = vb !== 0 ? (diff / Math.abs(vb)) * 100 : null;
    const dir = diff > 0.0001 ? 'up' : diff < -0.0001 ? 'down' : 'flat';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '=';
    const n = dec ? fmtDec(Math.abs(diff)) : fmtInt(Math.abs(diff));
    const sign = dir === 'up' ? '+' : dir === 'down' ? '−' : '';
    const tail = pct === null
        ? (dir === 'flat' ? '' : ' · nouveau')
        : ` · ${pct > 0 ? '+' : '−'}${fmtDec(Math.abs(pct))} %`;
    return { dir, html: `<span class="delta delta--${dir}">${arrow} ${sign}${n}${tail}</span>` };
}

/** Écart entre deux taux : en points de pourcentage, jamais en pourcentage d'un pourcentage. */
function ppl(a, b) {
    if (a == null || b == null) return '<span class="delta delta--flat">= non comparable</span>';
    const d = a - b;
    const dir = d > 0.05 ? 'up' : d < -0.05 ? 'down' : 'flat';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '=';
    const sign = dir === 'up' ? '+' : dir === 'down' ? '−' : '';
    return `<span class="delta delta--${dir}">${arrow} ${sign}${fmtDec(Math.abs(d))} pt</span>`;
}

/** Ligne d'en-tête d'une section d'info-bulle pour la période analysée / la référence. */
const secA = (rows, ctx, head = null) => ({
    accent: 'a', badge: 'A', head: head || `Analysée · ${pLab(ctx.aP)}`, rows
});
const secB = (rows, ctx, head = null) => ({
    accent: 'b', badge: 'B', head: head || `Référence · ${pLab(ctx.bP)}`, rows
});

/** Taux d'un agrégat, écrits pour une info-bulle. */
/**
 * Phrase d'exemple sur les poids du score, construite depuis SCORE_WEIGHTS.
 * Écrite en dur, elle annonçait encore « un rendez-vous vaut 20 points » après
 * le passage à 25 : un texte d'explication faux est pire que pas de texte.
 */
function weightPhrase() {
    const pick = k => SCORE_WEIGHTS.find(x => x.key === k);
    const [rdv, eng, call] = ['meetings_booked', 'calls_engaged', 'calls_made'].map(pick);
    const bits = [];
    if (rdv) bits.push(`un rendez-vous vaut ${rdv.w} points`);
    if (eng) bits.push(`un appel avec échange ${eng.w}`);
    if (call) bits.push(`un appel simple ${call.w}`);
    return bits.join(', ');
}

function rateRows(a) {
    const pc = v => (v == null ? '–' : `${fmtDec(v)} %`);
    const base = [
        { label: 'Taux d\'aboutis', sub: 'aboutis / appels', value: pc(a.connect_rate), muted: true },
        { label: 'Taux de RDV', sub: 'RDV / aboutis', value: pc(a.meeting_rate), muted: true }
    ];
    /* Les deux taux d'échange n'apparaissent que si la période est mesurée de
       bout en bout : sur une période à cheval sur le 25/08, leur numérateur et
       leur dénominateur ne porteraient pas sur les mêmes journées. Mieux vaut
       ne rien afficher qu'afficher un chiffre qu'il faut savoir corriger de
       tête. */
    if (!a.fullyMeasured) return base;
    return [
        base[0],
        { label: 'Taux d\'échange', sub: 'échanges / aboutis', value: pc(a.engage_rate), muted: true },
        base[1],
        { label: 'RDV après échange', sub: 'RDV / échanges', value: pc(a.meeting_rate_engaged), muted: true }
    ];
}

/* --------------------------------------------------------------------------
   Registre des graphiques

   Une entrée = une carte. `render(host, ctx)` ne connaît que son conteneur et
   son contexte, si bien que le même code dessine la carte dans la grille et
   dans la fenêtre agrandie. Ajouter un graphique = ajouter une entrée.
   -------------------------------------------------------------------------- */

const CHARTS = [
    {
        key: 'compare', wide: true, icon: '📊',
        title: 'Comparaison action par action',
        sub: ctx => ctx.mode === 'avg'
            ? 'Moyenne par jour actif de chaque action, sur les deux périodes.'
            : 'Cumul de chaque action sur les deux périodes.',
        legend: ctx => [
            { periodStyle: 'a', color: A_MAIN, label: `Période analysée · ${pLab(ctx.aP)}` },
            { periodStyle: 'b', color: B_MAIN, label: `Référence · ${pLab(ctx.bP)}` }
        ],
        note: ctx => `Chaque ligne porte deux barres : en bleu la période analysée, en violet la référence. ` +
            `La valeur est inscrite en bout de barre, dans la couleur de sa période. ` +
            (ctx.mode === 'avg'
                ? `Les deux périodes n'ayant pas la même durée, les valeurs sont des <b>moyennes par jour actif</b> : comparer des cumuls donnerait un écart mécanique dû à la durée.`
                : `Les deux périodes ayant la même durée, les valeurs sont des <b>cumuls</b>.`),
        hover: () => `les deux valeurs de la ligne pointée, leur cumul, leur moyenne par jour actif, le nombre de jours saisis et le poids de l'action dans le score.`,
        render: (host, ctx) => {
            const aA = agg(ctx.aRows), aB = agg(ctx.bRows);
            const dec = ctx.mode === 'avg';
            const fmtV = v => (dec ? fmtDec(v) : fmtInt(v));
            const perDay = (a, key) => (a.activeDays > 0 ? fmtDec(a[key] / a.activeDays) : '–');

            compareChart(host, {
                rows: METRICS.map(m => ({
                    label: m.short, colorA: A_MAIN, colorB: B_MAIN,
                    a: val(aA, m.key, ctx.mode), b: val(aB, m.key, ctx.mode)
                })),
                labelA: `analysée (${pLab(ctx.aP)})`,
                labelB: `référence (${pLab(ctx.bP)})`,
                fmt: v => ctx.mode === 'avg' ? fmtDec(v) : fmtInt(v),
                height: ctx.big ? 460 : undefined,
                // Survoler une ligne donne les deux périodes, le cumul, la
                // moyenne par jour actif et le nombre de jours saisis : de quoi
                // savoir si un écart vient du volume ou de la régularité.
                tip: i => {
                    const m = METRICS[i];
                    const w = SCORE_WEIGHTS.find(x => x.key === m.key);
                    const side = (a, color) => [
                        { color, label: m.short, value: fmtV(val(a, m.key, ctx.mode)), em: true },
                        { label: 'Cumul', value: fmtInt(a[m.key]), muted: true },
                        { label: 'Par jour actif', value: perDay(a, m.key), muted: true },
                        { label: 'Jours saisis', sub: `sur ${a.days} j`, value: fmtInt(a.activeDays), muted: true }
                    ];
                    return {
                        title: m.label,
                        meta: dec ? 'Moyenne par jour actif' : 'Cumul sur la période',
                        sections: [secA(side(aA, A_MAIN), ctx), secB(side(aB, B_MAIN), ctx)],
                        deltas: [{ label: 'Écart A − B', html: dl(val(aA, m.key, ctx.mode), val(aB, m.key, ctx.mode), dec).html }],
                        foot: `${escapeHtml(m.hint)}${w ? ` · pèse <b>${w.w} point${w.w > 1 ? 's' : ''}</b> dans le score` : ''}`
                    };
                }
            });
        }
    },
    {
        key: 'cumul', wide: true, icon: '🏁',
        title: 'Course cumulée entre les deux périodes',
        sub: () => 'Les deux périodes démarrent au même point de départ, jour 1 contre jour 1.',
        select: {
            options: () => [
                { v: 'meetings_booked', t: 'Rendez-vous' },
                { v: 'calls_made', t: 'Appels' },
                { v: 'calls_connected', t: 'Appels aboutis' },
                { v: 'calls_engaged', t: 'Appels avec échange' },
                { v: 'emails_sent', t: 'E-mails' },
                { v: 'productivity_score', t: 'Score' }
            ],
            get: () => state.cumulMetric,
            set: v => { state.cumulMetric = v; }
        },
        legend: ctx => [
            { color: A_MAIN, shape: 'line', label: `Période analysée · ${pLab(ctx.aP)}` },
            { color: B_MAIN, shape: 'dash', label: `Référence · ${pLab(ctx.bP)}` }
        ],
        note: () => `Chaque courbe additionne les résultats jour après jour depuis le début de sa période. ` +
            `Tant que la courbe bleue reste <b>au-dessus</b> de la violette, vous faites mieux qu'à la référence ` +
            `au même stade d'avancement. C'est la lecture la plus utile en cours de mois : elle répond à ` +
            `« suis-je en avance ou en retard ? » sans attendre la fin de la période.`,
        hover: () => `les vraies dates du jour pointé dans chacune des deux périodes, le cumul atteint de part et d'autre, la valeur du jour, et l'avance ou le retard exact.`,
        render: (host, ctx) => {
            const key = state.cumulMetric;
            const label = { meetings_booked: 'RDV', calls_made: 'appels', calls_connected: 'aboutis',
                calls_engaged: 'échanges', emails_sent: 'e-mails', productivity_score: 'points' }[key];
            /* Sur la métrique ouverte en cours de route, la courbe ne démarre
               qu'au premier jour compté. Sans cela, un cumul parti de zéro le
               22 mai ferait croire à trois mois sans une seule conversation,
               puis à un décollage soudain le 25 août. */
            const cum = rows => {
                let t = null;
                return rows.map(r => {
                    if (key === MEASURED_KEY && t === null && !isMeasured(r)) return null;
                    t = (t || 0) + num(r, key);
                    return t;
                });
            };
            const ca = cum(ctx.aRows), cb = cum(ctx.bRows);
            const n = Math.max(ca.length, cb.length);
            const pad = arr => Array.from({ length: n }, (_, i) => (i < arr.length ? arr[i] : null));
            const pa = pad(ca), pb = pad(cb);
            const metricLabel = { meetings_booked: 'Rendez-vous', calls_made: 'Appels',
                calls_connected: 'Appels aboutis', calls_engaged: 'Appels avec échange',
                emails_sent: 'E-mails', productivity_score: 'Score' }[key];

            lineChart(host, {
                labels: Array.from({ length: n }, (_, i) => `J${i + 1}`),
                series: [
                    { name: `analysée (${label})`, color: A_MAIN, values: pa, area: true },
                    { name: `référence (${label})`, color: B_MAIN, values: pb, dashed: true }
                ],
                height: ctx.big ? 440 : 260,
                // L'axe des abscisses porte « J1, J2… » : l'info-bulle rétablit
                // les vraies dates de chaque période, sinon « J12 » ne veut rien dire.
                tip: i => {
                    const ra = ctx.aRows[i], rb = ctx.bRows[i];
                    const line = (row, cumv, color, per) => [
                        { color, label: `Cumul ${label}`, value: cumv == null ? '–' : fmtInt(cumv), em: true },
                        { label: 'Ce jour-là',
                          value: !row ? '–'
                              : (key === MEASURED_KEY && !isMeasured(row) ? 'pas encore compté' : fmtInt(num(row, key))),
                          muted: true },
                        { label: 'Score du jour', value: row ? fmtInt(score(row)) : '–', muted: true }
                    ];
                    const ahead = pa[i] != null && pb[i] != null ? pa[i] - pb[i] : null;
                    return {
                        title: `Jour ${i + 1} de chaque période`,
                        meta: metricLabel + ' — total accumulé depuis le départ',
                        sections: [
                            secA(line(ra, pa[i], A_MAIN), ctx,
                                ra ? formatLong(ra.activity_date) : 'période terminée'),
                            secB(line(rb, pb[i], B_MAIN), ctx,
                                rb ? formatLong(rb.activity_date) : 'période terminée')
                        ],
                        deltas: [{ label: ahead == null ? 'Écart' : (ahead >= 0 ? 'Avance' : 'Retard'),
                                   html: dl(pa[i], pb[i]).html }],
                        foot: ahead == null ? 'Une des deux périodes est plus courte.'
                            : ahead > 0 ? 'Vous êtes <b>devant</b> la référence à ce stade.'
                            : ahead < 0 ? 'Vous êtes <b>derrière</b> la référence à ce stade.'
                            : 'À égalité parfaite à ce stade.'
                    };
                }
            });
        }
    },
    {
        key: 'score', wide: true, icon: '⚡',
        title: 'Score de productivité dans le temps',
        sub: ctx => `Un point par ${granWord(ctx.gran)}, sur la période analysée.`,
        legend: ctx => [
            { color: A_MAIN, shape: 'line', label: `Score par ${granWord(ctx.gran)}` },
            { color: A_SHADES[1], shape: 'dash', label: 'Tendance (moyenne des 7 derniers points)' },
            { color: B_MAIN, shape: 'dash', label: `Niveau moyen de la référence · ${pLab(ctx.bP)}` }
        ],
        note: () => `Le <b>score</b> résume une journée en un seul nombre : chaque action est multipliée par ` +
            `son poids (${weightPhrase()}) puis additionnée. Le détail du calcul ` +
            `est donné dans l'encadré bleu foncé en haut de la page.<br><br>` +
            `La <b>tendance</b> est une moyenne mobile sur 7 points : chaque point vaut la moyenne de lui-même ` +
            `et des 6 précédents. Elle efface les à-coups d'un jour isolé pour montrer le mouvement de fond. ` +
            `Si la courbe pleine zigzague mais que la tendance monte, la dynamique est bonne.<br><br>` +
            `Le <b>trait violet horizontal</b> est le score moyen de la période de référence, pour situer le niveau.`,
        hover: () => `le score du moment pointé, sa décomposition action par action en points gagnés, la tendance, le niveau de la référence, et l'écart avec le point précédent.`,
        render: (host, ctx) => {
            const buckets = bucketize(ctx.aRows, ctx.gran);
            const values = buckets.map(b => agg(b.rows).productivity_score);
            const ma = values.map((_, i) => {
                const w = values.slice(Math.max(0, i - 6), i + 1);
                return Math.round((w.reduce((x, y) => x + y, 0) / w.length) * 10) / 10;
            });
            const bBuckets = bucketize(ctx.bRows, ctx.gran);
            const bAvg = bBuckets.length
                ? bBuckets.reduce((t, b) => t + agg(b.rows).productivity_score, 0) / bBuckets.length : 0;
            lineChart(host, {
                labels: buckets.map(b => b.label),
                series: [
                    { name: 'Score', color: A_MAIN, values, area: true },
                    ...(values.length >= 5
                        ? [{ name: 'Tendance', color: A_SHADES[1], values: ma, dashed: true }] : [])
                ],
                refLines: bAvg > 0
                    ? [{ value: bAvg, color: B_MAIN, short: fmtInt(bAvg),
                         label: `Moyenne par ${granWord(ctx.gran)} de la référence : ${fmtDec(bAvg)}` }] : [],
                height: ctx.big ? 460 : 260,
                // Le score est un nombre composite : sans sa décomposition, il
                // dit qu'une journée a été bonne mais pas pourquoi. L'info-bulle
                // donne donc les points gagnés action par action, triés par poids réel.
                tip: i => {
                    const bk = buckets[i];
                    const a = agg(bk.rows);
                    const parts = SCORE_WEIGHTS
                        .map(w => ({ w, n: a[w.key], pts: a[w.key] * w.w }))
                        .filter(x => x.n > 0)
                        .sort((x, y) => y.pts - x.pts);
                    const top = parts[0];
                    return {
                        title: bucketTitle(bk, ctx.gran),
                        meta: `Score : ${fmtInt(values[i])} points`,
                        sections: [
                            secA([
                                { color: A_MAIN, label: 'Score', value: `${fmtInt(values[i])} pts`, em: true },
                                ...(values.length >= 5 ? [{ color: A_SHADES[1], shape: 'dash',
                                    label: 'Tendance', sub: '7 points glissants', value: fmtDec(ma[i]) }] : []),
                                { label: 'Jours saisis', sub: `sur ${bk.rows.length} j`,
                                  value: fmtInt(a.activeDays), muted: true }
                            ], ctx),
                            {
                                accent: 'a', head: 'D\u2019où viennent ces points',
                                rows: parts.length ? parts.map(x => ({
                                    label: `${x.w.icon} ${x.w.label}`,
                                    sub: `${fmtInt(x.n)} × ${x.w.w}`,
                                    value: `${fmtInt(x.pts)} pts`
                                })) : [{ label: 'Aucune action saisie', value: '0 pt', muted: true }]
                            },
                            secB([
                                { color: B_MAIN, shape: 'dash',
                                  label: `Moyenne par ${granWord(ctx.gran)}`,
                                  value: bAvg > 0 ? `${fmtDec(bAvg)} pts` : '–', em: true }
                            ], ctx)
                        ],
                        deltas: [
                            ...(bAvg > 0 ? [{ label: 'vs référence', html: dl(values[i], bAvg, true).html }] : []),
                            ...(i > 0 ? [{ label: `vs ${granWord(ctx.gran)} précédent`,
                                           html: dl(values[i], values[i - 1]).html }] : [])
                        ],
                        foot: top
                            ? `Poste dominant : <b>${escapeHtml(top.w.plural)}</b>, ` +
                              `${Math.round((top.pts / Math.max(1, values[i])) * 100)} % des points.`
                            : 'Aucune action enregistrée sur ce ' + granWord(ctx.gran) + '.'
                    };
                }
            });
        }
    },
    {
        key: 'calls', wide: true, icon: '📞',
        title: 'Activité téléphonique comparée',
        sub: ctx => `Volume par ${granWord(ctx.gran)}. Les deux panneaux partagent la même échelle verticale.`,
        legend: ctx => [
            { head: 'Bleu = période analysée · Violet = période de référence' },
            ...METRICS.filter(m => m.group === 'calls').map((m, i) => ({
                pair: [A_RAMP[i], B_RAMP[i]], label: m.short
            }))
        ],
        note: () => `Deux panneaux superposés plutôt qu'un seul graphique surchargé : ${
            METRICS.filter(m => m.group === 'calls').length * 2} séries mélangées dans ` +
            `la même grille deviennent illisibles. L'<b>échelle verticale est volontairement identique</b> sur ` +
            `les deux panneaux, donc une barre deux fois plus haute vaut réellement deux fois plus. ` +
            `Les périodes sont alignées sur leur premier ${granWord()}, ce qui permet de comparer même si ` +
            `elles ne portent pas sur les mêmes dates.`,
        hover: () => `les ${METRICS.filter(m => m.group === 'calls').length} volumes du moment pointé sur les <b>deux</b> panneaux à la fois, les taux de conversion, le score, et l'écart pour chaque série. Il n'y a pas à descendre la souris sur le second panneau.`,
        render: (host, ctx) => renderPanelPair(host, ctx, METRICS.filter(m => m.group === 'calls'))
    },
    {
        key: 'other', wide: true, icon: '✉️',
        title: 'E-mails et enrichissement CRM comparés',
        sub: ctx => `Volume par ${granWord(ctx.gran)}. Les deux panneaux partagent la même échelle verticale.`,
        legend: ctx => [
            { head: 'Bleu = période analysée · Violet = période de référence' },
            ...METRICS.filter(m => m.group !== 'calls').map((m, i) => ({
                pair: [A_RAMP[i], B_RAMP[i]], label: m.short
            }))
        ],
        note: () => `Même principe que l'activité téléphonique : deux panneaux, une seule échelle. ` +
            `L'enrichissement du CRM est un travail de fond dont l'effet se voit sur les semaines suivantes, ` +
            `pas le jour même : c'est le volume régulier qui compte, pas le pic.`,
        hover: () => `les volumes du moment pointé sur les <b>deux</b> panneaux à la fois, leur total, le score, et l'écart pour chaque série.`,
        render: (host, ctx) => renderPanelPair(host, ctx, METRICS.filter(m => m.group !== 'calls'))
    },
    {
        key: 'rates', wide: true, icon: '🎯',
        title: 'Taux de conversion comparés',
        sub: ctx => `Taux recalculés sur chaque ${granWord(ctx.gran)}, avec le niveau de la référence en repère.`,
        legend: ctx => [
            { color: A_SHADES[0], shape: 'line', label: 'Appels aboutis / appels passés (%)' },
            { color: A_SHADES[2], shape: 'line', label: 'RDV / appels aboutis (%)' },
            { color: A_RAMP[1], shape: 'line', label: 'RDV / appels avec échange (%)' },
            { color: B_MAIN, shape: 'dash', label: `Niveaux de la référence · ${pLab(ctx.bP)}` }
        ],
        note: () => `Les taux sont <b>recalculés à partir des volumes</b> de chaque ${granWord()} ` +
            `(somme des aboutis ÷ somme des appels), et non obtenus en moyennant des taux quotidiens : ` +
            `sinon un jour à 2 appels pèserait autant qu'un jour à 50.<br><br>` +
            `Les <b>traits violets horizontaux</b> donnent les taux de la période de référence. ` +
            `Lecture utile : un volume d'appels en hausse avec des taux qui passent sous les traits violets ` +
            `signale un problème de ciblage ou de discours, pas un manque d'effort.<br><br>` +
            `Le <b>RDV après échange</b> est le taux le plus proche de la réalité du métier : il ne compte au ` +
            `dénominateur que les appels où une conversation a eu lieu, alors que « RDV / aboutis » est dilué ` +
            `par tous les décrochés qui se sont arrêtés en trente secondes. Sa courbe ne commence qu'au premier ` +
            `${granWord()} entièrement mesuré, et elle est interrompue partout où la mesure manque : ` +
            `un taux dont les deux termes ne portent pas sur les mêmes journées ne veut rien dire. ` +
            `Il peut dépasser 100 % sur un ${granWord()} isolé, parce qu'un rendez-vous se pose parfois ` +
            `plusieurs jours après la conversation qui l'a produit, ou sans appel du tout.`,
        hover: () => `les taux du moment pointé, les volumes qui ont servi à les calculer, les niveaux de la référence, et les écarts exprimés en points de pourcentage.`,
        render: (host, ctx) => {
            const buckets = bucketize(ctx.aRows, ctx.gran);
            const aggs = buckets.map(b => agg(b.rows));
            const aB = agg(ctx.bRows);
            const refs = [];
            if (aB.connect_rate != null) refs.push({
                value: aB.connect_rate, color: B_SHADES[0], short: `${Math.round(aB.connect_rate)}%`,
                label: `Taux d'appels aboutis de la référence : ${fmtDec(aB.connect_rate)} %` });
            if (aB.meeting_rate != null) refs.push({
                value: aB.meeting_rate, color: B_SHADES[2], short: `${Math.round(aB.meeting_rate)}%`,
                label: `Taux de RDV de la référence : ${fmtDec(aB.meeting_rate)} %` });
            // Le repère « RDV après échange » de la référence n'a de sens que si
            // la période de référence est mesurée de bout en bout.
            if (aB.fullyMeasured && aB.meeting_rate_engaged != null) refs.push({
                value: aB.meeting_rate_engaged, color: B_RAMP[1], short: `${Math.round(aB.meeting_rate_engaged)}%`,
                label: `RDV après échange de la référence : ${fmtDec(aB.meeting_rate_engaged)} %` });

            /* Un point n'est tracé que si le paquet est mesuré de bout en bout :
               sur une semaine à cheval sur le 25/08, le numérateur porterait sur
               deux jours et le dénominateur sur cinq. La courbe est donc
               interrompue là où la mesure manque, ce qui se voit et s'explique. */
            const engagedSeries = aggs.map(a => (a.fullyMeasured ? a.meeting_rate_engaged : null));
            const anyEngaged = engagedSeries.some(v => v != null);

            lineChart(host, {
                labels: buckets.map(b => b.label),
                series: [
                    { name: 'Aboutis %', color: A_SHADES[0], values: aggs.map(a => a.connect_rate), fmt: v => `${fmtDec(v)} %` },
                    { name: 'RDV %', color: A_SHADES[2], values: aggs.map(a => a.meeting_rate), fmt: v => `${fmtDec(v)} %` },
                    ...(anyEngaged ? [{ name: 'RDV / échange %', color: A_RAMP[1],
                        values: engagedSeries, fmt: v => `${fmtDec(v)} %` }] : [])
                ],
                refLines: refs,
                height: ctx.big ? 440 : 250,
                // Un taux seul est trompeur : 100 % sur 2 appels n'est pas une
                // performance. L'info-bulle donne donc systématiquement les
                // volumes qui ont servi à le calculer.
                tip: i => {
                    const bk = buckets[i];
                    const a = aggs[i];
                    const pc = v => (v == null ? '–' : `${fmtDec(v)} %`);
                    return {
                        title: bucketTitle(bk, ctx.gran),
                        meta: 'Taux recalculés à partir des volumes',
                        sections: [
                            secA([
                                { color: A_SHADES[0], label: 'Appels aboutis', sub: 'sur appels passés',
                                  value: pc(a.connect_rate), em: true },
                                { color: A_SHADES[2], label: 'Rendez-vous', sub: 'sur appels aboutis',
                                  value: pc(a.meeting_rate), em: true },
                                ...(a.fullyMeasured ? [{ color: A_RAMP[1], label: 'RDV après échange',
                                    sub: 'sur appels avec échange', value: pc(a.meeting_rate_engaged), em: true }] : [])
                            ], ctx),
                            {
                                accent: 'a', head: 'Volumes de ce ' + granWord(ctx.gran),
                                rows: [
                                    { label: 'Appels passés', value: fmtInt(a.calls_made) },
                                    { label: 'Appels aboutis', value: fmtInt(a.calls_connected) },
                                    { label: 'dont avec échange',
                                      value: hasMeasured(a) ? fmtInt(a.calls_engaged) : 'pas encore compté',
                                      muted: !hasMeasured(a) },
                                    { label: 'dont sans échange',
                                      value: a.calls_unengaged == null ? 'pas encore compté' : fmtInt(a.calls_unengaged),
                                      muted: a.calls_unengaged == null },
                                    { label: 'Rendez-vous', value: fmtInt(a.meetings_booked) },
                                    { label: 'Appels par RDV', value: a.calls_per_meeting == null ? '–' : fmtDec(a.calls_per_meeting), muted: true }
                                ]
                            },
                            secB([
                                { color: B_SHADES[0], shape: 'dash', label: 'Appels aboutis', value: pc(aB.connect_rate) },
                                { color: B_SHADES[2], shape: 'dash', label: 'Rendez-vous', value: pc(aB.meeting_rate) },
                                ...(aB.fullyMeasured ? [{ color: B_RAMP[1], shape: 'dash',
                                    label: 'RDV après échange', value: pc(aB.meeting_rate_engaged) }] : [])
                            ], ctx)
                        ],
                        deltas: [
                            { label: 'Aboutis vs réf.', html: ppl(a.connect_rate, aB.connect_rate) },
                            { label: 'RDV vs réf.', html: ppl(a.meeting_rate, aB.meeting_rate) },
                            ...(a.fullyMeasured && aB.fullyMeasured
                                ? [{ label: 'RDV / échange vs réf.',
                                     html: ppl(a.meeting_rate_engaged, aB.meeting_rate_engaged) }] : [])
                        ],
                        foot: a.calls_made < 10
                            ? '<b>Peu d\u2019appels</b> sur ce ' + granWord(ctx.gran) + ' : le taux est très sensible, à lire avec prudence.'
                            : !a.fullyMeasured && a.activeDays > 0
                            ? escapeHtml(measureGap(a)) + ' : le taux de RDV après échange n\u2019est pas calculé sur ce ' + granWord(ctx.gran) + '.'
                            : 'Écarts en <b>points</b> de pourcentage, pas en pourcentage d\u2019un pourcentage.'
                    };
                }
            });
        }
    },
    {
        key: 'funnels', icon: '🔻',
        title: 'Entonnoirs comparés',
        sub: ctx => {
            const a = agg(ctx.aRows), b = agg(ctx.bRows);
            return (a.fullyMeasured && b.fullyMeasured)
                ? 'De l\'appel passé au rendez-vous obtenu, en passant par la conversation, sur chacune des deux périodes.'
                : 'De l\'appel passé au rendez-vous obtenu, sur chacune des deux périodes.';
        },
        legend: ctx => [
            { periodStyle: 'a', color: A_MAIN, label: `Analysée · ${pLab(ctx.aP)}` },
            { periodStyle: 'b', color: B_MAIN, label: `Référence · ${pLab(ctx.bP)}` }
        ],
        note: ctx => {
            const a = agg(ctx.aRows), b = agg(ctx.bRows);
            const full = a.fullyMeasured && b.fullyMeasured;
            return `Le pourcentage à droite de chaque barre est le <b>taux de passage depuis l'étape ` +
                `précédente</b>, pas depuis le total. Comparer les deux entonnoirs montre où se situe l'écart : ` +
                `un même nombre de rendez-vous peut venir de plus d'appels (effort) ou d'un meilleur taux (efficacité).` +
                (full
                    ? `<br><br>L'étage <b>Avec échange</b> isole les appels où une conversation a eu lieu. ` +
                      `Les quatre étages s'emboîtent strictement, donc les taux de passage se multiplient : ` +
                      `le dernier, <b>Avec échange → Rendez-vous</b>, répond à « une fois que je le fais parler, ` +
                      `quelle chance ai-je d'obtenir un rendez-vous ». C'est le seul taux dont le dénominateur ` +
                      `est proche de la cause réelle du rendez-vous. Il peut dépasser 100 % sur une période ` +
                      `courte : le modèle est journalier et ne relie pas un appel précis à un rendez-vous précis, ` +
                      `un créneau confirmé par e-mail le mercredi vient parfois d'une conversation du lundi, ` +
                      `et certains rendez-vous n'ont demandé aucun appel.`
                    : `<br><br>L'étage <b>Avec échange</b> n'apparaît pas : ${escapeHtml(measureGap(a) || measureGap(b) || 'le compteur d\'échanges n\'était pas ouvert sur toute la période')}. ` +
                      `Un entonnoir dont un étage porte sur trois semaines et les autres sur trois mois n'est pas ` +
                      `un entonnoir incomplet, c'est un entonnoir faux. Il apparaîtra de lui-même quand les deux ` +
                      `périodes seront mesurées de bout en bout.`);
        },
        hover: () => `le volume de l'étape pointée sur les deux périodes, le taux de passage depuis l'étape précédente, la part depuis les appels passés, le nombre perdu à cette étape, et les écarts.`,
        render: (host, ctx) => {
            /* L'étage « avec échange » n'apparaît que si les DEUX périodes sont
               mesurées de bout en bout : deux entonnoirs qui n'ont pas le même
               nombre d'étages ne se comparent pas, et un étage calculé sur un
               sous-ensemble de journées donnerait un taux de passage faux. */
            const withEngaged = agg(ctx.aRows).fullyMeasured && agg(ctx.bRows).fullyMeasured;
            const build = (rows, shades) => {
                const a = agg(rows);
                return [
                    { label: 'Appels passés', value: a.calls_made, color: shades[0] },
                    { label: 'Appels aboutis', value: a.calls_connected, color: shades[1] },
                    ...(withEngaged
                        ? [{ label: 'Avec échange', value: a.calls_engaged, color: shades[2] }] : []),
                    { label: 'Rendez-vous', value: a.meetings_booked, color: shades[withEngaged ? 3 : 2] }
                ];
            };
            host.innerHTML = `
                <div class="panel-pair">
                    <div class="mini-panel mini-panel--a">
                        <div class="mini-panel-head"><span class="mini-badge mini-badge--a">A</span>
                            ${escapeHtml(pLab(ctx.aP))}</div>
                        <div class="funnel" data-f="a"></div>
                    </div>
                    <div class="mini-panel mini-panel--b">
                        <div class="mini-panel-head"><span class="mini-badge mini-badge--b">B</span>
                            ${escapeHtml(pLab(ctx.bP))}</div>
                        <div class="funnel" data-f="b"></div>
                    </div>
                </div>`;
            const stepsA = build(ctx.aRows, A_RAMP);
            const stepsB = build(ctx.bRows, B_RAMP);

            // Une seule info-bulle pour les deux entonnoirs : survoler une étape
            // dans l'un montre immédiatement la même étape dans l'autre.
            const tip = i => {
                const side = (steps, color) => {
                    const v = Number(steps[i].value) || 0;
                    const prev = i === 0 ? null : Number(steps[i - 1].value) || 0;
                    const base = Math.max(1, Number(steps[0].value) || 0);
                    return [
                        { color, label: steps[i].label, value: fmtInt(v), em: true },
                        ...(i > 0 ? [{ label: 'Depuis l\u2019étape précédente',
                            value: prev > 0 ? `${fmtDec((v / prev) * 100)} %` : '–', muted: true }] : []),
                        ...(i > 0 ? [{ label: 'Depuis les appels passés',
                            value: `${fmtDec((v / base) * 100)} %`, muted: true }] : []),
                        ...(i > 0 ? [{ label: 'Perdus à cette étape',
                            value: fmtInt(Math.max(0, prev - v)), muted: true }] : [])
                    ];
                };
                const va = Number(stepsA[i].value) || 0, vb = Number(stepsB[i].value) || 0;
                const rate = steps => {
                    if (i === 0) return null;
                    const prev = Number(steps[i - 1].value) || 0;
                    return prev > 0 ? (Number(steps[i].value) || 0) / prev * 100 : null;
                };
                return {
                    title: stepsA[i].label,
                    meta: 'Cumul de chaque période',
                    sections: [secA(side(stepsA, A_RAMP[i]), ctx), secB(side(stepsB, B_RAMP[i]), ctx)],
                    deltas: [
                        { label: 'Volume', html: dl(va, vb).html },
                        ...(i > 0 ? [{ label: 'Taux de passage', html: ppl(rate(stepsA), rate(stepsB)) }] : [])
                    ],
                    foot: i === 0
                        ? 'L\u2019étape de départ : tout le reste en dépend.'
                        : stepsA[i].label === 'Avec échange'
                        ? 'Les <b>perdus à cette étape</b> sont les appels décrochés sans conversation, ceux qui se sont arrêtés dans les trente premières secondes.'
                        : withEngaged && stepsA[i].label === 'Rendez-vous'
                        ? 'Le taux de passage depuis les échanges est le plus révélateur : il mesure la conversion à partir du moment où le prospect parle.'
                        : 'Un volume identique peut venir de plus d\u2019efforts ou d\u2019un meilleur taux : le delta de taux tranche.'
                };
            };

            funnel(host.querySelector('[data-f="a"]'), stepsA, tip);
            funnel(host.querySelector('[data-f="b"]'), stepsB, tip);
        }
    },
    {
        key: 'records', icon: '🏅',
        title: 'Records et régularité',
        sub: () => 'Sur la période analysée, et sur tout l\'historique pour le record absolu.',
        note: () => `La <b>régularité</b> est la part des jours ouvrés de la période effectivement saisis. ` +
            `C'est souvent le premier levier : un taux de conversion médiocre sur 20 jours travaillés vaut ` +
            `mieux qu'un excellent taux sur 8 jours seulement. La <b>série en cours</b> ne compte que les ` +
            `jours ouvrés : un week-end ne casse pas la série.`,
        render: (host, ctx) => {
            const a = agg(ctx.aRows);
            const bestInA = ctx.aRows.filter(isActive)
                .reduce((b, r) => (!b || score(r) > score(b)) ? r : b, null);
            const line = (label, value, sub) => `
                <div class="metric">
                    <div class="metric-top">
                        <div class="metric-label"><b>${label}</b><span>${sub || ''}</span></div>
                        <div style="font-size:20px;font-weight:900;color:var(--navy);text-align:right">${value}</div>
                    </div>
                </div>`;
            host.innerHTML = [
                line('🏆 Record absolu (1 jour)',
                    bestEver ? fmtInt(score(bestEver)) : '–',
                    bestEver ? `${formatLong(bestEver.activity_date)} · ${fmtInt(num(bestEver, 'meetings_booked'))} RDV` : 'aucune donnée'),
                line('🥇 Meilleur jour de la période',
                    bestInA ? fmtInt(score(bestInA)) : '–',
                    bestInA ? formatLong(bestInA.activity_date) : 'aucune donnée'),
                line('📈 Score moyen par jour actif',
                    a.activeDays ? fmtDec(a.productivity_score / a.activeDays) : '–',
                    `${a.activeDays} jour(s) saisi(s) sur ${a.workdays} jour(s) ouvré(s)`),
                line('🎯 Régularité',
                    a.workdays ? `${Math.round((a.activeDays / a.workdays) * 100)} %` : '–',
                    'part des jours ouvrés effectivement saisis'),
                line('🔥 Série en cours', `${currentStreak()} j`,
                    'jours ouvrés consécutifs avec au moins une action'),
                line('📦 Cumul de la période', `${fmtInt(a.meetings_booked)} RDV`,
                    `${fmtInt(a.calls_made)} appels · ${fmtInt(a.emails_sent)} e-mails · ${fmtInt(a.crm)} fiches CRM`)
            ].join('');
        }
    }
];

/** Deux panneaux superposés à échelle partagée : la comparaison la plus lisible. */
function renderPanelPair(host, ctx, metrics) {
    const bucketsA = bucketize(ctx.aRows, ctx.gran);
    const bucketsB = bucketize(ctx.bRows, ctx.gran);
    const maxOf = buckets => Math.max(1, ...buckets.flatMap(b => {
        const a = agg(b.rows);
        return metrics.map(m => a[m.key]);
    }));
    const shared = Math.max(maxOf(bucketsA), maxOf(bucketsB));

    host.innerHTML = `
        <div class="panel-pair">
            <div class="mini-panel mini-panel--a">
                <div class="mini-panel-head"><span class="mini-badge mini-badge--a">A</span>
                    Période analysée · ${escapeHtml(pLab(ctx.aP))}</div>
                <div data-p="a"></div>
            </div>
            <div class="mini-panel mini-panel--b">
                <div class="mini-panel-head"><span class="mini-badge mini-badge--b">B</span>
                    Référence · ${escapeHtml(pLab(ctx.bP))}</div>
                <div data-p="b"></div>
            </div>
        </div>`;

    // Info-bulle commune aux deux panneaux : c'est tout l'intérêt de la paire.
    // Survoler une barre du panneau du haut affiche déjà les valeurs du bas,
    // il n'y a plus à descendre la souris pour comparer deux chiffres.
    const tip = i => {
        const bA = bucketsA[i], bB = bucketsB[i];
        const gA = bA ? agg(bA.rows) : null;
        const gB = bB ? agg(bB.rows) : null;
        const rows = (g, shades) => metrics.map((m, k) => ({
            color: shades[k], label: m.short,
            value: !g ? '–'
                : (m.key === MEASURED_KEY && !hasMeasured(g) ? 'pas encore compté' : fmtInt(g[m.key])),
            em: true
        }));
        const extra = g => (!g ? [] : [
            { label: 'Total du groupe',
              value: fmtInt(metrics.reduce((t, m) => t + g[m.key], 0)), muted: true },
            { label: 'Score', value: `${fmtInt(g.productivity_score)} pts`, muted: true },
            ...(metrics.some(m => m.key === 'calls_made') ? rateRows(g) : [])
        ]);
        return {
            title: bucketTitle(bA, ctx.gran),
            meta: `${granWord(ctx.gran).charAt(0).toUpperCase()}${granWord(ctx.gran).slice(1)} n° ${i + 1} de chaque période`,
            sections: [
                secA([...rows(gA, A_RAMP), ...extra(gA)], ctx,
                    bA ? `Analysée · ${bucketTitle(bA, ctx.gran)}` : 'Analysée · hors période'),
                secB([...rows(gB, B_RAMP), ...extra(gB)], ctx,
                    bB ? `Référence · ${bucketTitle(bB, ctx.gran)}` : 'Référence · hors période')
            ],
            deltas: metrics.map((m, k) => ({
                label: m.short,
                html: gA && gB ? dl(gA[m.key], gB[m.key]).html
                    : '<span class="delta delta--flat">= non comparable</span>'
            })),
            foot: `Les deux panneaux partagent la même échelle verticale (maximum ${fmtInt(shared)}).`
        };
    };

    const draw = (sel, buckets, shades) => barChart(host.querySelector(sel), {
        labels: buckets.map(b => b.label),
        series: metrics.map((m, i) => ({
            name: m.short, color: shades[i],
            /* Sur la métrique mesurée en cours de route, un paquet non mesuré
               vaut null et non zéro : barChart ne dessine alors aucune barre,
               au lieu d'une barre à zéro qui affirmerait qu'il n'y a eu aucune
               conversation ce jour-là. */
            values: buckets.map(b => {
                const g = agg(b.rows);
                return (m.key === MEASURED_KEY && !hasMeasured(g)) ? null : g[m.key];
            })
        })),
        yMax: shared,
        height: ctx.big ? 300 : 210,
        tip
    });
    draw('[data-p="a"]', bucketsA, A_RAMP);
    draw('[data-p="b"]', bucketsB, B_RAMP);
}

/* --------------------------------------------------------------------------
   Rendu — pilotage
   -------------------------------------------------------------------------- */

function renderPresets() {
    const row = $('#preset-row');
    row.querySelectorAll('.chip').forEach(c => c.remove());
    PRESETS.forEach(p => {
        const b = document.createElement('button');
        b.className = 'chip chip--sm' + (state.preset === p.id ? ' chip--active' : '');
        b.type = 'button';
        b.textContent = p.label;
        b.addEventListener('click', () => {
            Object.assign(state, p.make(), { preset: p.id });
            refresh();
        });
        row.appendChild(b);
    });
    if (state.preset === 'custom') {
        const b = document.createElement('button');
        b.className = 'chip chip--sm chip--active';
        b.type = 'button';
        b.textContent = '✎ Personnalisé';
        row.appendChild(b);
    }
}

function renderControls() {
    $('#a-from').value = state.a.from; $('#a-to').value = state.a.to;
    $('#b-from').value = state.b.from; $('#b-to').value = state.b.to;
    ['#a-from', '#a-to', '#b-from', '#b-to'].forEach(s => { $(s).max = todayISO(); });

    const la = periodLength(state.a.from, state.a.to);
    const lb = periodLength(state.b.from, state.b.to);
    $('#hint-a').textContent = `${la} jour${la > 1 ? 's' : ''}`;
    $('#hint-b').textContent = `${lb} jour${lb > 1 ? 's' : ''}`;

    document.querySelectorAll('#seg-gran button').forEach(b =>
        b.classList.toggle('is-on', b.dataset.gran === state.gran));
    document.querySelectorAll('#seg-mode button').forEach(b =>
        b.classList.toggle('is-on', b.dataset.mode === effMode()));

    // Explications sous les deux réglages : ils étaient justes mais muets.
    $('#explain-gran').innerHTML = state.gran === 'auto'
        ? `<b>Auto</b> choisit selon la durée analysée : ici ${la} jour${la > 1 ? 's' : ''}, donc un point par <b>${granWord()}</b>. Au-delà de 31 jours il regroupe par semaine, au-delà de 180 par mois.`
        : `Forcé : un point par <b>${granWord()}</b>. Repassez sur Auto pour laisser la durée décider.`;

    $('#explain-mode').innerHTML = effMode() === 'total'
        ? `<b>Cumul</b> : on additionne les actions de chaque période. Pertinent ici, les deux durées sont identiques.`
        : `<b>Moyenne par jour actif</b> : total ÷ nombre de jours réellement saisis. ${
            lengthsDiffer() ? 'Activé automatiquement car les deux périodes n\'ont pas la même durée.' : ''} Les week-ends et jours d\'absence ne diluent pas le résultat.`;
}

function renderSummary(aA, aB) {
    const mode = effMode();
    const warn = [];

    if (lengthsDiffer()) {
        warn.push(`<span class="pill pill--warn">⚠ Durées différentes${
            mode === 'avg' ? ' : lecture en moyenne par jour actif' : ' : le cumul est trompeur'}</span>`);
    }
    if (byDate.size === 0) {
        warn.push('<span class="pill pill--warn">⚠ Aucune ligne reçue de la base sur la plage chargée '
            + `(${periodLabelShort(loaded.from, loaded.to)})</span>`);
    } else if (aA.activeDays === 0 && aB.activeDays === 0) {
        warn.push(`<span class="pill pill--warn">⚠ Aucune saisie sur ces deux périodes, alors que ${
            byDate.size} jour(s) existent dans l'historique</span>`);
    }

    /* Un seul avertissement pour toute la page sur la couverture de mesure des
       échanges. Sans lui, un lecteur qui voit « 0 échange » sur juillet en
       conclurait que personne ne parlait à personne, alors que la question
       n'était pas posée. */
    const gapA = measureGap(aA), gapB = measureGap(aB);
    if (gapA || gapB) {
        const since = measuredSince();
        warn.push(`<span class="pill pill--warn">⚠ Appels avec échange comptés depuis le ${
            since ? escapeHtml(formatLong(since).replace(/^\S+ /, '')) : 'déploiement'} : ${
            escapeHtml([gapA && `période analysée, ${gapA}`, gapB && `référence, ${gapB}`]
                .filter(Boolean).join(' · '))
        }. Les volumes portent sur les journées comptées, les taux d'échange ne sont pas calculés.</span>`);
    }

    $('#control-summary').innerHTML = `
        <div class="summary-sentence">
            Vous analysez <b>${escapeHtml(periodLabel(state.a.from, state.a.to))}</b>
            (${aA.activeDays} jour(s) saisi(s) sur ${aA.workdays} ouvré(s)),
            comparé à <b>${escapeHtml(periodLabel(state.b.from, state.b.to))}</b>
            (${aB.activeDays} sur ${aB.workdays}).
        </div>
        ${warn.join(' ')}`;
}

/* --------------------------------------------------------------------------
   Rendu — KPI et encadré du score
   -------------------------------------------------------------------------- */

function renderKpis(aA, aB) {
    const mode = effMode();
    const unit = mode === 'avg' ? '/ jour actif' : '';
    const show = v => mode === 'avg' ? fmtDec(v) : fmtInt(v);

    const items = [
        { label: '⚡ Score de productivité', key: 'productivity_score', hero: true },
        { label: '🤝 Rendez-vous', key: 'meetings_booked' },
        { label: '📞 Appels', key: 'calls_made' },
        { label: '✅ Appels aboutis', key: 'calls_connected',
          /* La dichotomie que réclame le terrain, sans ajouter une carte de
             plus : le total reste la valeur affichée, le partage tient sur la
             ligne du dessous. */
          extra: !hasMeasured(aA)
              ? 'échanges pas encore comptés'
              : `dont ${fmtInt(aA.calls_engaged)} avec échange${
                  aA.engage_rate == null ? '' : ` (${fmtDec(aA.engage_rate)} %)`}${
                  aA.fullyMeasured ? '' : `, sur ${aA.measuredActiveDays} j comptée(s)`}` },
        { label: '✉️ E-mails', key: 'emails_sent' },
        { label: '🗂️ Fiches CRM', key: 'crm' }
    ];

    let html = items.map(it => {
        const v = val(aA, it.key, mode), r = val(aB, it.key, mode);
        return `
        <div class="kpi-tile${it.hero ? ' kpi-tile--hero' : ''}">
            <div class="kpi-label">${it.label}</div>
            <div class="kpi-value">${show(v)}${unit ? ` <small>${unit}</small>` : ''}</div>
            ${delta(Math.round(v * 10) / 10, Math.round(r * 10) / 10).html}
            <div class="kpi-sub">${it.extra ? `${escapeHtml(it.extra)}<br>` : ''}Référence : ${show(r)} ${unit}</div>
        </div>`;
    }).join('');

    const rate = (label, key, sub) => {
        const v = aA[key], r = aB[key];
        return `
        <div class="kpi-tile">
            <div class="kpi-label">${label}</div>
            <div class="kpi-value">${v == null ? '–' : fmtDec(v)} <small>%</small></div>
            ${(v != null && r != null) ? delta(Math.round(v), Math.round(r), { suffix: ' pts' }).html : ''}
            <div class="kpi-sub">${sub} · référence : ${r == null ? '–' : fmtDec(r) + ' %'}</div>
        </div>`;
    };

    html += rate('🎯 Taux d\'appels aboutis', 'connect_rate', `sur ${fmtInt(aA.calls_made)} appels`);
    html += rate('🏁 Taux de RDV', 'meeting_rate', `sur ${fmtInt(aA.calls_connected)} aboutis`);

    /* Le taux que réclame le terrain : à partir du moment où le prospect parle,
       quelle chance d'obtenir un rendez-vous. Son dénominateur est le seul
       proche de la cause réelle du rendez-vous. Il n'apparaît que si la période
       analysée est mesurée de bout en bout : sinon ses deux termes ne portent
       pas sur les mêmes journées. */
    if (aA.fullyMeasured) {
        html += rate('💬 RDV après échange', 'meeting_rate_engaged',
            `sur ${fmtInt(aA.calls_engaged)} échange(s)`);
    }

    html += `
        <div class="kpi-tile">
            <div class="kpi-label">💪 Effort par rendez-vous</div>
            <div class="kpi-value">${aA.calls_per_meeting == null ? '–' : fmtDec(aA.calls_per_meeting)} <small>appels</small></div>
            ${(aA.calls_per_meeting != null && aB.calls_per_meeting != null)
                ? delta(Math.round(aA.calls_per_meeting * 10) / 10, Math.round(aB.calls_per_meeting * 10) / 10,
                        { higherIsBetter: false }).html : ''}
            <div class="kpi-sub">appels nécessaires pour 1 RDV · référence : ${
                aB.calls_per_meeting == null ? '–' : fmtDec(aB.calls_per_meeting)}</div>
        </div>`;

    $('#kpi-grid').innerHTML = html;
}

/** Encadré très visible : la formule du score, décomposée sur la période analysée. */
function renderScorePanel(aA) {
    const parts = SCORE_WEIGHTS.map(w => ({ ...w, n: aA[w.key] || 0, pts: (aA[w.key] || 0) * w.w }));
    const total = parts.reduce((t, p) => t + p.pts, 0);
    const top = parts.slice().sort((x, y) => y.pts - x.pts)[0];
    const gap = measureGap(aA);
    const engW = SCORE_WEIGHTS.find(w => w.key === MEASURED_KEY)?.w || 0;

    $('#score-panel').innerHTML = `
        <h2>⚡ Comment se calcule le score de productivité</h2>
        <p>Le score résume une journée en un seul nombre comparable. Chaque action est multipliée par un poids,
           puis tout est additionné. Les poids traduisent une règle simple : un BDR est payé pour des
           rendez-vous, pas pour du volume d'appels.</p>

        <div class="weights">
            ${SCORE_WEIGHTS.map(w => `
                <div class="weight">
                    <span style="font-size:17px">${w.icon}</span>
                    <span class="weight-label">${w.label}</span>
                    <span class="weight-x">× ${w.w}</span>
                </div>`).join('')}
        </div>

        <div class="formula">
            <b>Sur la période analysée (${escapeHtml(periodLabelShort(state.a.from, state.a.to))}) :</b><br>
            ${parts.map(p =>
                `${fmtInt(p.n)} ${p.n > 1 ? p.plural : p.label.toLowerCase()} × ${p.w} = <b>${fmtInt(p.pts)}</b>`
            ).join('<span class="f-op">+</span>')}
            <span class="f-op">=</span><span class="f-total">${fmtInt(total)} points</span>
        </div>

        <div class="score-why">
            ${total > 0 ? `Sur cette période, ce sont les <b>${top.plural}</b> qui pèsent le plus lourd dans le score
            (${fmtInt(top.pts)} points, soit ${Math.round((top.pts / total) * 100)} % du total).` : ''}
            Le score n'a pas de valeur absolue : il ne vaut que comparé à une autre période, ce que fait
            le reste de cette page. Ces poids sont définis dans la vue SQL <code>v_daily_kpi</code> et peuvent
            être ajustés en une requête si la réalité du métier l'exige.
        </div>
        ${gap ? `<div class="score-why">⚠ <b>Comparaison avec le passé.</b> ${escapeHtml(gap)}.
            Ces journées ne rapportent aucun point au titre des appels avec échange, alors qu'il y a
            évidemment eu des conversations : leur score est mécaniquement sous-estimé de
            ${fmtInt(engW)} point(s) par échange qui n'a pas pu être compté. Un écart avec une période
            d'avant l'ouverture du compteur se lit donc avec cette réserve.</div>` : ''}`;
}

/* --------------------------------------------------------------------------
   Rendu — grille de graphiques

   Chaque carte peut porter ses propres dates, directement dans la grille
   (bouton 📅) comme en vue agrandie : les deux partagent le même état.
   -------------------------------------------------------------------------- */

const scopes = new Map();     // clé de graphique → { from, to } ou absent
const datesOpen = new Set();  // cartes dont le panneau de dates est déplié

function ctxFor(chart, { big = false } = {}) {
    const scope = scopes.get(chart.key) || null;
    const aP = scope || state.a;
    const bP = scope ? previousPeriod(scope.from, scope.to) : state.b;
    const span = periodLength(aP.from, aP.to);
    return {
        aP, bP, big, scoped: !!scope,
        aRows: rowsFor(aP), bRows: rowsFor(bP),
        gran: scope ? (span <= 31 ? 'day' : span <= 180 ? 'week' : 'month') : effGran(),
        mode: scope
            ? (periodLength(aP.from, aP.to) === periodLength(bP.from, bP.to) ? 'total' : 'avg')
            : effMode()
    };
}

function cardHtml(c, ctx) {
    const open = datesOpen.has(c.key) || ctx.scoped;
    return `
    <div class="chart-card${c.wide ? ' chart-card--wide' : ''}${ctx.scoped ? ' chart-card--scoped' : ''}">
        <div class="chart-head">
            <div class="chart-icon">${c.icon}</div>
            <div class="chart-titles">
                <h3 class="chart-title">${escapeHtml(c.title)}</h3>
                <p class="chart-sub">${escapeHtml(c.sub(ctx))}</p>
            </div>
            <div class="chart-tools">
                ${c.select ? `<select class="chart-select" data-sel="${c.key}">${
                    c.select.options().map(o =>
                        `<option value="${o.v}"${o.v === c.select.get() ? ' selected' : ''}>${o.t}</option>`).join('')
                }</select>` : ''}
                <button class="icon-btn" type="button" data-dates="${c.key}"
                        title="Dates propres à ce graphique" aria-label="Dates de ce graphique">📅</button>
                <button class="icon-btn" type="button" data-zoom="${c.key}"
                        title="Agrandir" aria-label="Agrandir">⛶</button>
            </div>
        </div>

        <div class="chart-dates" data-panel="${c.key}"${open ? '' : ' hidden'}>
            <span class="date-bar-label">Dates de ce graphique</span>
            <div class="date-range">
                <input type="date" data-scope-from="${c.key}" value="${ctx.aP.from}" max="${todayISO()}">
                <span>→</span>
                <input type="date" data-scope-to="${c.key}" value="${ctx.aP.to}" max="${todayISO()}">
            </div>
            <button class="chip chip--sm" type="button" data-scope-reset="${c.key}">↺ Période globale</button>
            <span class="pill ${ctx.scoped ? 'pill--warn' : 'pill--info'}">${
                ctx.scoped ? 'dates propres · référence = période précédente équivalente' : 'suit la période globale'}</span>
        </div>

        ${c.legend ? legendHtml(c.legend(ctx)) : ''}
        <div data-host="${c.key}"></div>
        ${c.note ? `<details class="chart-note"><summary>Comment lire ce graphique</summary>
            <p>${c.note(ctx)}</p>${c.hover ? `<p class="chart-note-hover"><b>Au survol :</b> ${c.hover(ctx)}</p>` : ''}
            </details>` : ''}
    </div>`;
}

function renderCharts() {
    const grid = $('#charts-grid');
    const ctxs = new Map(CHARTS.map(c => [c.key, ctxFor(c)]));

    grid.innerHTML = CHARTS.map(c => cardHtml(c, ctxs.get(c.key))).join('');
    CHARTS.forEach(c => c.render(grid.querySelector(`[data-host="${c.key}"]`), ctxs.get(c.key)));

    grid.querySelectorAll('[data-zoom]').forEach(b =>
        b.addEventListener('click', () => openModal(b.dataset.zoom)));

    grid.querySelectorAll('[data-dates]').forEach(b =>
        b.addEventListener('click', () => {
            const k = b.dataset.dates;
            const panel = grid.querySelector(`[data-panel="${k}"]`);
            const willOpen = panel.hidden;
            panel.hidden = !willOpen;
            if (willOpen) datesOpen.add(k); else datesOpen.delete(k);
        }));

    grid.querySelectorAll('[data-sel]').forEach(sel =>
        sel.addEventListener('change', () => {
            CHARTS.find(c => c.key === sel.dataset.sel).select.set(sel.value);
            renderCharts();
        }));

    grid.querySelectorAll('[data-scope-from], [data-scope-to]').forEach(inp =>
        inp.addEventListener('change', () => {
            const k = inp.dataset.scopeFrom || inp.dataset.scopeTo;
            const from = grid.querySelector(`[data-scope-from="${k}"]`).value;
            const to = grid.querySelector(`[data-scope-to="${k}"]`).value;
            if (!from || !to) return;
            scopes.set(k, normalize({ from, to }));
            datesOpen.add(k);
            renderCharts();
        }));

    grid.querySelectorAll('[data-scope-reset]').forEach(b =>
        b.addEventListener('click', () => {
            scopes.delete(b.dataset.scopeReset);
            renderCharts();
        }));
}

/* --------------------------------------------------------------------------
   Agrandissement — même état de dates que la carte
   -------------------------------------------------------------------------- */

let openKey = null;

function openModal(key) {
    openKey = key;
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';
    paintModal();
}

function closeModal() {
    openKey = null;
    $('#modal').hidden = true;
    document.body.style.overflow = '';
    renderCharts();   // les dates modifiées en grand se reflètent dans la grille
}

function paintModal() {
    const c = CHARTS.find(x => x.key === openKey);
    if (!c) return;
    const ctx = ctxFor(c, { big: true });

    $('#modal-title').textContent = `${c.icon}  ${c.title}`;
    $('#modal-sub').textContent = c.sub(ctx);
    $('#modal-from').value = ctx.aP.from;
    $('#modal-to').value = ctx.aP.to;
    $('#modal-from').max = todayISO();
    $('#modal-to').max = todayISO();
    $('#modal-scope').textContent = ctx.scoped
        ? 'dates propres à ce graphique' : 'période globale';
    $('#modal-scope').className = 'pill ' + (ctx.scoped ? 'pill--warn' : 'pill--info');

    $('#modal-body').innerHTML = `
        ${c.legend ? legendHtml(c.legend(ctx)) : ''}
        <div id="modal-host"></div>
        ${c.note ? `<details class="chart-note" open><summary>Comment lire ce graphique</summary>
            <p>${c.note(ctx)}</p></details>` : ''}`;
    c.render($('#modal-host'), ctx);
}

/* --------------------------------------------------------------------------
   Rendu — tableau et export
   -------------------------------------------------------------------------- */

function renderTable(aRows) {
    const act = aRows.filter(isActive).slice().reverse();
    const best = Math.max(0, ...act.map(score));

    if (!act.length) {
        $('#history-body').innerHTML =
            `<tr><td colspan="12" class="td-muted" style="text-align:center;padding:32px">
             Aucune saisie sur la période analysée.</td></tr>`;
        return;
    }

    $('#history-body').innerHTML = act.map(r => {
        const cls = [];
        if (r.activity_date === T) cls.push('is-today');
        if (score(r) === best) cls.push('is-best');
        // data-th porte l'intitulé de colonne : sous 760 pixels le tableau se
        // transforme en cartes empilées et c'est cet attribut qui sert
        // d'étiquette. Douze colonnes ne se lisent pas sur un téléphone, et
        // aucun défilement horizontal n'y changerait rien.
        return `
        <tr class="${cls.join(' ')}">
            <td data-th="Jour" class="td-day">${escapeHtml(formatLong(r.activity_date).replace(/ \d{4}$/, ''))}
                ${r.notes ? `<span title="${escapeHtml(r.notes)}" style="cursor:help"> 📝</span>` : ''}
                ${r.is_correction ? '<b class="tag tag--fix" title="Dernière écriture faite par un administrateur, pas par le titulaire du compte">corrigé</b>' : ''}</td>
            <td data-th="Appels">${fmtInt(num(r, 'calls_made'))}</td>
            <td data-th="Aboutis">${fmtInt(num(r, 'calls_connected'))}</td>
            <td data-th="Échanges" class="${isMeasured(r) ? '' : 'td-muted'}">${
                isMeasured(r) ? fmtInt(num(r, MEASURED_KEY)) : '–'}</td>
            <td data-th="RDV"><b>${fmtInt(num(r, 'meetings_booked'))}</b></td>
            <td data-th="E-mails">${fmtInt(num(r, 'emails_sent'))}</td>
            <td data-th="Entreprises">${fmtInt(num(r, 'companies_created'))}</td>
            <td data-th="Contacts">${fmtInt(num(r, 'contacts_created'))}</td>
            <td data-th="Taux aboutis" class="${r.connect_rate == null ? 'td-muted' : ''}">${r.connect_rate == null ? '–' : fmtDec(r.connect_rate) + ' %'}</td>
            <td data-th="Taux RDV" class="${r.meeting_rate == null ? 'td-muted' : ''}">${r.meeting_rate == null ? '–' : fmtDec(r.meeting_rate) + ' %'}</td>
            <td data-th="Score" class="td-score"><b>${fmtInt(score(r))}</b></td>
            <td data-th="" class="td-action">${editLink(r.activity_date)}</td>
        </tr>`;
    }).join('');
}

function exportCsv() {
    const rows = rowsFor(state.a).filter(isActive);
    if (!rows.length) { toast('Rien à exporter sur cette période.', 'error'); return; }

    /* Dans un fichier, la largeur ne coûte rien : on sort les trois colonnes
       d'échange en entier. Une cellule vide signifie « non mesuré » et non
       zéro, ce qui permet à un tableur de l'exclure d'une moyenne au lieu de
       la tirer vers le bas. */
    const head = ['Date', 'Appels', 'Appels aboutis', 'Appels avec échange',
        'Appels sans échange', 'RDV', 'E-mails', 'Entreprises', 'Contacts',
        'Taux aboutis %', 'Taux échange %', 'Taux RDV %', 'Taux RDV après échange %',
        'Score', 'Note'];
    const body = rows.map(r => [
        r.activity_date, num(r, 'calls_made'), num(r, 'calls_connected'),
        isMeasured(r) ? num(r, MEASURED_KEY) : '',
        isMeasured(r) ? Math.max(0, num(r, 'calls_connected') - num(r, MEASURED_KEY)) : '',
        num(r, 'meetings_booked'), num(r, 'emails_sent'),
        num(r, 'companies_created'), num(r, 'contacts_created'),
        r.connect_rate == null ? '' : fmtDec(r.connect_rate),
        !isMeasured(r) || r.engage_rate == null ? '' : fmtDec(r.engage_rate),
        r.meeting_rate == null ? '' : fmtDec(r.meeting_rate),
        !isMeasured(r) || r.meeting_rate_engaged == null ? '' : fmtDec(r.meeting_rate_engaged),
        score(r), (r.notes || '').replace(/[;\r\n]/g, ' ')
    ]);

    // Point-virgule et BOM : Excel en configuration française ouvre le fichier sans réglage.
    const csv = '\uFEFF' + [head, ...body].map(l => l.join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `cockpit-bdr_${state.a.from}_${state.a.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`${rows.length} jour(s) exporté(s)`, 'success');
}

/* --------------------------------------------------------------------------
   Cycle de rafraîchissement
   -------------------------------------------------------------------------- */

function normalize(p) {
    if (diffDays(p.to, p.from) < 0) { const s = p.from; p.from = p.to; p.to = s; }
    if (diffDays(T, p.to) < 0) p.to = T;
    if (diffDays(T, p.from) < 0) p.from = T;
    return p;
}

async function refresh() {
    normalize(state.a); normalize(state.b);
    renderPresets();
    renderControls();

    const status = txt => { $('#control-summary').innerHTML = `<span class="pill pill--info">${txt}</span>`; };
    status('Chargement…');

    // Une seule requête couvre les deux périodes, plus 13 mois d'historique
    // pour le record absolu, la série en cours et la meilleure période équivalente.
    const from = [state.a.from, state.b.from, addMonthsISO(T, -13)].reduce(minISO);
    const to = [state.a.to, state.b.to, T].reduce(maxISO);

    try {
        const [rows, best] = await Promise.all([fetchRange(from, to), fetchBestDay()]);
        byDate = new Map(rows.map(r => [r.activity_date, r]));
        loaded = { from, to };
        bestEver = best;

        const aRows = rowsFor(state.a);
        const aA = agg(aRows), aB = agg(rowsFor(state.b));

        renderSummary(aA, aB);
        renderKpis(aA, aB);
        renderScorePanel(aA);
        renderCharts();
        renderTable(aRows);
        if (openKey) paintModal();
    } catch (e) {
        status('⚠ Lecture impossible');
        toast(humanError(e), 'error', 6000);
    }
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

(async function init() {
    const session = await requireAuth({ needs: 'bdr' });
    renderNav();
    renderIdentity();

    // Un lien ?date=... (venu de la saisie) ouvre ce jour comparé à la veille.
    const wanted = new URLSearchParams(location.search).get('date');
    if (wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) && diffDays(T, wanted) >= 0) {
        state.a = { from: wanted, to: wanted };
        state.b = { from: addDaysISO(wanted, -1), to: addDaysISO(wanted, -1) };
        state.preset = 'custom';
    }

    // Saisie libre des quatre dates
    const bind = (sel, side, edge) => $(sel).addEventListener('change', e => {
        if (!e.target.value) return;
        state[side][edge] = e.target.value;
        state.preset = 'custom';
        refresh();
    });
    bind('#a-from', 'a', 'from'); bind('#a-to', 'a', 'to');
    bind('#b-from', 'b', 'from'); bind('#b-to', 'b', 'to');

    // Raccourcis de la zone A
    document.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => {
        const k = b.dataset.a;
        if (k === 'today') state.a = { from: T, to: T };
        else if (k === 'week') state.a = { from: startOfWeek(T), to: endOfWeek(T) };
        else if (k === 'month') state.a = { from: startOfMonth(T), to: endOfMonth(T) };
        else if (k === 'quarter') state.a = { from: startOfQuarter(T), to: endOfQuarter(T) };
        else state.a = { from: addDaysISO(T, -(Number(k) - 1)), to: T };
        state.b = previousPeriod(state.a.from, state.a.to);
        state.preset = 'custom';
        refresh();
    }));

    // Raccourcis de la zone B
    document.querySelectorAll('[data-b]').forEach(b => b.addEventListener('click', () => {
        const k = b.dataset.b;
        if (k === 'prev') state.b = previousPeriod(state.a.from, state.a.to);
        else if (k === 'lastyear') state.b = samePeriodLastYear(state.a.from, state.a.to);
        else if (k === 'best') {
            const w = bestEquivalentPeriod(periodLength(state.a.from, state.a.to), state.a);
            if (!w) { toast('Pas encore assez d\'historique pour trouver une meilleure période.', 'error'); return; }
            state.b = { from: w.from, to: w.to };
            toast(`Meilleure période équivalente : ${periodLabelShort(w.from, w.to)}`, 'success', 4000);
        }
        state.preset = 'custom';
        refresh();
    }));

    // Granularité et mode de lecture
    document.querySelectorAll('#seg-gran button').forEach(b =>
        b.addEventListener('click', () => { state.gran = b.dataset.gran; refresh(); }));
    document.querySelectorAll('#seg-mode button').forEach(b =>
        b.addEventListener('click', () => {
            state.mode = b.dataset.mode; state.modeTouched = true; refresh();
        }));

    // Fenêtre d'agrandissement
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && openKey) closeModal(); });
    $('#modal-reset').addEventListener('click', () => {
        if (openKey) scopes.delete(openKey);
        paintModal();
    });
    const bindLocal = sel => $(sel).addEventListener('change', () => {
        const p = normalize({ from: $('#modal-from').value, to: $('#modal-to').value });
        if (!p.from || !p.to || !openKey) return;
        scopes.set(openKey, p);
        paintModal();
    });
    bindLocal('#modal-from'); bindLocal('#modal-to');

    $('#btn-export').addEventListener('click', exportCsv);

    // Rotation du téléphone ou redimensionnement : les graphiques sont dessinés
    // pour une largeur donnée, il faut les refaire. Seuls les graphiques sont
    // reconstruits, pas les données, donc aucune requête n'est relancée.
    onResize(() => { renderCharts(); if (openKey) paintModal(); });

    await refresh();
    hideVeil();
})();
