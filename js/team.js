/* ==========================================================================
   TEAM.JS — Vue d'équipe, réservée aux administrateurs.

   Elle réutilise tout ce qui existe : le même moteur de périodes, les mêmes
   agrégats (analytics.js), les mêmes graphiques (ui.js) et les mêmes
   info-bulles (tooltip.js). Rien n'est recalculé différemment ici, sans quoi
   deux pages finiraient par afficher deux chiffres pour la même chose.

   Une seule règle de couleur change : sur cette page, une couleur ne désigne
   plus une période mais une personne, et elle est tenue d'un graphique à
   l'autre. Le bleu et le violet reprennent leur rôle habituel dans le duel,
   qui est bien une comparaison de deux ensembles.
   ========================================================================== */

import {
    requireAuth, isAdmin, myProfile, viewedUser, setViewedUser, listProfiles,
    fetchTeamRange, todayISO, addDaysISO, formatLong, formatShort, periodLength,
    startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfQuarter, endOfQuarter,
    periodLabel, periodLabelShort, humanError, METRICS, SCORE_WEIGHTS
} from './api.js';
import {
    num, score, isActive, agg, valOf, bucketize, autoGran, granWord, rowsForRange
} from './analytics.js';
import {
    renderNav
} from './nav.js';
import {
    escapeHtml, fmtInt, fmtDec, toast, hideVeil, lineChart, barChart, compareChart,
    legendHtml
} from './ui.js';

/** État vide, écrit ici : ui.js ne l'expose que pour ses propres graphiques. */
const emptyStateHtml = (msg = 'Aucune donnée sur la période.') =>
    `<div class="chart-empty">${escapeHtml(msg)}</div>`;

const T = todayISO();

/* --------------------------------------------------------------------------
   Palette

   Une couleur par personne, choisies pour rester distinguables côte à côte et
   sur un aplat clair. Au-delà de huit BDR la palette se répète : on affiche
   alors les huit premiers du classement et un agrégat « autres ».
   -------------------------------------------------------------------------- */

const BDR_COLORS = [
    '#00A7E1', '#8b5cf6', '#10b981', '#f59e0b',
    '#0B2046', '#ef4444', '#0369a1', '#6d28d9'
];
const A_MAIN = '#00A7E1';
const B_MAIN = '#8b5cf6';
const MAX_SERIES = 8;

/* --------------------------------------------------------------------------
   État
   -------------------------------------------------------------------------- */

const state = {
    from: addDaysISO(T, -29),
    to: T,
    gran: 'auto',
    mode: 'total',
    demo: false,
    inactive: false,
    duelA: null,
    duelB: null
};

let people = [];      // [{ profile, byDate, rows, a }] trié par score décroissant
let allProfiles = [];

const effGran = () => (state.gran === 'auto' ? autoGran(state.from, state.to) : state.gran);
const pLabel = () => periodLabelShort(state.from, state.to);

/* --------------------------------------------------------------------------
   Chargement
   -------------------------------------------------------------------------- */

async function load() {
    const rows = await fetchTeamRange(state.from, state.to, {
        includeDemo: state.demo, includeInactive: state.inactive
    });

    // Regroupement par personne. Les profils sans aucune ligne sur la période
    // sont conservés avec un score nul : un BDR qui n'a rien saisi est une
    // information, le faire disparaître du classement serait trompeur.
    const map = new Map();
    allProfiles
        .filter(p => (state.demo || !p.is_demo) && (state.inactive || p.is_active))
        .forEach(p => map.set(p.user_id, { profile: p, byDate: new Map() }));

    rows.forEach(r => {
        if (!map.has(r.user_id)) {
            map.set(r.user_id, {
                profile: {
                    user_id: r.user_id, display_name: r.display_name, email: r.email,
                    role: r.role, is_demo: r.is_demo, is_active: r.is_active
                },
                byDate: new Map()
            });
        }
        map.get(r.user_id).byDate.set(r.activity_date, r);
    });

    people = [...map.values()].map(p => {
        const list = rowsForRange(p.byDate, state.from, state.to);
        return { ...p, rows: list, a: agg(list) };
    }).sort((x, y) => y.a.productivity_score - x.a.productivity_score);

    people.forEach((p, i) => {
        p.rank = i + 1;
        p.color = BDR_COLORS[i % BDR_COLORS.length];
    });

    if (!state.duelA && people[0]) state.duelA = people[0].profile.user_id;
    if (!state.duelB && people[1]) state.duelB = people[1].profile.user_id;
}

