/* ==========================================================================
   DASHBOARD.JS (v2) — Analyse de performance par comparaison de PÉRIODES.

   Modèle unique : une période A (analysée) face à une période B (référence).
   Une journée n'est qu'une période d'un jour, donc « aujourd'hui vs hier » et
   « juillet vs juin » empruntent exactement le même chemin de code.
   ========================================================================== */

import {
    requireAuth, METRICS, EMPTY_DAY,
    todayISO, addDaysISO, diffDays, formatLong, formatShort, isWeekend,
    startOfWeek, endOfWeek, startOfMonth, endOfMonth, addMonthsISO,
    startOfQuarter, endOfQuarter, weekLabel, monthLabel,
    periodLength, countWorkdays, previousPeriod, samePeriodLastYear,
    periodLabel, periodLabelShort, minISO, maxISO,
    fetchRange, fetchBestDay, humanError, SCORE_WEIGHTS
} from './api.js';
import {
    $, toast, fmtInt, fmtDec, delta, escapeHtml, hideVeil,
    lineChart, barChart, compareChart, funnel, legendHtml
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

const zeroDay = iso => ({
    ...EMPTY_DAY, activity_date: iso, productivity_score: 0, total_actions: 0,
    connect_rate: null, meeting_rate: null, calls_per_meeting: null, notes: null
});

const num = (r, k) => Number(r?.[k]) || 0;
const score = r => num(r, 'productivity_score');
const isActive = r => num(r, 'total_actions') > 0;

/** Lignes d'une période, jours manquants complétés à zéro. */
function rowsFor(p) {
    const out = [];
    for (let iso = p.from; diffDays(p.to, iso) >= 0; iso = addDaysISO(iso, 1)) {
        out.push(byDate.get(iso) || zeroDay(iso));
    }
    return out;
}

/** Agrégat d'une liste de jours : cumuls, jours actifs, taux recalculés. */
function agg(rows) {
    const a = { days: rows.length, activeDays: 0 };
    [...METRICS.map(m => m.key), 'productivity_score', 'total_actions']
        .forEach(k => { a[k] = 0; });

    rows.forEach(r => {
        if (isActive(r)) a.activeDays++;
        [...METRICS.map(m => m.key), 'productivity_score', 'total_actions']
            .forEach(k => { a[k] += num(r, k); });
    });

    a.workdays = rows.filter(r => !isWeekend(r.activity_date)).length;
    a.connect_rate = a.calls_made > 0 ? (a.calls_connected / a.calls_made) * 100 : null;
    a.meeting_rate = a.calls_connected > 0 ? (a.meetings_booked / a.calls_connected) * 100 : null;
    a.calls_per_meeting = a.meetings_booked > 0 ? a.calls_made / a.meetings_booked : null;
    a.crm = a.companies_created + a.contacts_created;
    return a;
}

/**
 * Valeur d'un agrégat selon le mode de lecture.
 * En moyenne, on divise par les jours ACTIFS et non par les jours calendaires :
 * un week-end ou un jour de formation ne doit pas diluer la performance.
 */
function val(a, key, mode = effMode()) {
    const raw = key === 'crm' ? a.crm : (a[key] ?? 0);
    if (mode === 'total') return raw;
    return a.activeDays > 0 ? raw / a.activeDays : 0;
}

/* --------------------------------------------------------------------------
   Granularité et mode effectifs
   -------------------------------------------------------------------------- */

function effGran() {
    if (state.gran !== 'auto') return state.gran;
    const span = periodLength(state.a.from, state.a.to);
    if (span <= 31) return 'day';
    if (span <= 180) return 'week';
    return 'month';
}

const lengthsDiffer = () =>
    periodLength(state.a.from, state.a.to) !== periodLength(state.b.from, state.b.to);

/** Si les périodes n'ont pas la même longueur, comparer des cumuls n'a pas de sens. */
function effMode() {
    if (state.modeTouched) return state.mode;
    return lengthsDiffer() ? 'avg' : 'total';
}

/** Regroupe des jours en paquets (jour, semaine ISO ou mois). */
function bucketize(rows, gran) {
    if (gran === 'day') {
        return rows.map(r => ({ key: r.activity_date, label: formatShort(r.activity_date), rows: [r] }));
    }
    const map = new Map();
    rows.forEach(r => {
        const key = gran === 'week' ? startOfWeek(r.activity_date) : startOfMonth(r.activity_date);
        if (!map.has(key)) {
            map.set(key, { key, label: gran === 'week' ? weekLabel(key) : monthLabel(key), rows: [] });
        }
        map.get(key).rows.push(r);
    });
    return [...map.values()].sort((x, y) => x.key.localeCompare(y.key));
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

const granWord = g => ({ day: 'jour', week: 'semaine', month: 'mois' }[g || effGran()]);
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
        render: (host, ctx) => {
            const aA = agg(ctx.aRows), aB = agg(ctx.bRows);
            compareChart(host, {
                rows: METRICS.map(m => ({
                    label: m.short, colorA: A_MAIN, colorB: B_MAIN,
                    a: val(aA, m.key, ctx.mode), b: val(aB, m.key, ctx.mode)
                })),
                labelA: `analysée (${pLab(ctx.aP)})`,
                labelB: `référence (${pLab(ctx.bP)})`,
                fmt: v => ctx.mode === 'avg' ? fmtDec(v) : fmtInt(v),
                height: ctx.big ? 460 : undefined
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
        render: (host, ctx) => {
            const key = state.cumulMetric;
            const label = { meetings_booked: 'RDV', calls_made: 'appels', calls_connected: 'aboutis',
                emails_sent: 'e-mails', productivity_score: 'points' }[key];
            const cum = rows => { let t = 0; return rows.map(r => (t += num(r, key))); };
            const ca = cum(ctx.aRows), cb = cum(ctx.bRows);
            const n = Math.max(ca.length, cb.length);
            const pad = arr => Array.from({ length: n }, (_, i) => (i < arr.length ? arr[i] : null));
            lineChart(host, {
                labels: Array.from({ length: n }, (_, i) => `J${i + 1}`),
                series: [
                    { name: `analysée (${label})`, color: A_MAIN, values: pad(ca), area: true },
                    { name: `référence (${label})`, color: B_MAIN, values: pad(cb), dashed: true }
                ],
                height: ctx.big ? 440 : 260
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
            `son poids (un rendez-vous vaut 20 points, un appel 1 point) puis additionnée. Le détail du calcul ` +
            `est donné dans l'encadré bleu foncé en haut de la page.<br><br>` +
            `La <b>tendance</b> est une moyenne mobile sur 7 points : chaque point vaut la moyenne de lui-même ` +
            `et des 6 précédents. Elle efface les à-coups d'un jour isolé pour montrer le mouvement de fond. ` +
            `Si la courbe pleine zigzague mais que la tendance monte, la dynamique est bonne.<br><br>` +
            `Le <b>trait violet horizontal</b> est le score moyen de la période de référence, pour situer le niveau.`,
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
                height: ctx.big ? 460 : 260
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
                pair: [A_SHADES[i], B_SHADES[i]], label: m.short
            }))
        ],
        note: () => `Deux panneaux superposés plutôt qu'un seul graphique surchargé : six séries mélangées dans ` +
            `la même grille deviennent illisibles. L'<b>échelle verticale est volontairement identique</b> sur ` +
            `les deux panneaux, donc une barre deux fois plus haute vaut réellement deux fois plus. ` +
            `Les périodes sont alignées sur leur premier ${granWord()}, ce qui permet de comparer même si ` +
            `elles ne portent pas sur les mêmes dates.`,
        render: (host, ctx) => renderPanelPair(host, ctx, METRICS.filter(m => m.group === 'calls'))
    },
    {
        key: 'other', wide: true, icon: '✉️',
        title: 'E-mails et enrichissement CRM comparés',
        sub: ctx => `Volume par ${granWord(ctx.gran)}. Les deux panneaux partagent la même échelle verticale.`,
        legend: ctx => [
            { head: 'Bleu = période analysée · Violet = période de référence' },
            ...METRICS.filter(m => m.group !== 'calls').map((m, i) => ({
                pair: [A_SHADES[i], B_SHADES[i]], label: m.short
            }))
        ],
        note: () => `Même principe que l'activité téléphonique : deux panneaux, une seule échelle. ` +
            `L'enrichissement du CRM est un travail de fond dont l'effet se voit sur les semaines suivantes, ` +
            `pas le jour même : c'est le volume régulier qui compte, pas le pic.`,
        render: (host, ctx) => renderPanelPair(host, ctx, METRICS.filter(m => m.group !== 'calls'))
    },
    {
        key: 'rates', wide: true, icon: '🎯',
        title: 'Taux de conversion comparés',
        sub: ctx => `Taux recalculés sur chaque ${granWord(ctx.gran)}, avec le niveau de la référence en repère.`,
        legend: ctx => [
            { color: A_SHADES[0], shape: 'line', label: 'Appels aboutis / appels passés (%)' },
            { color: A_SHADES[2], shape: 'line', label: 'RDV / appels aboutis (%)' },
            { color: B_MAIN, shape: 'dash', label: `Niveaux de la référence · ${pLab(ctx.bP)}` }
        ],
        note: () => `Les taux sont <b>recalculés à partir des volumes</b> de chaque ${granWord()} ` +
            `(somme des aboutis ÷ somme des appels), et non obtenus en moyennant des taux quotidiens : ` +
            `sinon un jour à 2 appels pèserait autant qu'un jour à 50.<br><br>` +
            `Les <b>traits violets horizontaux</b> donnent les deux taux de la période de référence. ` +
            `Lecture utile : un volume d'appels en hausse avec des taux qui passent sous les traits violets ` +
            `signale un problème de ciblage ou de discours, pas un manque d'effort.`,
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
            lineChart(host, {
                labels: buckets.map(b => b.label),
                series: [
                    { name: 'Aboutis %', color: A_SHADES[0], values: aggs.map(a => a.connect_rate), fmt: v => `${fmtDec(v)} %` },
                    { name: 'RDV %', color: A_SHADES[2], values: aggs.map(a => a.meeting_rate), fmt: v => `${fmtDec(v)} %` }
                ],
                refLines: refs,
                height: ctx.big ? 440 : 250
            });
        }
    },
    {
        key: 'funnels', icon: '🔻',
        title: 'Entonnoirs comparés',
        sub: () => 'De l\'appel passé au rendez-vous obtenu, sur chacune des deux périodes.',
        legend: ctx => [
            { periodStyle: 'a', color: A_MAIN, label: `Analysée · ${pLab(ctx.aP)}` },
            { periodStyle: 'b', color: B_MAIN, label: `Référence · ${pLab(ctx.bP)}` }
        ],
        note: () => `Le pourcentage à droite de chaque barre est le <b>taux de passage depuis l'étape ` +
            `précédente</b>, pas depuis le total. Comparer les deux entonnoirs montre où se situe l'écart : ` +
            `un même nombre de rendez-vous peut venir de plus d'appels (effort) ou d'un meilleur taux (efficacité).`,
        render: (host, ctx) => {
            const build = (rows, shades) => {
                const a = agg(rows);
                return [
                    { label: 'Appels passés', value: a.calls_made, color: shades[0] },
                    { label: 'Appels aboutis', value: a.calls_connected, color: shades[1] },
                    { label: 'Rendez-vous', value: a.meetings_booked, color: shades[2] }
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
            funnel(host.querySelector('[data-f="a"]'), build(ctx.aRows, A_SHADES));
            funnel(host.querySelector('[data-f="b"]'), build(ctx.bRows, B_SHADES));
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

    const draw = (sel, buckets, shades) => barChart(host.querySelector(sel), {
        labels: buckets.map(b => b.label),
        series: metrics.map((m, i) => ({
            name: m.short, color: shades[i],
            values: buckets.map(b => agg(b.rows)[m.key])
        })),
        yMax: shared,
        height: ctx.big ? 300 : 210
    });
    draw('[data-p="a"]', bucketsA, A_SHADES);
    draw('[data-p="b"]', bucketsB, B_SHADES);
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
        { label: '✅ Appels aboutis', key: 'calls_connected' },
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
            <div class="kpi-sub">Référence : ${show(r)} ${unit}</div>
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
        </div>`;
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
            <p>${c.note(ctx)}</p></details>` : ''}
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
            `<tr><td colspan="11" class="td-muted" style="text-align:center;padding:32px">
             Aucune saisie sur la période analysée.</td></tr>`;
        return;
    }

    $('#history-body').innerHTML = act.map(r => {
        const cls = [];
        if (r.activity_date === T) cls.push('is-today');
        if (score(r) === best) cls.push('is-best');
        return `
        <tr class="${cls.join(' ')}">
            <td>${escapeHtml(formatLong(r.activity_date).replace(/ \d{4}$/, ''))}
                ${r.notes ? `<span title="${escapeHtml(r.notes)}" style="cursor:help"> 📝</span>` : ''}</td>
            <td>${fmtInt(num(r, 'calls_made'))}</td>
            <td>${fmtInt(num(r, 'calls_connected'))}</td>
            <td><b>${fmtInt(num(r, 'meetings_booked'))}</b></td>
            <td>${fmtInt(num(r, 'emails_sent'))}</td>
            <td>${fmtInt(num(r, 'companies_created'))}</td>
            <td>${fmtInt(num(r, 'contacts_created'))}</td>
            <td class="${r.connect_rate == null ? 'td-muted' : ''}">${r.connect_rate == null ? '–' : fmtDec(r.connect_rate) + ' %'}</td>
            <td class="${r.meeting_rate == null ? 'td-muted' : ''}">${r.meeting_rate == null ? '–' : fmtDec(r.meeting_rate) + ' %'}</td>
            <td><b>${fmtInt(score(r))}</b></td>
            <td><a class="link-edit" href="./index.html?date=${r.activity_date}">modifier</a></td>
        </tr>`;
    }).join('');
}

function exportCsv() {
    const rows = rowsFor(state.a).filter(isActive);
    if (!rows.length) { toast('Rien à exporter sur cette période.', 'error'); return; }

    const head = ['Date', 'Appels', 'Appels aboutis', 'RDV', 'E-mails',
        'Entreprises', 'Contacts', 'Taux aboutis %', 'Taux RDV %', 'Score', 'Note'];
    const body = rows.map(r => [
        r.activity_date, num(r, 'calls_made'), num(r, 'calls_connected'),
        num(r, 'meetings_booked'), num(r, 'emails_sent'),
        num(r, 'companies_created'), num(r, 'contacts_created'),
        r.connect_rate == null ? '' : fmtDec(r.connect_rate),
        r.meeting_rate == null ? '' : fmtDec(r.meeting_rate),
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
    const session = await requireAuth();
    renderNav(session);

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

    await refresh();
    hideVeil();
})();
