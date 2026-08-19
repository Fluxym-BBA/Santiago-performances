/* ==========================================================================
   DASHBOARD.JS — Analyse de performance.
   Un jour analysé, une référence de comparaison au choix (veille, record,
   moyenne, date précise) et une période pour les tendances.
   ========================================================================== */

import {
    requireAuth, METRICS, EMPTY_DAY,
    todayISO, addDaysISO, diffDays, formatLong, formatShort, relativeLabel, isWeekend,
    fetchRange, fetchDayKpi, fetchBestDay, humanError
} from './api.js';
import {
    $, toast, fmtInt, fmtDec, delta, escapeHtml, hideVeil,
    lineChart, barChart, compareChart, funnel
} from './ui.js';
import { renderNav } from './nav.js';

const state = {
    day: todayISO(),
    refMode: 'yesterday',   // yesterday | best | avg | custom
    refDay: addDaysISO(todayISO(), -1),
    period: 30
};

let session = null;
let rows = [];        // période densifiée
let bestDay = null;   // record absolu (vue v_best_day)

/* --------------------------------------------------------------------------
   Utilitaires de données
   -------------------------------------------------------------------------- */

const zeroDay = iso => ({
    ...EMPTY_DAY, activity_date: iso, productivity_score: 0, total_actions: 0,
    connect_rate: null, meeting_rate: null, calls_per_meeting: null, notes: null
});

/** Complète les jours sans saisie pour que les courbes ne mentent pas. */
function densify(list, fromIso, toIso) {
    const byDate = new Map(list.map(r => [r.activity_date, r]));
    const out = [];
    for (let iso = fromIso; diffDays(toIso, iso) >= 0; iso = addDaysISO(iso, 1)) {
        out.push(byDate.get(iso) || zeroDay(iso));
    }
    return out;
}

const num = (r, k) => Number(r?.[k]) || 0;
const score = r => num(r, 'productivity_score');
const active = r => num(r, 'total_actions') > 0;

function averageOf(list) {
    const act = list.filter(active);
    if (!act.length) return null;
    const avg = { ...zeroDay('moyenne') };
    const keys = [...METRICS.map(m => m.key), 'productivity_score', 'total_actions'];
    keys.forEach(k => { avg[k] = act.reduce((s, r) => s + num(r, k), 0) / act.length; });
    const calls = avg.calls_made, conn = avg.calls_connected;
    avg.connect_rate = calls > 0 ? (conn / calls) * 100 : null;
    avg.meeting_rate = conn > 0 ? (avg.meetings_booked / conn) * 100 : null;
    avg._count = act.length;
    return avg;
}

function movingAverage(values, window = 7) {
    return values.map((_, i) => {
        const start = Math.max(0, i - window + 1);
        const slice = values.slice(start, i + 1);
        return Math.round((slice.reduce((a, b) => a + b, 0) / slice.length) * 10) / 10;
    });
}

/** Série de jours travaillés consécutifs avec au moins une action (week-ends ignorés). */
function currentStreak(list) {
    const byDate = new Map(list.map(r => [r.activity_date, r]));
    let streak = 0;
    let iso = state.day;
    // On tolère que le jour analysé soit encore vide en début de journée.
    if (!active(byDate.get(iso))) iso = addDaysISO(iso, -1);
    while (byDate.has(iso)) {
        if (isWeekend(iso)) { iso = addDaysISO(iso, -1); continue; }
        if (!active(byDate.get(iso))) break;
        streak++;
        iso = addDaysISO(iso, -1);
    }
    return streak;
}

/* --------------------------------------------------------------------------
   Rendu — KPI
   -------------------------------------------------------------------------- */

function refLabel() {
    switch (state.refMode) {
        case 'best': return bestDay ? `record du ${formatShort(bestDay.activity_date)}` : 'record (aucun)';
        case 'avg': return `moyenne ${state.period} j`;
        case 'yesterday': return `veille (${formatShort(addDaysISO(state.day, -1))})`;
        default: return formatShort(state.refDay);
    }
}

function tile(label, value, unit, dRef, sub, hero = false) {
    return `
    <div class="kpi-tile${hero ? ' kpi-tile--hero' : ''}">
        <div class="kpi-label">${label}</div>
        <div class="kpi-value">${value}${unit ? ` <small>${unit}</small>` : ''}</div>
        ${dRef || ''}
        ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`;
}