const nameOf = p => p.profile.display_name || p.profile.email || 'Sans nom';
const personBy = id => people.find(p => p.profile.user_id === id) || null;

/* --------------------------------------------------------------------------
   Indicateurs de tête
   -------------------------------------------------------------------------- */

function renderKpis() {
    const host = document.getElementById('kpi-grid');
    const team = agg(people.flatMap(p => p.rows));
    const activePeople = people.filter(p => p.a.activeDays > 0);
    const best = people[0];

    const tiles = [
        {
            hero: true, label: 'Score total de l\'équipe',
            value: fmtInt(team.productivity_score),
            sub: `${activePeople.length} BDR ayant saisi sur ${people.length} · ${pLabel()}`
        },
        { label: 'Appels passés', value: fmtInt(team.calls_made),
          sub: `${fmtInt(team.calls_connected)} aboutis · ${team.connect_rate == null ? '–' : fmtDec(team.connect_rate) + ' %'}` },
        { label: 'Rendez-vous', value: fmtInt(team.meetings_booked),
          sub: team.calls_per_meeting == null ? 'aucun RDV' : `${fmtDec(team.calls_per_meeting)} appels par RDV` },
        { label: 'E-mails envoyés', value: fmtInt(team.emails_sent),
          sub: `${fmtInt(team.crm)} fiches CRM créées` },
        { label: 'Meilleur score', value: best ? fmtInt(best.a.productivity_score) : '–',
          sub: best ? nameOf(best) : 'aucune donnée' },
        { label: 'Jours saisis', value: fmtInt(team.activeDays),
          sub: `sur ${fmtInt(people.length * periodLength(state.from, state.to))} jours-personne possibles` }
    ];

    host.innerHTML = tiles.map(it => `
        <div class="kpi-tile${it.hero ? ' kpi-tile--hero' : ''}">
            <div class="kpi-label">${escapeHtml(it.label)}</div>
            <div class="kpi-value">${it.value}</div>
            <div class="kpi-sub">${escapeHtml(it.sub)}</div>
        </div>`).join('');
}

/* --------------------------------------------------------------------------
   Classement
   -------------------------------------------------------------------------- */

function renderRanking() {
    const body = document.getElementById('ranking-body');
    if (!people.length) {
        body.innerHTML = '<tr><td colspan="13" class="td-muted">Aucun compte à afficher sur cette période.</td></tr>';
        return;
    }
    const dec = state.mode === 'avg';
    const f = v => (dec ? fmtDec(v) : fmtInt(v));
    const me = myProfile();

    body.innerHTML = people.map(p => {
        const a = p.a;
        const isMe = me && p.profile.user_id === me.user_id;
        const medal = p.rank === 1 ? '🥇' : p.rank === 2 ? '🥈' : p.rank === 3 ? '🥉' : p.rank;
        return `
        <tr${isMe ? ' class="row-me"' : ''}>
            <td class="rank-cell">${medal}</td>
            <td>
                <span class="bdr-chip">
                    <span class="bdr-dot" style="background:${p.color}"></span>
                    ${escapeHtml(nameOf(p))}
                    ${p.profile.is_demo ? '<b class="tag tag--demo">démo</b>' : ''}
                    ${p.profile.is_active ? '' : '<b class="tag">inactif</b>'}
                    ${p.profile.role === 'admin' ? '<b class="tag tag--admin">admin</b>' : ''}
                </span>
            </td>
            <td>${f(valOf(a, 'calls_made', state.mode))}</td>
            <td>${f(valOf(a, 'calls_connected', state.mode))}</td>
            <td>${f(valOf(a, 'meetings_booked', state.mode))}</td>
            <td>${f(valOf(a, 'emails_sent', state.mode))}</td>
            <td>${f(valOf(a, 'companies_created', state.mode))}</td>
            <td>${f(valOf(a, 'contacts_created', state.mode))}</td>
            <td>${a.connect_rate == null ? '–' : fmtDec(a.connect_rate) + ' %'}</td>
            <td>${a.meeting_rate == null ? '–' : fmtDec(a.meeting_rate) + ' %'}</td>
            <td class="td-muted">${fmtInt(a.activeDays)} / ${fmtInt(a.days)}</td>
            <td><b>${f(valOf(a, 'productivity_score', state.mode))}</b></td>
            <td>${isMe ? '<span class="td-muted">vous</span>'
                       : `<button class="chip chip--sm" type="button" data-open="${p.profile.user_id}">ouvrir →</button>`}</td>
        </tr>`;
    }).join('');

    body.querySelectorAll('[data-open]').forEach(b => {
        b.addEventListener('click', () => {
            const prof = allProfiles.find(x => x.user_id === b.dataset.open);
            if (!prof) return;
            setViewedUser(prof);
            location.href = './dashboard.html';
        });
    });
}

