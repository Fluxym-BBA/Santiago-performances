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
    fetchRange, fetchBestDay, humanError
} from './api.js';
import {
    $, toast, fmtInt, fmtDec, delta, escapeHtml, hideVeil,
    lineChart, barChart, compareChart, funnel
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
let localScope = null;    // période propre au graphique agrandi
let openKey = null;       // graphique actuellement agrandi

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
   Registre des graphiques
   Chaque entrée sait se dessiner dans n'importe quel conteneur, ce qui permet
   de la rendre soit dans la grille, soit agrandie, sans dupliquer de code.
   -------------------------------------------------------------------------- */

const CHARTS = [
    {
        key: 'compare', wide: true, title: '📊 Comparaison action par action',
        hint: ctx => `Barre foncée : ${periodLabelShort(ctx.aP.from, ctx.aP.to)}. Barre grise : ${periodLabelShort(ctx.bP.from, ctx.bP.to)}.`,
        render: (host, ctx) => {
            const aA = agg(ctx.aRows), aB = agg(ctx.bRows);
            const mode = ctx.mode;
            compareChart(host, {
                rows: METRICS.map(m => ({
                    label: m.short, color: m.color,
                    a: val(aA, m.key, mode), b: val(aB, m.key, mode)
                })),
                labelA: periodLabelShort(ctx.aP.from, ctx.aP.to),
                labelB: periodLabelShort(ctx.bP.from, ctx.bP.to),
                height: ctx.big ? 420 : undefined
            });
        }
    },
    {
        key: 'cumul', wide: true, title: '📈 Course cumulée entre les deux périodes',
        hint: () => 'Les deux périodes sont alignées sur leur premier jour. Si la courbe foncée passe au-dessus, vous faites mieux qu\'à la référence au même stade.',
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
        render: (host, ctx) => {
            const key = state.cumulMetric;
            const cum = rows => {
                let t = 0;
                return rows.map(r => (t += num(r, key)));
            };
            const ca = cum(ctx.aRows), cb = cum(ctx.bRows);
            const n = Math.max(ca.length, cb.length);
            const pad = arr => Array.from({ length: n }, (_, i) => (i < arr.length ? arr[i] : null));
            lineChart(host, {
                labels: Array.from({ length: n }, (_, i) => `J${i + 1}`),
                series: [
                    { name: periodLabelShort(ctx.aP.from, ctx.aP.to), color: '#00A7E1', values: pad(ca), area: true },
                    { name: periodLabelShort(ctx.bP.from, ctx.bP.to), color: '#9ca3af', values: pad(cb), dashed: true }
                ],
                height: ctx.big ? 420 : 250
            });
        }
    },
    {
        key: 'score', wide: true, title: '⚡ Score de productivité',
        hint: ctx => `Courbe pleine : le score par ${granWord(ctx.gran)}. Courbe pointillée : la tendance de fond (moyenne mobile sur 7 points).`,
        legend: () => [['#00A7E1', 'Score'], ['#6366f1', 'Tendance']],
        render: (host, ctx) => {
            const buckets = bucketize(ctx.aRows, ctx.gran);
            const values = buckets.map(b => agg(b.rows).productivity_score);
            const ma = values.map((_, i) => {
                const s = values.slice(Math.max(0, i - 6), i + 1);
                return Math.round((s.reduce((x, y) => x + y, 0) / s.length) * 10) / 10;
            });
            lineChart(host, {
                labels: buckets.map(b => b.label),
                series: [
                    { name: 'Score', color: '#00A7E1', values, area: true },
                    ...(values.length >= 5 ? [{ name: 'Tendance', color: '#6366f1', values: ma, dashed: true }] : [])
                ],
                height: ctx.big ? 440 : 250
            });
        }
    },
    {
        key: 'calls', title: '📞 Activité téléphonique',
        hint: ctx => `Volume par ${granWord(ctx.gran)} sur la période analysée.`,
        legend: () => METRICS.filter(m => m.group === 'calls').map(m => [m.color, m.short]),
        render: (host, ctx) => {
            const buckets = bucketize(ctx.aRows, ctx.gran);
            barChart(host, {
                labels: buckets.map(b => b.label),
                series: METRICS.filter(m => m.group === 'calls').map(m => ({
                    name: m.short, color: m.color,
                    values: buckets.map(b => agg(b.rows)[m.key])
                })),
                height: ctx.big ? 420 : 240
            });
        }
    },
    {
        key: 'other', title: '✉️ E-mails et enrichissement CRM',
        hint: ctx => `Volume par ${granWord(ctx.gran)} sur la période analysée.`,
        legend: () => METRICS.filter(m => m.group !== 'calls').map(m => [m.color, m.short]),
        render: (host, ctx) => {
            const buckets = bucketize(ctx.aRows, ctx.gran);
            barChart(host, {
                labels: buckets.map(b => b.label),
                series: METRICS.filter(m => m.group !== 'calls').map(m => ({
                    name: m.short, color: m.color,
                    values: buckets.map(b => agg(b.rows)[m.key])
                })),
                height: ctx.big ? 420 : 240
            });
        }
    },
    {
        key: 'rates', wide: true, title: '🎯 Taux de conversion',
        hint: ctx => `Recalculés sur chaque ${granWord(ctx.gran)} à partir des volumes, pas moyennés : un jour à 2 appels ne pèse pas autant qu'un jour à 50.`,
        legend: () => [['#0ea5e9', "Appels aboutis (%)"], ['#10b981', 'RDV sur aboutis (%)']],
        render: (host, ctx) => {
            const buckets = bucketize(ctx.aRows, ctx.gran).map(b => agg(b.rows));
            lineChart(host, {
                labels: bucketize(ctx.aRows, ctx.gran).map(b => b.label),
                series: [
                    { name: 'Aboutis %', color: '#0ea5e9', values: buckets.map(b => b.connect_rate), fmt: v => `${fmtDec(v)} %` },
                    { name: 'RDV %', color: '#10b981', values: buckets.map(b => b.meeting_rate), fmt: v => `${fmtDec(v)} %` }
                ],
                height: ctx.big ? 420 : 230
            });
        }
    },
    {
        key: 'funnels', title: '🔻 Entonnoirs comparés',
        hint: () => 'Le pourcentage indique la conversion depuis l\'étape précédente.',
        render: (host, ctx) => {
            const build = (rows, colors) => {
                const a = agg(rows);
                return [
                    { label: 'Appels passés', value: a.calls_made, color: colors[0] },
                    { label: 'Appels aboutis', value: a.calls_connected, color: colors[1] },
                    { label: 'Rendez-vous', value: a.meetings_booked, color: colors[2] }
                ];
            };
            host.innerHTML = `
                <div style="font-size:12px;font-weight:800;color:var(--navy);margin:4px 0 8px">
                    ${escapeHtml(periodLabelShort(ctx.aP.from, ctx.aP.to))}</div>
                <div class="funnel" data-f="a"></div>
                <div style="font-size:12px;font-weight:800;color:var(--gray-400);margin:22px 0 8px">
                    ${escapeHtml(periodLabelShort(ctx.bP.from, ctx.bP.to))}</div>
                <div class="funnel" data-f="b"></div>`;
            funnel(host.querySelector('[data-f="a"]'), build(ctx.aRows, ['#00A7E1', '#0ea5e9', '#10b981']));
            funnel(host.querySelector('[data-f="b"]'), build(ctx.bRows, ['#9ca3af', '#b0b7c1', '#cbd5e1']));
        }
    },
    {
        key: 'records', title: '🏅 Records et régularité',
        hint: () => 'Sur la période analysée, et sur tout l\'historique pour le record absolu.',
        render: (host, ctx) => {
            const a = agg(ctx.aRows);
            const bestInA = ctx.aRows.filter(isActive)
                .reduce((b, r) => (!b || score(r) > score(b)) ? r : b, null);
            const line = (label, value, sub) => `
                <div class="metric">
                    <div class="metric-top">
                        <div class="metric-label"><b>${label}</b><span>${sub || ''}</span></div>
                        <div style="font-size:19px;font-weight:900;color:var(--navy);text-align:right">${value}</div>
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
                    `${a.activeDays} jour(s) avec activité sur ${a.workdays} jour(s) ouvré(s)`),
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

const granWord = g => ({ day: 'jour', week: 'semaine', month: 'mois' }[g || effGran()]);

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
}

function renderSummary(aA, aB) {
    const mode = effMode();
    const pills = [
        `<span class="pill pill--a">A · ${escapeHtml(periodLabel(state.a.from, state.a.to))}</span>`,
        `<span class="pill pill--b">B · ${escapeHtml(periodLabel(state.b.from, state.b.to))}</span>`
    ];

    if (lengthsDiffer()) {
        pills.push(`<span class="pill pill--warn">⚠ Durées différentes${
            mode === 'avg' ? ' : lecture en moyenne par jour actif' : ' : le cumul est trompeur'}</span>`);
    }
    if (effGran() !== 'day') {
        pills.push(`<span class="pill pill--info">Graphiques regroupés par ${granWord()}</span>`);
    }
    // Diagnostic : distingue « aucune saisie sur la période » de « rien reçu de la base ».
    if (byDate.size === 0) {
        pills.push('<span class="pill pill--warn">⚠ Aucune ligne reçue de la base sur la plage chargée '
            + `(${periodLabelShort(loaded.from, loaded.to)})</span>`);
    } else if (aA.activeDays === 0 && aB.activeDays === 0) {
        pills.push(`<span class="pill pill--warn">⚠ Aucune saisie sur ces deux périodes, alors que ${
            byDate.size} jour(s) existent dans l'historique</span>`);
    }

    $('#control-summary').innerHTML = `
        ${pills.join(' ')}
        <span style="margin-left:auto">
            <b>${aA.activeDays}</b> jour(s) saisi(s) sur <b>${aA.workdays}</b> ouvré(s) en A ·
            <b>${aB.activeDays}</b> sur <b>${aB.workdays}</b> en B
        </span>`;
}

/* --------------------------------------------------------------------------
   Rendu — KPI
   -------------------------------------------------------------------------- */

function renderKpis(aA, aB) {
    const mode = effMode();
    const unit = mode === 'avg' ? '/ jour' : '';
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

    html += rate('🎯 Taux d\'appels aboutis', 'connect_rate',
        `sur ${fmtInt(aA.calls_made)} appels`);
    html += rate('🏁 Taux de RDV', 'meeting_rate',
        `sur ${fmtInt(aA.calls_connected)} aboutis`);

    html += `
        <div class="kpi-tile">
            <div class="kpi-label">💪 Effort par rendez-vous</div>
            <div class="kpi-value">${aA.calls_per_meeting == null ? '–' : fmtDec(aA.calls_per_meeting)} <small>appels</small></div>
            ${(aA.calls_per_meeting != null && aB.calls_per_meeting != null)
                ? delta(Math.round(aA.calls_per_meeting * 10) / 10, Math.round(aB.calls_per_meeting * 10) / 10,
                        { higherIsBetter: false }).html : ''}
            <div class="kpi-sub">nombre d'appels pour obtenir 1 RDV · référence : ${
                aB.calls_per_meeting == null ? '–' : fmtDec(aB.calls_per_meeting)}</div>
        </div>`;

    $('#kpi-grid').innerHTML = html;
}

/* --------------------------------------------------------------------------
   Rendu — grille de graphiques
   -------------------------------------------------------------------------- */

function ctxFor(chart, { big = false, scope = null } = {}) {
    const aP = scope || state.a;
    const bP = scope ? previousPeriod(scope.from, scope.to) : state.b;
    return {
        aP, bP, big,
        aRows: rowsFor(aP), bRows: rowsFor(bP),
        gran: scope
            ? (periodLength(aP.from, aP.to) <= 31 ? 'day'
                : periodLength(aP.from, aP.to) <= 180 ? 'week' : 'month')
            : effGran(),
        mode: scope
            ? (periodLength(aP.from, aP.to) === periodLength(bP.from, bP.to) ? 'total' : 'avg')
            : effMode()
    };
}

function renderCharts() {
    const grid = $('#charts-grid');
    const ctxs = new Map(CHARTS.map(c => [c.key, ctxFor(c)]));
    grid.innerHTML = CHARTS.map(c => `
        <div class="chart-card${c.wide ? ' chart-card--wide' : ''}">
            <div class="chart-head">
                <div class="chart-title">${c.title}</div>
                <div class="chart-tools">
                    ${c.select ? `<select class="chart-select" data-sel="${c.key}">${
                        c.select.options().map(o =>
                            `<option value="${o.v}"${o.v === c.select.get() ? ' selected' : ''}>${o.t}</option>`).join('')
                    }</select>` : ''}
                    <button class="icon-btn" type="button" data-zoom="${c.key}"
                            title="Agrandir et explorer" aria-label="Agrandir">⛶</button>
                </div>
            </div>
            <div class="chart-hint">${escapeHtml(c.hint(ctxs.get(c.key)))}</div>
            ${c.legend ? `<div class="chart-legend">${c.legend().map(([col, txt]) =>
                `<span class="legend-item"><span class="legend-dot" style="background:${col}"></span>${escapeHtml(txt)}</span>`).join('')}</div>` : ''}
            <div data-host="${c.key}"></div>
        </div>`).join('');

    CHARTS.forEach(c => c.render(grid.querySelector(`[data-host="${c.key}"]`), ctxs.get(c.key)));

    grid.querySelectorAll('[data-zoom]').forEach(b =>
        b.addEventListener('click', () => openModal(b.dataset.zoom)));
    grid.querySelectorAll('[data-sel]').forEach(sel =>
        sel.addEventListener('change', () => {
            CHARTS.find(c => c.key === sel.dataset.sel).select.set(sel.value);
            renderCharts();
        }));
}

/* --------------------------------------------------------------------------
   Agrandissement
   -------------------------------------------------------------------------- */

function openModal(key) {
    openKey = key;
    localScope = null;
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';
    paintModal();
}

function closeModal() {
    openKey = null;
    localScope = null;
    $('#modal').hidden = true;
    document.body.style.overflow = '';
}

function paintModal() {
    const c = CHARTS.find(x => x.key === openKey);
    if (!c) return;
    const ctx = ctxFor(c, { big: true, scope: localScope });

    $('#modal-title').innerHTML = c.title;
    $('#modal-sub').textContent = localScope
        ? `${periodLabel(ctx.aP.from, ctx.aP.to)}, comparé à la période précédente équivalente (${periodLabelShort(ctx.bP.from, ctx.bP.to)}).`
        : `${periodLabel(ctx.aP.from, ctx.aP.to)}, comparé à ${periodLabel(ctx.bP.from, ctx.bP.to)}.`;
    $('#modal-from').value = ctx.aP.from;
    $('#modal-to').value = ctx.aP.to;
    $('#modal-from').max = todayISO();
    $('#modal-to').max = todayISO();
    $('#modal-scope').textContent = localScope ? 'dates propres à ce graphique' : 'période globale';
    $('#modal-scope').className = 'pill ' + (localScope ? 'pill--warn' : 'pill--info');

    const body = $('#modal-body');
    body.innerHTML = `<div class="chart-hint" style="margin-bottom:14px">${escapeHtml(c.hint(ctx))}</div>
        ${c.legend ? `<div class="chart-legend">${c.legend().map(([col, txt]) =>
            `<span class="legend-item"><span class="legend-dot" style="background:${col}"></span>${escapeHtml(txt)}</span>`).join('')}</div>` : ''}
        <div id="modal-host"></div>`;
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
    $('#modal-reset').addEventListener('click', () => { localScope = null; paintModal(); });
    const bindLocal = sel => $(sel).addEventListener('change', () => {
        const p = normalize({ from: $('#modal-from').value, to: $('#modal-to').value });
        if (!p.from || !p.to) return;
        localScope = p;
        paintModal();
    });
    bindLocal('#modal-from'); bindLocal('#modal-to');

    $('#btn-export').addEventListener('click', exportCsv);

    await refresh();
    hideVeil();
})();