function renderKpis(dayRow, refRow) {
    const items = [
        { label: '⚡ Score de productivité', key: 'productivity_score', hero: true, unit: '' },
        { label: '🤝 Rendez-vous', key: 'meetings_booked', unit: '' },
        { label: '📞 Appels', key: 'calls_made', unit: '' },
        { label: '✅ Appels aboutis', key: 'calls_connected', unit: '' },
        { label: '✉️ E-mails', key: 'emails_sent', unit: '' }
    ];

    let html = items.map(it => {
        const v = num(dayRow, it.key);
        const r = refRow ? num(refRow, it.key) : null;
        const d = refRow ? delta(v, r).html : '';
        const sub = refRow
            ? `Référence : ${fmtDec(r, r % 1 === 0 ? 0 : 1)} · ${escapeHtml(refLabel())}`
            : 'Aucune référence disponible';
        return tile(it.label, fmtInt(v), it.unit, d, sub, it.hero);
    }).join('');

    const crm = num(dayRow, 'companies_created') + num(dayRow, 'contacts_created');
    const crmRef = refRow ? num(refRow, 'companies_created') + num(refRow, 'contacts_created') : null;
    html += tile('🗂️ Fiches CRM créées', fmtInt(crm), '',
        refRow ? delta(crm, crmRef).html : '',
        `${fmtInt(num(dayRow, 'companies_created'))} entreprises · ${fmtInt(num(dayRow, 'contacts_created'))} contacts`);

    const cr = dayRow.connect_rate, mr = dayRow.meeting_rate;
    html += tile('🎯 Taux d\'appels aboutis',
        cr === null || cr === undefined ? '–' : fmtDec(cr), '%',
        refRow && refRow.connect_rate != null && cr != null
            ? delta(Math.round(cr), Math.round(refRow.connect_rate), { suffix: ' pts' }).html : '',
        num(dayRow, 'calls_made') ? `sur ${fmtInt(num(dayRow, 'calls_made'))} appels` : 'aucun appel saisi');

    html += tile('🏁 Taux de RDV',
        mr === null || mr === undefined ? '–' : fmtDec(mr), '%',
        refRow && refRow.meeting_rate != null && mr != null
            ? delta(Math.round(mr), Math.round(refRow.meeting_rate), { suffix: ' pts' }).html : '',
        num(dayRow, 'calls_connected') ? `sur ${fmtInt(num(dayRow, 'calls_connected'))} appels aboutis` : 'aucun appel abouti');

    $('#kpi-grid').innerHTML = html;
}

/* --------------------------------------------------------------------------
   Rendu — comparaison, entonnoirs, records
   -------------------------------------------------------------------------- */

function renderCompare(dayRow, refRow) {
    $('#compare-sub').textContent =
        `${formatLong(state.day)} face à : ${refLabel()}.`;
    $('#compare-hint').textContent = refRow
        ? 'Barre foncée : le jour analysé. Barre grise : la référence.'
        : 'Aucune référence disponible pour cette comparaison.';

    compareChart($('#chart-compare'), {
        rows: METRICS.map(m => ({
            label: m.short, color: m.color,
            a: num(dayRow, m.key), b: refRow ? num(refRow, m.key) : 0
        })),
        labelA: relativeLabel(state.day) + ' · ' + formatShort(state.day),
        labelB: refLabel()
    });
}

function renderFunnels(dayRow) {
    funnel($('#funnel-day'), [
        { label: 'Appels passés', value: num(dayRow, 'calls_made'), color: '#00A7E1' },
        { label: 'Appels aboutis', value: num(dayRow, 'calls_connected'), color: '#0ea5e9' },
        { label: 'Rendez-vous', value: num(dayRow, 'meetings_booked'), color: '#10b981' }
    ]);

    const sum = k => rows.reduce((s, r) => s + num(r, k), 0);
    funnel($('#funnel-period'), [
        { label: 'Appels passés', value: sum('calls_made'), color: '#0B2046' },
        { label: 'Appels aboutis', value: sum('calls_connected'), color: '#132d5e' },
        { label: 'Rendez-vous', value: sum('meetings_booked'), color: '#059669' }
    ]);

    const rdv = sum('meetings_booked');
    $('#funnel-period-hint').textContent = rdv > 0
        ? `Sur ${state.period} jours : ${fmtDec(sum('calls_made') / rdv)} appels pour obtenir 1 rendez-vous.`
        : 'Cumul sur la période choisie.';
}