/* --------------------------------------------------------------------------
   Info-bulle d'équipe

   Même principe que sur la page Performances : on survole un moment, et l'on
   obtient tout le monde sur ce moment, classé, avec la part de chacun dans le
   total de l'équipe. C'est ce qui évite de survoler six séries l'une après
   l'autre pour reconstituer un classement de tête.
   -------------------------------------------------------------------------- */

function teamTip(buckets, key, unit = '') {
    return i => {
        const gran = effGran();
        const bk = buckets[0].list[i];
        const label = bk
            ? (gran === 'day' ? formatLong(bk.key) : `${bk.label} · ${periodLabelShort(
                bk.rows[0].activity_date, bk.rows[bk.rows.length - 1].activity_date)}`)
            : '—';

        const vals = buckets.map(b => {
            const bucket = b.list[i];
            const a = bucket ? agg(bucket.rows) : null;
            return {
                name: b.name, color: b.color, rank: b.rank,
                v: a ? valOf(a, key, 'total') : 0,
                active: a ? a.activeDays : 0,
                days: a ? a.days : 0
            };
        }).sort((x, y) => y.v - x.v);

        const total = vals.reduce((t, x) => t + x.v, 0);
        const leader = vals[0];

        return {
            title: label,
            meta: `${METRIC_LABEL[key] || key} · équipe : ${fmtInt(total)}${unit}`,
            sections: [{
                accent: 'a',
                head: `Classement sur ce ${granWord(gran)}`,
                rows: vals.map((x, k) => ({
                    color: x.color,
                    label: `${k + 1}. ${x.name}`,
                    sub: x.active === 0 ? 'aucune saisie' : (total > 0 ? `${fmtDec((x.v / total) * 100)} % de l'équipe` : null),
                    value: `${fmtInt(x.v)}${unit}`,
                    em: k === 0 && x.v > 0,
                    muted: x.v === 0
                }))
            }],
            deltas: leader && vals[1] && leader.v > 0
                ? [{ label: `Avance de ${leader.name}`,
                     html: `<span class="delta delta--up">▲ +${fmtInt(leader.v - vals[1].v)} sur ${escapeHtml(vals[1].name)}</span>` }]
                : [],
            foot: total === 0
                ? `Aucune saisie sur ce ${granWord(gran)}.`
                : `Moyenne par BDR ayant saisi : <b>${fmtDec(total / Math.max(1, vals.filter(x => x.active > 0).length))}${unit}</b>.`
        };
    };
}

const METRIC_LABEL = {
    productivity_score: 'Score de productivité',
    calls_made: 'Appels passés',
    calls_connected: 'Appels aboutis',
    meetings_booked: 'Rendez-vous obtenus',
    emails_sent: 'E-mails envoyés',
    meeting_rate: 'Taux de RDV'
};

/* --------------------------------------------------------------------------
   Graphiques
   -------------------------------------------------------------------------- */

const CHARTS = [
    {
        key: 'score', icon: '⭐', wide: true,
        title: 'Score de productivité par BDR',
        sub: () => `Une courbe par personne, ${granWord(effGran())} par ${granWord(effGran())}`,
        metric: 'productivity_score',
        note: () => `Chaque courbe est une personne, sa couleur est la même dans tous les graphiques
            et dans le classement. Une courbe qui s'interrompt signale des jours sans aucune saisie,
            jamais un zéro inventé.`,
        hover: () => `le classement complet de l'équipe sur le moment pointé, la part de chacun dans
            le total, l'avance du premier sur le second, et la moyenne par BDR ayant saisi.`,
        render: (host, shown) => drawLines(host, shown, 'productivity_score')
    },
    {
        key: 'calls', icon: '📞',
        title: 'Appels passés par BDR',
        sub: () => `Barres groupées par ${granWord(effGran())}`,
        metric: 'calls_made',
        note: () => `Le volume d'appels est le premier levier d'un BDR : c'est la seule métrique
            entièrement sous son contrôle. Les barres sont groupées par personne à l'intérieur de
            chaque ${granWord(effGran())}.`,
        hover: () => `tous les BDR sur le moment pointé, classés, avec la part de chacun.`,
        render: (host, shown) => drawBars(host, shown, 'calls_made')
    },
    {
        key: 'meetings', icon: '🤝',
        title: 'Rendez-vous obtenus par BDR',
        sub: () => `Le résultat qui compte, par ${granWord(effGran())}`,
        metric: 'meetings_booked',
        note: () => `Le rendez-vous vaut vingt points au score, c'est de loin l'action la plus lourde.
            Un BDR qui en obtient peu malgré beaucoup d'appels doit être regardé sur le taux de
            conversion plutôt que sur le volume.`,
        hover: () => `tous les BDR sur le moment pointé, classés, avec la part de chacun.`,
        render: (host, shown) => drawBars(host, shown, 'meetings_booked')
    },
    {
        key: 'rate', icon: '🎯', wide: true,
        title: 'Taux de rendez-vous par BDR',
        sub: () => 'Rendez-vous obtenus pour cent appels aboutis',
        metric: 'meeting_rate',
        note: () => `Le taux est recalculé depuis les volumes du ${granWord(effGran())}, jamais moyenné.
            Attention aux petits volumes : deux appels aboutis et un rendez-vous donnent 50 %, ce qui
            ne veut rien dire. L'info-bulle donne les volumes pour trancher.`,
        hover: () => `le taux de chaque BDR sur le moment pointé, avec les volumes d'appels aboutis et
            de rendez-vous qui ont servi à le calculer.`,
        render: (host, shown) => drawRates(host, shown)
    }
];

/** Les huit meilleurs : au-delà, les courbes deviennent illisibles. */
const shownPeople = () => people.slice(0, MAX_SERIES);

function bucketsOf(list) {
    const gran = effGran();
    return list.map(p => ({
        name: nameOf(p), color: p.color, rank: p.rank,
        list: bucketize(p.rows, gran)
    }));
}

function drawLines(host, shown, key) {
    const bk = bucketsOf(shown);
    if (!bk.length || !bk[0].list.length) return host.innerHTML = emptyStateHtml();
    lineChart(host, {
        labels: bk[0].list.map(b => b.label),
        series: bk.map(b => ({
            name: b.name, color: b.color,
            values: b.list.map(x => agg(x.rows).productivity_score)
        })),
        height: 320,
        tip: teamTip(bk, key)
    });
}

function drawBars(host, shown, key) {
    const bk = bucketsOf(shown);
    if (!bk.length || !bk[0].list.length) return host.innerHTML = emptyStateHtml();
    barChart(host, {
        labels: bk[0].list.map(b => b.label),
        series: bk.map(b => ({
            name: b.name, color: b.color,
            values: b.list.map(x => agg(x.rows)[key])
        })),
        height: 260,
        tip: teamTip(bk, key)
    });
}