function renderRecords() {
    const act = rows.filter(active);
    const bestInRange = act.reduce((b, r) => (!b || score(r) > score(b)) ? r : b, null);
    const sum = k => rows.reduce((s, r) => s + num(r, k), 0);
    const avg = averageOf(rows);

    const line = (label, value, sub) => `
        <div class="metric">
            <div class="metric-top">
                <div class="metric-label"><b>${label}</b><span>${sub || ''}</span></div>
                <div style="font-size:19px;font-weight:900;color:var(--navy);text-align:right">${value}</div>
            </div>
        </div>`;

    $('#records').innerHTML = [
        line('🏆 Meilleur jour de tous les temps',
            bestDay ? fmtInt(score(bestDay)) : '–',
            bestDay ? `${formatLong(bestDay.activity_date)} · ${fmtInt(num(bestDay, 'meetings_booked'))} RDV`
                    : 'aucune donnée'),
        line('🥇 Meilleur jour de la période',
            bestInRange ? fmtInt(score(bestInRange)) : '–',
            bestInRange ? formatLong(bestInRange.activity_date) : 'aucune donnée'),
        line('📈 Score moyen par jour travaillé',
            avg ? fmtDec(avg.productivity_score) : '–',
            avg ? `sur ${avg._count} jours avec activité` : 'aucune donnée'),
        line('🔥 Série en cours', `${currentStreak(rows)} j`,
            'jours travaillés consécutifs avec au moins une action'),
        line('📦 Cumul de la période',
            `${fmtInt(sum('meetings_booked'))} RDV`,
            `${fmtInt(sum('calls_made'))} appels · ${fmtInt(sum('emails_sent'))} e-mails · ${fmtInt(sum('companies_created') + sum('contacts_created'))} fiches CRM`)
    ].join('');
}

/* --------------------------------------------------------------------------
   Rendu — tendances
   -------------------------------------------------------------------------- */

function renderTrends() {
    const labels = rows.map(r => formatShort(r.activity_date));
    const scores = rows.map(score);

    $('#trend-sub').textContent =
        `Du ${formatLong(rows[0]?.activity_date || state.day)} au ${formatLong(state.day)} · ${state.period} jours.`;

    lineChart($('#chart-score'), {
        labels,
        series: [
            { name: 'Score', color: '#00A7E1', values: scores, area: true },
            { name: 'Moyenne 7 j', color: '#6366f1', values: movingAverage(scores), dashed: true }
        ],
        height: 250
    });

    const callMetrics = METRICS.filter(m => m.group === 'calls');
    $('#legend-calls').innerHTML = callMetrics.map(m =>
        `<span class="legend-item"><span class="legend-dot" style="background:${m.color}"></span>${escapeHtml(m.short)}</span>`).join('');
    barChart($('#chart-calls'), {
        labels,
        series: callMetrics.map(m => ({ name: m.short, color: m.color, values: rows.map(r => num(r, m.key)) })),
        height: 240
    });

    const otherMetrics = METRICS.filter(m => m.group !== 'calls');
    $('#legend-other').innerHTML = otherMetrics.map(m =>
        `<span class="legend-item"><span class="legend-dot" style="background:${m.color}"></span>${escapeHtml(m.short)}</span>`).join('');
    barChart($('#chart-other'), {
        labels,
        series: otherMetrics.map(m => ({ name: m.short, color: m.color, values: rows.map(r => num(r, m.key)) })),
        height: 240
    });

    lineChart($('#chart-rates'), {
        labels,
        series: [
            { name: 'Appels aboutis %', color: '#0ea5e9', values: rows.map(r => Number(r.connect_rate) || 0) },
            { name: 'RDV %', color: '#10b981', values: rows.map(r => Number(r.meeting_rate) || 0) }
        ],
        height: 230
    });
}

/* --------------------------------------------------------------------------
   Rendu — tableau
   -------------------------------------------------------------------------- */