function drawRates(host, shown) {
    const bk = bucketsOf(shown);
    if (!bk.length || !bk[0].list.length) return host.innerHTML = emptyStateHtml();
    const gran = effGran();

    lineChart(host, {
        labels: bk[0].list.map(b => b.label),
        series: bk.map(b => ({
            name: b.name, color: b.color,
            values: b.list.map(x => agg(x.rows).meeting_rate)
        })),
        height: 300,
        tip: i => {
            const first = bk[0].list[i];
            const label = gran === 'day' ? formatLong(first.key) : first.label;
            const vals = bk.map(b => {
                const a = agg(b.list[i] ? b.list[i].rows : []);
                return { name: b.name, color: b.color, rate: a.meeting_rate,
                         conn: a.calls_connected, meet: a.meetings_booked };
            }).sort((x, y) => (y.rate ?? -1) - (x.rate ?? -1));

            return {
                title: label,
                meta: 'Taux de rendez-vous, recalculé depuis les volumes',
                sections: [{
                    accent: 'a', head: `Classement sur ce ${granWord(gran)}`,
                    rows: vals.map((x, k) => ({
                        color: x.color,
                        label: `${k + 1}. ${x.name}`,
                        sub: `${fmtInt(x.meet)} RDV sur ${fmtInt(x.conn)} aboutis`,
                        value: x.rate == null ? '–' : `${fmtDec(x.rate)} %`,
                        em: k === 0 && x.rate != null,
                        muted: x.rate == null
                    }))
                }],
                foot: vals.some(x => x.conn > 0 && x.conn < 10)
                    ? 'Certains volumes sont <b>trop faibles</b> pour que le taux soit significatif.'
                    : 'Un taux ne se compare qu\'à volumes comparables.'
            };
        }
    });
}

function renderCharts() {
    const grid = document.getElementById('charts-grid');
    const shown = shownPeople();

    if (!shown.length) {
        grid.innerHTML = `<div class="chart-card">${emptyStateHtml('Aucun compte à afficher.')}</div>`;
        return;
    }

    grid.innerHTML = CHARTS.map(c => `
        <div class="chart-card${c.wide ? ' chart-card--wide' : ''}">
            <div class="chart-head">
                <div class="chart-icon">${c.icon}</div>
                <div class="chart-titles">
                    <h3 class="chart-title">${escapeHtml(c.title)}</h3>
                    <p class="chart-sub">${escapeHtml(c.sub())}</p>
                </div>
            </div>
            ${legendHtml(shown.map(p => ({ color: p.color, label: nameOf(p) })))}
            <div data-host="${c.key}"></div>
            <details class="chart-note"><summary>Comment lire ce graphique</summary>
                <p>${c.note()}</p>
                <p class="chart-note-hover"><b>Au survol :</b> ${c.hover()}</p>
            </details>
        </div>`).join('')
        + (people.length > MAX_SERIES
            ? `<p class="chart-hint">Seuls les ${MAX_SERIES} premiers du classement sont tracés,
               au-delà les courbes deviennent illisibles. Le classement ci-dessus reste complet.</p>`
            : '');

    CHARTS.forEach(c => {
        const host = grid.querySelector(`[data-host="${c.key}"]`);
        if (host) c.render(host, shown);
    });
}

/* --------------------------------------------------------------------------
   Duel de deux BDR
   -------------------------------------------------------------------------- */

function renderDuel() {
    const selA = document.getElementById('duel-a');
    const selB = document.getElementById('duel-b');
    const grid = document.getElementById('duel-grid');

    const opts = sel => people.map(p =>
        `<option value="${p.profile.user_id}"${p.profile.user_id === sel ? ' selected' : ''}>${
            escapeHtml(nameOf(p))}</option>`).join('');
    selA.innerHTML = opts(state.duelA);
    selB.innerHTML = opts(state.duelB);

    const A = personBy(state.duelA), B = personBy(state.duelB);
    if (!A || !B) {
        grid.innerHTML = `<div class="chart-card">${emptyStateHtml(
            'Il faut au moins deux comptes pour comparer.')}</div>`;
        return;
    }
    if (A === B) {
        grid.innerHTML = `<div class="chart-card">${emptyStateHtml(
            'Choisissez deux personnes différentes.')}</div>`;
        return;
    }

    const dec = state.mode === 'avg';
    const fV = v => (dec ? fmtDec(v) : fmtInt(v));

    grid.innerHTML = `
        <div class="chart-card chart-card--wide">
            <div class="chart-head">
                <div class="chart-icon">⚔️</div>
                <div class="chart-titles">
                    <h3 class="chart-title">${escapeHtml(nameOf(A))} contre ${escapeHtml(nameOf(B))}</h3>
                    <p class="chart-sub">Action par action, ${dec ? 'en moyenne par jour actif' : 'en cumul'}, sur ${pLabel()}</p>
                </div>
            </div>
            ${legendHtml([
                { periodStyle: 'a', color: A_MAIN, label: nameOf(A) },
                { periodStyle: 'b', color: B_MAIN, label: nameOf(B) }
            ])}
            <div data-host="duel-compare"></div>
        </div>
        <div class="chart-card chart-card--wide">
            <div class="chart-head">
                <div class="chart-icon">📈</div>
                <div class="chart-titles">
                    <h3 class="chart-title">Score dans le temps</h3>
                    <p class="chart-sub">Les deux trajectoires, ${granWord(effGran())} par ${granWord(effGran())}</p>
                </div>
            </div>
            ${legendHtml([
                { periodStyle: 'a', color: A_MAIN, label: nameOf(A) },
                { periodStyle: 'b', color: B_MAIN, label: nameOf(B) }
            ])}
            <div data-host="duel-time"></div>
        </div>`;

    // Comparaison action par action
    compareChart(grid.querySelector('[data-host="duel-compare"]'), {
        rows: METRICS.map(m => ({
            label: m.short, colorA: A_MAIN, colorB: B_MAIN,
            a: valOf(A.a, m.key, state.mode), b: valOf(B.a, m.key, state.mode)
        })),
        labelA: nameOf(A), labelB: nameOf(B),
        fmt: fV,
        tip: i => {
            const m = METRICS[i];
            const w = SCORE_WEIGHTS.find(x => x.key === m.key);
            const side = (p, color) => [
                { color, label: m.short, value: fV(valOf(p.a, m.key, state.mode)), em: true },
                { label: 'Cumul', value: fmtInt(p.a[m.key]), muted: true },
                { label: 'Par jour actif',
                  value: p.a.activeDays > 0 ? fmtDec(p.a[m.key] / p.a.activeDays) : '–', muted: true },
                { label: 'Jours saisis', sub: `sur ${p.a.days} j`, value: fmtInt(p.a.activeDays), muted: true },
                { label: 'Rang au score', value: `${p.rank}${p.rank === 1 ? 'er' : 'e'}`, muted: true }
            ];
            const va = valOf(A.a, m.key, state.mode), vb = valOf(B.a, m.key, state.mode);
            const diff = va - vb;
            const pct = vb !== 0 ? (diff / Math.abs(vb)) * 100 : null;
            const dir = diff > 0.0001 ? 'up' : diff < -0.0001 ? 'down' : 'flat';
            return {
                title: m.label,
                meta: dec ? 'Moyenne par jour actif' : `Cumul sur ${pLabel()}`,
                sections: [
                    { accent: 'a', badge: 'A', head: nameOf(A), rows: side(A, A_MAIN) },
                    { accent: 'b', badge: 'B', head: nameOf(B), rows: side(B, B_MAIN) }
                ],
                deltas: [{
                    label: 'Écart', html: `<span class="delta delta--${dir}">${
                        dir === 'up' ? '▲ +' : dir === 'down' ? '▼ −' : '= '}${
                        dec ? fmtDec(Math.abs(diff)) : fmtInt(Math.abs(diff))}${
                        pct === null ? '' : ` · ${pct > 0 ? '+' : '−'}${fmtDec(Math.abs(pct))} %`}</span>`
                }],
                foot: `${escapeHtml(m.hint)}${w ? ` · pèse <b>${w.w} point${w.w > 1 ? 's' : ''}</b> dans le score` : ''}`
            };
        }
    });

    // Trajectoires
    const gran = effGran();
    const bA = bucketize(A.rows, gran), bB = bucketize(B.rows, gran);
    lineChart(grid.querySelector('[data-host="duel-time"]'), {
        labels: bA.map(b => b.label),
        series: [
            { name: nameOf(A), color: A_MAIN, values: bA.map(b => agg(b.rows).productivity_score), area: true },
            { name: nameOf(B), color: B_MAIN, values: bB.map(b => agg(b.rows).productivity_score) }
        ],
        height: 300,
        tip: i => {
            const ga = agg(bA[i] ? bA[i].rows : []);
            const gb = agg(bB[i] ? bB[i].rows : []);
            const line = (g, color, p) => [
                { color, label: 'Score', value: `${fmtInt(g.productivity_score)} pts`, em: true },
                { label: 'Appels', value: fmtInt(g.calls_made), muted: true },
                { label: 'Aboutis', value: fmtInt(g.calls_connected), muted: true },
                { label: 'Rendez-vous', value: fmtInt(g.meetings_booked), muted: true },
                { label: 'E-mails', value: fmtInt(g.emails_sent), muted: true },
                { label: 'Jours saisis', value: fmtInt(g.activeDays), muted: true }
            ];
            const diff = ga.productivity_score - gb.productivity_score;
            return {
                title: gran === 'day' && bA[i] ? formatLong(bA[i].key) : (bA[i] ? bA[i].label : '—'),
                meta: `Écart de score : ${diff > 0 ? '+' : ''}${fmtInt(diff)} points`,
                sections: [
                    { accent: 'a', badge: 'A', head: nameOf(A), rows: line(ga, A_MAIN, A) },
                    { accent: 'b', badge: 'B', head: nameOf(B), rows: line(gb, B_MAIN, B) }
                ],
                deltas: [{
                    label: 'Score', html: `<span class="delta delta--${
                        diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'}">${
                        diff > 0 ? '▲ +' : diff < 0 ? '▼ −' : '= '}${fmtInt(Math.abs(diff))} pts</span>`
                }]
            };
        }
    });

    selA.onchange = () => { state.duelA = selA.value; renderDuel(); };
    selB.onchange = () => { state.duelB = selB.value; renderDuel(); };
}