function renderTable() {
    const act = rows.filter(active).slice().reverse();
    const bestScore = Math.max(0, ...act.map(score));

    if (!act.length) {
        $('#history-body').innerHTML =
            `<tr><td colspan="11" class="td-muted" style="text-align:center;padding:32px">
             Aucune saisie sur la période. Commencez par la page « Saisie du jour ».</td></tr>`;
        return;
    }

    $('#history-body').innerHTML = act.map(r => {
        const cls = [];
        if (r.activity_date === todayISO()) cls.push('is-today');
        if (score(r) === bestScore) cls.push('is-best');
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

/* --------------------------------------------------------------------------
   Chargement
   -------------------------------------------------------------------------- */

function paintControls() {
    $('#day-picker').value = state.day;
    $('#day-picker').max = todayISO();
    $('#ref-picker').max = todayISO();
    $('#day-next').disabled = state.day === todayISO();
    $('#chip-today').classList.toggle('chip--active', state.day === todayISO());
    document.querySelectorAll('[data-ref]').forEach(b =>
        b.classList.toggle('chip--active', b.dataset.ref === state.refMode));
    document.querySelectorAll('[data-period]').forEach(b =>
        b.classList.toggle('chip--active', Number(b.dataset.period) === state.period));
    $('#ref-picker').value = state.refMode === 'custom' ? state.refDay : '';
}

async function refresh() {
    paintControls();
    $('#load-status').textContent = 'Chargement…';
    $('#load-status').className = 'date-status';

    const to = state.day;
    const from = addDaysISO(to, -(state.period - 1));

    try {
        const [range, best] = await Promise.all([fetchRange(from, to), fetchBestDay()]);
        rows = densify(range, from, to);
        bestDay = best;

        const byDate = new Map(rows.map(r => [r.activity_date, r]));
        const dayRow = byDate.get(state.day) || (await fetchDayKpi(state.day)) || zeroDay(state.day);

        let refRow = null;
        if (state.refMode === 'yesterday') {
            const iso = addDaysISO(state.day, -1);
            refRow = byDate.get(iso) || (await fetchDayKpi(iso)) || zeroDay(iso);
        } else if (state.refMode === 'best') {
            refRow = bestDay;
        } else if (state.refMode === 'avg') {
            refRow = averageOf(rows.filter(r => r.activity_date !== state.day));
        } else {
            refRow = byDate.get(state.refDay) || (await fetchDayKpi(state.refDay)) || zeroDay(state.refDay);
        }

        renderKpis(dayRow, refRow);
        renderCompare(dayRow, refRow);
        renderFunnels(dayRow);
        renderRecords();
        renderTrends();
        renderTable();

        $('#load-status').textContent = '✓ À jour';
        $('#load-status').className = 'date-status date-status--saved';
    } catch (e) {
        $('#load-status').textContent = '⚠ Lecture impossible';
        $('#load-status').className = 'date-status date-status--error';
        toast(humanError(e), 'error', 6000);
    }
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

(async function init() {
    session = await requireAuth();
    renderNav(session);

    const wanted = new URLSearchParams(location.search).get('date');
    if (wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) && diffDays(todayISO(), wanted) >= 0) {
        state.day = wanted;
    }

    $('#day-prev').addEventListener('click', () => { state.day = addDaysISO(state.day, -1); refresh(); });
    $('#day-next').addEventListener('click', () => {
        const n = addDaysISO(state.day, 1);
        if (diffDays(todayISO(), n) >= 0) { state.day = n; refresh(); }
    });
    $('#chip-today').addEventListener('click', () => { state.day = todayISO(); refresh(); });
    $('#day-picker').addEventListener('change', e => {
        if (!e.target.value) return;
        if (diffDays(todayISO(), e.target.value) < 0) { toast('Date dans le futur.', 'error'); return; }
        state.day = e.target.value; refresh();
    });

    document.querySelectorAll('[data-ref]').forEach(b =>
        b.addEventListener('click', () => { state.refMode = b.dataset.ref; refresh(); }));
    $('#ref-picker').addEventListener('change', e => {
        if (!e.target.value) return;
        state.refMode = 'custom'; state.refDay = e.target.value; refresh();
    });
    document.querySelectorAll('[data-period]').forEach(b =>
        b.addEventListener('click', () => { state.period = Number(b.dataset.period); refresh(); }));

    await refresh();
    hideVeil();
})();