/* --------------------------------------------------------------------------
   Synthèse et export
   -------------------------------------------------------------------------- */

function renderSummary() {
    const el = document.getElementById('control-summary');
    const gran = effGran();
    const team = agg(people.flatMap(p => p.rows));
    const withData = people.filter(p => p.a.activeDays > 0).length;
    const excluded = allProfiles.length - people.length;

    el.innerHTML = `<p class="summary-sentence">
        Sur <b>${periodLabel(state.from, state.to)}</b>, ${people.length} compte${people.length > 1 ? 's' : ''}
        suivi${people.length > 1 ? 's' : ''}, dont <b>${withData}</b> avec au moins une saisie.
        Un point de graphique représente <b>un ${granWord(gran)}</b>.
        Total de l'équipe : <b>${fmtInt(team.productivity_score)} points</b>.
        ${excluded > 0 ? `${excluded} compte${excluded > 1 ? 's' : ''} exclu${excluded > 1 ? 's' : ''} par les filtres.` : ''}
    </p>`;
}

function exportCsv() {
    const head = ['Rang', 'BDR', 'E-mail', 'Role', 'Demo', 'Actif', 'Jours saisis', 'Jours periode',
        ...METRICS.map(m => m.short), 'Taux aboutis %', 'Taux RDV %', 'Score'];
    const lines = people.map(p => [
        p.rank, nameOf(p), p.profile.email || '', p.profile.role,
        p.profile.is_demo ? 'oui' : 'non', p.profile.is_active ? 'oui' : 'non',
        p.a.activeDays, p.a.days,
        ...METRICS.map(m => p.a[m.key]),
        p.a.connect_rate == null ? '' : p.a.connect_rate.toFixed(1),
        p.a.meeting_rate == null ? '' : p.a.meeting_rate.toFixed(1),
        p.a.productivity_score
    ]);
    const csv = [head, ...lines]
        .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';'))
        .join('\n');

    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `equipe-${state.from}_${state.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

/* --------------------------------------------------------------------------
   Rendu et interactions
   -------------------------------------------------------------------------- */

async function refresh() {
    try {
        await load();
        renderSummary();
        renderKpis();
        renderRanking();
        renderCharts();
        renderDuel();
        syncControls();
    } catch (e) {
        toast(humanError(e), 'error');
    }
}

function syncControls() {
    document.getElementById('a-from').value = state.from;
    document.getElementById('a-to').value = state.to;
    document.getElementById('hint-a').textContent =
        `${periodLength(state.from, state.to)} jours · ${pLabel()}`;

    const seg = (id, attr, value) => document.querySelectorAll(`#${id} button`).forEach(b => {
        b.classList.toggle('is-on', b.dataset[attr] === String(value));
        b.setAttribute('aria-pressed', b.dataset[attr] === String(value) ? 'true' : 'false');
    });
    seg('seg-gran', 'gran', state.gran);
    seg('seg-mode', 'mode', state.mode);
    seg('seg-demo', 'demo', state.demo ? '1' : '0');
    seg('seg-inactive', 'inactive', state.inactive ? '1' : '0');

    document.getElementById('explain-gran').textContent = state.gran === 'auto'
        ? `Choisi automatiquement : un ${granWord(effGran())} par point.`
        : `Chaque point du graphique regroupe un ${granWord(effGran())}.`;
    document.getElementById('explain-mode').textContent = state.mode === 'total'
        ? 'Le classement additionne tout sur la période.'
        : 'Le classement divise par le nombre de jours réellement saisis, ce qui ne pénalise pas une absence.';
    document.getElementById('explain-demo').textContent = state.demo
        ? 'Les comptes de démonstration comptent dans les classements.'
        : 'Les comptes de démonstration sont ignorés partout.';
}

const PRESETS = [
    { id: '7', label: '7 derniers jours', make: () => ({ from: addDaysISO(T, -6), to: T }) },
    { id: '30', label: '30 derniers jours', make: () => ({ from: addDaysISO(T, -29), to: T }) },
    { id: 'week', label: 'Cette semaine', make: () => ({ from: startOfWeek(T), to: endOfWeek(T) }) },
    { id: 'month', label: 'Ce mois', make: () => ({ from: startOfMonth(T), to: endOfMonth(T) }) },
    { id: 'quarter', label: 'Ce trimestre', make: () => ({ from: startOfQuarter(T), to: endOfQuarter(T) }) }
];

function wire() {
    const row = document.getElementById('preset-row');
    PRESETS.forEach(p => {
        const b = document.createElement('button');
        b.className = 'chip';
        b.type = 'button';
        b.textContent = p.label;
        b.addEventListener('click', () => {
            Object.assign(state, p.make());
            refresh();
        });
        row.appendChild(b);
    });

    document.getElementById('a-from').addEventListener('change', e => {
        state.from = e.target.value; refresh();
    });
    document.getElementById('a-to').addEventListener('change', e => {
        state.to = e.target.value; refresh();
    });

    document.querySelectorAll('#seg-gran button').forEach(b =>
        b.addEventListener('click', () => { state.gran = b.dataset.gran; refresh(); }));
    document.querySelectorAll('#seg-mode button').forEach(b =>
        b.addEventListener('click', () => { state.mode = b.dataset.mode; refresh(); }));
    document.querySelectorAll('#seg-demo button').forEach(b =>
        b.addEventListener('click', () => { state.demo = b.dataset.demo === '1'; refresh(); }));
    document.querySelectorAll('#seg-inactive button').forEach(b =>
        b.addEventListener('click', () => { state.inactive = b.dataset.inactive === '1'; refresh(); }));

    document.getElementById('btn-export').addEventListener('click', exportCsv);

    // Raccourcis de la zone A
    document.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => {
        const k = b.dataset.a;
        if (k === '7') Object.assign(state, { from: addDaysISO(T, -6), to: T });
        else if (k === '30') Object.assign(state, { from: addDaysISO(T, -29), to: T });
        else if (k === 'week') Object.assign(state, { from: startOfWeek(T), to: endOfWeek(T) });
        else if (k === 'month') Object.assign(state, { from: startOfMonth(T), to: endOfMonth(T) });
        else if (k === 'quarter') Object.assign(state, { from: startOfQuarter(T), to: endOfQuarter(T) });
        refresh();
    }));
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

(async function main() {
    try {
        const session = await requireAuth();
        renderNav(session);

        // Garde-fou côté écran. La vraie barrière est la RLS : sans le rôle
        // admin, la base ne renverrait de toute façon que ses propres lignes.
        if (!isAdmin()) {
            document.querySelector('.page-main').innerHTML = `
                <div class="page-container"><div class="chart-card">
                    <h3 class="chart-title">Page réservée aux administrateurs</h3>
                    <p class="chart-sub">Votre compte n'a pas accès à la vue d'équipe.
                       Retournez à <a href="./dashboard.html">vos performances</a>.</p>
                </div></div>`;
            hideVeil();
            return;
        }

        allProfiles = await listProfiles();
        wire();
        await refresh();
        hideVeil();
    } catch (e) {
        if (String(e.message || e).includes('Non authentifié')) return;
        toast(humanError(e), 'error');
        hideVeil();
    }
})();
