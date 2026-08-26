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
    requireAuth, isAdmin, canReadAll, myProfile, linkFor, listProfiles,
    fetchTeamRange, todayISO, addDaysISO, diffDays, minISO, maxISO,
    formatLong, formatShort, periodLength,
    startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfQuarter, endOfQuarter,
    periodLabel, periodLabelShort, humanError, METRICS, SCORE_WEIGHTS,
    isContributor, metricsForAny, jobLabel, jobsOf,
    loadScoreWeights, scoreWeightsMeta
} from './api.js';
import {
    num, score, isActive, agg, valOf, bucketize, autoGran, granWord, rowsForRange
} from './analytics.js';
import { renderNav } from './nav.js';
import {
    escapeHtml, fmtInt, fmtDec, toast, hideVeil,
    lineChart, barChart, compareChart, legendHtml, onResize
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
    duelB: null,
    // Personnes retirées du calcul à la main. Volontairement en mémoire et non
    // dans le navigateur : un filtre qui survit à la fermeture de l'onglet finit
    // par être oublié, et l'on compare alors une équipe à sept avec une équipe à
    // huit sans le savoir. Ici, chaque ouverture de page repart de tout le monde.
    excluded: new Set()
};

/**
 * Les populations du classement.
 *
 * Un score de BDR et un score de commercial ne se composent pas des mêmes
 * actions : les mettre dans un même classement produirait un dernier de la
 * classe fabriqué par la différence de métier, pas par la différence d'effort.
 * Chaque groupe est donc classé chez lui. Les compteurs, eux, restent affichés
 * côte à côte : un appel est un appel dans les deux métiers, et c'est la seule
 * comparaison transverse qui tienne.
 *
 * Quatre groupes et non deux : quelqu'un qui porte les deux métiers n'est
 * comparable ni à l'un ni à l'autre, et le dupliquer dans deux classements
 * ferait deux fois la même personne dans le même tableau. Il a donc son
 * groupe. Le groupe « sans métier » n'existe en principe pas, isContributor
 * l'écarte en amont ; il reste comme filet, pour qu'une ligne ne disparaisse
 * jamais du tableau sans un mot.
 */
const JOB_GROUPS = [
    { key: 'bdr',   label: 'BDR',                 match: p => !!p.is_bdr && !p.is_sales },
    { key: 'sales', label: 'Commerciaux',         match: p => !!p.is_sales && !p.is_bdr },
    { key: 'both',  label: 'BDR et commercial',   match: p => !!p.is_bdr && !!p.is_sales },
    { key: 'none',  label: 'Sans métier déclaré', match: p => !p.is_bdr && !p.is_sales }
];

const groupOf = pr => (JOB_GROUPS.find(g => g.match(pr)) || JOB_GROUPS[3]).key;

let people = [];      // [{ profile, byDate, rows, a }] trié par score décroissant
let allProfiles = [];
let eligible = [];    // profils que les deux filtres laissent passer, avant décochage

// Les lignes déjà chargées, avec la fenêtre de dates qu'elles couvrent.
// Décocher une personne, changer de granularité ou revenir sur une période déjà
// vue sont des calculs locaux : refaire la requête à chaque clic serait payer le
// réseau pour une information qu'on a déjà sous la main.
//
// La fenêtre ne fait que grandir tant que les deux filtres de comptes ne
// changent pas, parce qu'une carte peut désormais porter ses propres dates et
// sortir de la période globale. Elle repart de zéro dès qu'un filtre change,
// sans quoi on garderait des lignes que le filtre vient d'exclure.
let cache = { from: null, to: null, filters: '', rows: [] };

// Chiffres et rang de chacun sur une période donnée, calculés à la demande et
// gardés le temps d'un rendu. Six cartes qui regardent la même période ne
// doivent pas refaire six fois le même agrégat.
let statsCache = new Map();

const effGran = () => (state.gran === 'auto' ? autoGran(state.from, state.to) : state.gran);
const pLabel = () => periodLabelShort(state.from, state.to);

/* Bornes inversées, date dans le futur : on répare au lieu de dessiner un
   graphique vide. Même règle que sur la page Performances. */
function normalizeRange(p) {
    if (diffDays(p.to, p.from) < 0) { const s = p.from; p.from = p.to; p.to = s; }
    if (diffDays(T, p.to) < 0) p.to = T;
    if (diffDays(T, p.from) < 0) p.from = T;
    return p;
}

/* --------------------------------------------------------------------------
   Dates propres à une carte

   Deux niveaux de dates cohabitent maintenant : la période globale du panneau
   de pilotage, et les dates qu'une carte peut se donner à elle seule. C'est
   l'ergonomie de la page Performances, reprise telle quelle : même bouton 📅,
   même panneau sous l'en-tête, même retour à la période globale, et le même
   état partagé entre la carte et sa vue agrandie.

   Ce qu'une carte à dates propres ne change pas : le classement, les
   indicateurs de tête et l'export restent sur la période globale. Les faire
   suivre reviendrait à afficher un tableau dont plus personne ne saurait dire
   sur quoi il porte.
   -------------------------------------------------------------------------- */

const scopes = new Map();     // clé de carte → { from, to }
const datesOpen = new Set();  // cartes dont le panneau de dates est déplié

/** La fenêtre de dates qu'il faut avoir chargée pour pouvoir tout dessiner. */
function neededWindow() {
    let from = state.from, to = state.to;
    scopes.forEach(s => { from = minISO(from, s.from); to = maxISO(to, s.to); });
    return { from, to };
}

/** Les deux boutons de l'en-tête, identiques sur les six cartes. */
const toolsHtml = key => `
    <div class="chart-tools">
        <button class="icon-btn" type="button" data-dates="${key}"
                title="Dates propres à ce graphique" aria-label="Dates de ce graphique">📅</button>
        <button class="icon-btn" type="button" data-zoom="${key}"
                title="Agrandir" aria-label="Agrandir ce graphique">⛶</button>
    </div>`;

/* Le panneau de dates d'une carte. Il reste déplié tant qu'on ne l'a pas
   refermé, et il est toujours déplié quand la carte porte ses propres dates :
   une carte qui ne suit plus la période globale doit le dire sans qu'on ait à
   cliquer pour le découvrir. */
const datesBarHtml = ctx => `
    <div class="chart-dates" data-panel="${ctx.key}"${
        datesOpen.has(ctx.key) || ctx.scoped ? '' : ' hidden'}>
        <span class="date-bar-label">Dates de ce graphique</span>
        <div class="date-range">
            <input type="date" data-scope-from="${ctx.key}" value="${ctx.from}" max="${T}">
            <span>→</span>
            <input type="date" data-scope-to="${ctx.key}" value="${ctx.to}" max="${T}">
        </div>
        <button class="chip chip--sm" type="button" data-scope-reset="${ctx.key}">↺ Période globale</button>
        <span class="pill ${ctx.scoped ? 'pill--warn' : 'pill--info'}">${scopePill(ctx)}</span>
    </div>`;

const scopePill = ctx => (ctx.scoped
    ? `dates propres · ${periodLength(ctx.from, ctx.to)} jours · un point = un ${granWord(ctx.gran)}`
    : 'suit la période globale');

/* --------------------------------------------------------------------------
   Chargement
   -------------------------------------------------------------------------- */

async function load() {
    // Une même requête sert tous les réglages qui ne changent ni la fenêtre de
    // dates ni les deux filtres de comptes : granularité, mode de lecture, et
    // surtout le décochage d'une personne, qui se calcule ici sans rien
    // redemander. Élargir une carte au-delà de ce qui est chargé, en revanche,
    // demande bien un aller-retour : les jours manquants n'existent nulle part.
    const filters = [state.demo, state.inactive].join('|');
    const want = neededWindow();
    const same = cache.filters === filters && !!cache.from;
    const covered = same
        && diffDays(want.from, cache.from) >= 0
        && diffDays(cache.to, want.to) >= 0;

    if (!covered) {
        // On charge l'union de ce qui est déjà là et de ce qu'on demande :
        // revenir sur une période déjà vue ne doit pas la recharger.
        const from = same ? minISO(cache.from, want.from) : want.from;
        const to = same ? maxISO(cache.to, want.to) : want.to;
        cache = {
            from, to, filters,
            rows: await fetchTeamRange(from, to, {
                includeDemo: state.demo, includeInactive: state.inactive
            })
        };
    }
    const rows = cache.rows;

    // Regroupement par personne. Les profils sans aucune ligne sur la période
    // sont conservés avec un score nul : un BDR qui n'a rien saisi est une
    // information, le faire disparaître du classement serait trompeur.
    const map = new Map();
    // Seuls ceux qui saisissent entrent dans un classement : un administrateur
    // pur ne saisit rien, l'y faire figurer avec un score de zéro n'a aucun sens.
    // isContributor et non is_bdr, sans quoi les commerciaux seraient absents.
    allProfiles
        .filter(p => isContributor(p)
            && (state.demo || !p.is_demo)
            && (state.inactive || p.is_active))
        .forEach(p => map.set(p.user_id, { profile: p, byDate: new Map() }));

    // Un compte que listProfiles ne renvoie pas n'entre dans la liste que s'il a
    // saisi sur la période globale. Sans cette borne, élargir les dates d'une
    // seule carte ferait apparaître des noms dans « Qui est compté » puis les
    // ferait disparaître, alors que le périmètre n'a pas bougé.
    rows.forEach(r => {
        if (map.has(r.user_id)) return;
        if (diffDays(r.activity_date, state.from) < 0) return;
        if (diffDays(state.to, r.activity_date) < 0) return;
        map.set(r.user_id, {
            profile: {
                user_id: r.user_id, display_name: r.display_name, email: r.email,
                is_admin: r.is_admin, is_bdr: r.is_bdr, is_sales: r.is_sales,
                is_demo: r.is_demo, is_active: r.is_active
            },
            byDate: new Map()
        });
    });

    // Toutes les lignes de la fenêtre chargée, y compris hors période globale :
    // c'est là que les dates propres d'une carte trouvent leurs chiffres.
    rows.forEach(r => {
        const v = map.get(r.user_id);
        if (v) v.byDate.set(r.activity_date, r);
    });

    // Qui a le droit d'apparaître dans la liste à cocher : tout ce que les deux
    // filtres laissent passer, avant le décochage. Si l'on construisait cette
    // liste après, décocher quelqu'un le ferait disparaître de la liste et il
    // deviendrait impossible de le remettre.
    eligible = [...map.values()].map(v => v.profile)
        .sort((a, b) => nameOfProfile(a).localeCompare(nameOfProfile(b), 'fr'));

    people = [...map.values()]
        .filter(v => !state.excluded.has(v.profile.user_id))
        .map(p => {
            const list = rowsForRange(p.byDate, state.from, state.to);
            return { ...p, rows: list, a: agg(list) };
        }).sort((x, y) => y.a.productivity_score - x.a.productivity_score);

    people.forEach((p, i) => {
        p.rank = i + 1;
        p.color = BDR_COLORS[i % BDR_COLORS.length];
        p.group = groupOf(p.profile);
    });

    /* Le rang de métier, à côté du rang global et non à sa place. Le rang global
       continue de décider des couleurs et des huit séries montrées dans les
       graphiques : le changer ferait sauter une couleur d'une personne à l'autre
       au premier commercial coché, et une couleur doit désigner toujours la même
       personne d'un écran à l'autre. Le classement, lui, affiche le rang de
       métier, qui est le seul comparable. `people` étant déjà trié par score
       décroissant, un simple compteur par groupe suffit. */
    const seen = new Map();
    people.forEach(p => {
        const n = (seen.get(p.group) || 0) + 1;
        seen.set(p.group, n);
        p.jobRank = n;
    });
    people.forEach(p => { p.groupSize = seen.get(p.group) || 1; });

    // Une personne décochée ne peut pas rester en lice dans la comparaison :
    // sans cela le duel afficherait encore des chiffres qui ne comptent plus.
    const present = id => people.some(x => x.profile.user_id === id);
    if (state.duelA && !present(state.duelA)) state.duelA = null;
    if (state.duelB && !present(state.duelB)) state.duelB = null;

    if (!state.duelA && people[0]) state.duelA = people[0].profile.user_id;
    if (!state.duelB && people[1]) state.duelB = people[1].profile.user_id;

    // Les agrégats par période sont refaits à chaque chargement : garder ceux du
    // rendu précédent afficherait les chiffres d'avant le changement.
    statsCache = new Map();
}

const nameOfProfile = pr => pr.display_name || pr.email || 'Sans nom';
const nameOf = p => nameOfProfile(p.profile);
const personBy = id => people.find(p => p.profile.user_id === id) || null;

/** Chiffres et rang de chacun sur une période, tout le monde compté ensemble.
    Le rang est recalculé sur cette période : afficher le rang du classement
    global à côté de chiffres qui portent sur trois mois de plus serait un
    contresens, et c'est exactement ce que permettent les dates par carte. */
function statsFor(from, to) {
    const k = `${from}|${to}`;
    if (!statsCache.has(k)) {
        const list = people
            .map(p => ({ id: p.profile.user_id, a: agg(rowsForRange(p.byDate, from, to)) }))
            .sort((x, y) => y.a.productivity_score - x.a.productivity_score);
        statsCache.set(k, new Map(list.map((x, i) => [x.id, { a: x.a, rank: i + 1 }])));
    }
    return statsCache.get(k);
}

/** Tout ce dont un dessin a besoin : ses dates, sa granularité, sa taille. */
function ctxFor(key, { big = false } = {}) {
    const s = scopes.get(key) || null;
    const from = s ? s.from : state.from;
    const to = s ? s.to : state.to;
    return {
        key, from, to, big, scoped: !!s,
        // Une carte à dates propres choisit sa granularité d'après sa propre
        // longueur. Garder « un jour » sur une carte passée à un an donnerait
        // 365 points illisibles, et le réglage global a été choisi pour la
        // période globale, pas pour celle-là.
        gran: s ? autoGran(from, to) : effGran()
    };
}

/* Le sous-titre dit la période dès qu'elle n'est plus celle du panneau de
   pilotage. En vue agrandie, c'est le seul endroit qui la nomme en clair. */
const subOf = (c, ctx) => c.sub(ctx)
    + (ctx.scoped ? ` · ${periodLabelShort(ctx.from, ctx.to)}` : '');

/* --------------------------------------------------------------------------
   Indicateurs de tête
   -------------------------------------------------------------------------- */

function renderKpis() {
    const host = document.getElementById('kpi-grid');
    const team = agg(people.flatMap(p => p.rows));
    const activePeople = people.filter(p => p.a.activeDays > 0);
    const best = people[0];

    /* Compter les métiers présents, pour ne montrer une tuile de cycle de vente
       qu'à une équipe qui en a une. Une tuile à zéro n'informe pas, elle
       encombre. */
    const hasJob = j => people.some(p => jobsOf(p.profile).includes(j));
    const anySales = hasJob('sales');
    const anyBdr = hasJob('bdr');

    /* Le total d'équipe additionne des scores de deux métiers. C'est assumé,
       mais il faut le dire : c'est une masse de travail déclarée, pas un
       classement. Le sous-titre porte donc la composition. */
    const mix = anyBdr && anySales
        ? `${people.filter(p => jobsOf(p.profile).includes('bdr')).length} BDR et ${
             people.filter(p => jobsOf(p.profile).includes('sales')).length} commerciaux`
        : `${people.length} personne${people.length > 1 ? 's' : ''}`;

    const tiles = [
        {
            hero: true, label: 'Score total de l\'équipe',
            value: fmtInt(team.productivity_score),
            sub: `${activePeople.length} ayant saisi sur ${mix} · ${pLabel()}`
        },
        { label: 'Appels passés', value: fmtInt(team.calls_made),
          sub: `${fmtInt(team.calls_connected)} aboutis · ${team.connect_rate == null ? '–' : fmtDec(team.connect_rate) + ' %'}` },
        // Les deux rendez-vous ne sont jamais additionnés : le RDV obtenu est
        // décroché par un BDR, le RDV1 est tenu par un commercial. La même
        // rencontre peut porter les deux, une somme la compterait deux fois.
        anySales && !anyBdr
            ? { label: 'RDV1 tenus', value: fmtInt(team.first_meetings),
                sub: `${fmtInt(team.proposals_sent)} proposition(s) envoyée(s)` }
            : { label: 'Rendez-vous obtenus', value: fmtInt(team.meetings_booked),
                sub: team.calls_per_meeting == null ? 'aucun RDV' : `${fmtDec(team.calls_per_meeting)} appels par RDV` },
        anySales
            ? { label: 'Cycle de vente', value: fmtInt(team.first_meetings + team.proposals_sent),
                sub: `${fmtInt(team.first_meetings)} RDV1 · ${fmtInt(team.proposals_sent)} propositions · ${
                    fmtInt(team.no_go + team.deals_dropped + team.deals_lost)} sortie(s)` }
            : { label: 'E-mails envoyés', value: fmtInt(team.emails_sent),
                sub: `${fmtInt(team.crm)} fiches CRM créées` },
        { label: 'Meilleur score', value: best ? fmtInt(best.a.productivity_score) : '–',
          sub: best ? `${nameOf(best)}${jobLabel(best.profile) ? ' · ' + jobLabel(best.profile) : ''}` : 'aucune donnée' },
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

/**
 * Les colonnes de compteurs affichées : l'union des métiers présents.
 *
 * Piloté par metricsForAny et non écrit en dur, pour deux raisons. D'abord une
 * équipe sans commercial retrouve exactement les colonnes d'avant, sans qu'on
 * ait à maintenir deux listes. Ensuite l'ordre est celui de METRICS, donc celui
 * de la page de saisie et celui de l'export CSV : trois écrans qui nomment les
 * mêmes chiffres dans le même ordre sont trois écrans qu'on peut lire ensemble.
 */
const rankMetrics = () => metricsForAny(people.map(p => p.profile));

/** Colonnes de taux : un taux sans son compteur au tableau n'a pas de sens. */
function rankRates(ms) {
    const has = k => ms.some(m => m.key === k);
    const out = [];
    if (has('calls_made')) out.push({ th: 'Abouti %', get: a => a.connect_rate });
    if (has('meetings_booked')) out.push({ th: 'RDV %', get: a => a.meeting_rate });
    return out;
}

/** Nombre total de colonnes, pour les messages qui occupent toute la largeur. */
const rankSpan = (ms, rates) => 2 + ms.length + rates.length + 3;

function renderRanking() {
    const head = document.getElementById('ranking-head');
    const body = document.getElementById('ranking-body');
    if (!body) return;

    const ms = rankMetrics();
    const rates = rankRates(ms);
    const span = rankSpan(ms, rates);

    if (head) {
        head.innerHTML = `<tr>
            <th>#</th><th>Personne</th>
            ${ms.map(m => `<th>${escapeHtml(m.short || m.label)}</th>`).join('')}
            ${rates.map(r => `<th>${escapeHtml(r.th)}</th>`).join('')}
            <th>Jours</th><th>Score</th><th></th>
        </tr>`;
    }

    if (!people.length) {
        // Trois causes possibles, trois phrases : il n'y a personne, tout le
        // monde est masqué par un filtre, ou tout le monde a été décoché à la
        // main. Les deux dernières se réparent en un clic, encore faut-il dire
        // laquelle s'applique.
        const byHand = eligible.filter(pr => state.excluded.has(pr.user_id)).length;
        const hidden = allProfiles.length;
        body.innerHTML = byHand > 0
            ? `<tr><td colspan="${span}" class="td-muted">Aucun compte visible : les
               ${byHand} personne${byHand > 1 ? 's' : ''} de la période
               ${byHand > 1 ? 'ont' : 'a'} été décochée${byHand > 1 ? 's' : ''}
               dans « Qui est compté ».</td></tr>`
            : hidden > 0
            ? `<tr><td colspan="${span}" class="td-muted">Aucun compte visible : les
               ${hidden} compte${hidden > 1 ? 's' : ''} de la période
               ${hidden > 1 ? 'sont' : 'est'} écarté${hidden > 1 ? 's' : ''} par
               les filtres « Qui est compté ».</td></tr>`
            : `<tr><td colspan="${span}" class="td-muted">Aucun compte à afficher sur cette période.</td></tr>`;
        return;
    }

    const dec = state.mode === 'avg';
    const f = v => (dec ? fmtDec(v) : fmtInt(v));
    const me = myProfile();

    /* Une cellule vide n'est pas un zéro. Si la métrique ne relève pas du métier
       de la personne ET qu'elle n'a rien saisi dessus, on écrit un tiret : un
       « 0 appels » en face d'un commercial se lirait comme une contre-performance
       alors que la question ne lui est pas posée.

       La seconde condition n'est pas un luxe. Le métier est une propriété du
       compte, pas de la journée : quelqu'un passé de BDR à commercial garde un
       historique de prospection, et le masquer effacerait de vraies journées de
       l'écran. Dès qu'il y a un chiffre, on le montre. */
    const cellOf = (p, m) => {
        const mine = m.jobs.some(j => jobsOf(p.profile).includes(j));
        const raw = Number(p.a[m.key]) || 0;
        if (!mine && raw === 0) return '<span class="td-muted">—</span>';
        return f(valOf(p.a, m.key, state.mode));
    };

    const rowOf = p => {
        const a = p.a;
        const isMe = me && p.profile.user_id === me.user_id;   // vrai seulement pour un manager qui prospecte aussi
        // La médaille porte sur le classement du métier, pas sur un classement
        // mêlé : premier des commerciaux est un fait, premier de tout le monde
        // confondu n'en est pas un.
        const medal = p.jobRank === 1 ? '🥇' : p.jobRank === 2 ? '🥈' : p.jobRank === 3 ? '🥉' : p.jobRank;
        return `
        <tr${isMe ? ' class="row-me"' : ''}>
            <td data-th="Rang" class="rank-cell">${medal}</td>
            <td data-th="Personne" class="td-day">
                <span class="bdr-chip">
                    <span class="bdr-dot" style="background:${p.color}"></span>
                    <a class="bdr-name" href="${linkFor('./dashboard.html', p.profile.user_id)}"
                       title="Voir la fiche de ${escapeHtml(nameOf(p))}, telle qu'elle la voit">${escapeHtml(nameOf(p))}</a>
                    ${p.profile.is_demo ? '<b class="tag tag--demo">démo</b>' : ''}
                    ${p.profile.is_active ? '' : '<b class="tag">inactif</b>'}
                    ${p.profile.is_admin ? '<b class="tag tag--admin">admin</b>' : ''}
                </span>
            </td>
            ${ms.map(m => `<td data-th="${escapeHtml(m.short || m.label)}">${cellOf(p, m)}</td>`).join('')}
            ${rates.map(r => {
                const v = r.get(a);
                return `<td data-th="${escapeHtml(r.th)}">${v == null ? '–' : fmtDec(v) + ' %'}</td>`;
            }).join('')}
            <td data-th="Jours saisis" class="td-muted">${fmtInt(a.activeDays)} / ${fmtInt(a.days)}</td>
            <td data-th="Score" class="td-score"><b>${f(valOf(a, 'productivity_score', state.mode))}</b></td>
            <td data-th="" class="td-action"><a class="chip chip--sm" href="${linkFor('./dashboard.html', p.profile.user_id)}"
                   title="Voir la fiche de ${escapeHtml(nameOf(p))}">ouvrir →</a></td>
        </tr>`;
    };

    /* Un seul métier présent : aucun titre de groupe, le tableau est celui
       d'avant. Deux ou plus : un intertitre par métier, pour qu'on ne lise
       jamais deux scores incomparables comme s'ils se suivaient. */
    const groups = JOB_GROUPS
        .map(g => ({ g, list: people.filter(p => p.group === g.key) }))
        .filter(x => x.list.length);

    if (groups.length <= 1) {
        body.innerHTML = people.map(rowOf).join('');
        return;
    }

    body.innerHTML = groups.map(({ g, list }) => `
        <tr>
            <td colspan="${span}" class="td-muted">
                <b>${escapeHtml(g.label)}</b> · ${fmtInt(list.length)} personne${list.length > 1 ? 's' : ''},
                ${list.length > 1
                    ? 'classées entre elles sur le score'
                    : 'seule de son métier sur la période, donc sans rang comparable'}
            </td>
        </tr>
        ${list.map(rowOf).join('')}`).join('');
}

/* --------------------------------------------------------------------------
   Info-bulle d'équipe

   Même principe que sur la page Performances : on survole un moment, et l'on
   obtient tout le monde sur ce moment, classé, avec la part de chacun dans le
   total de l'équipe. C'est ce qui évite de survoler six séries l'une après
   l'autre pour reconstituer un classement de tête.
   -------------------------------------------------------------------------- */

function teamTip(buckets, key, gran, unit = '') {
    return i => {
        const bk = buckets[0].list[i];
        const label = bk
            ? (gran === 'day' ? formatLong(bk.key) : `${bk.label} · ${periodLabelShort(
                bk.rows[0].activity_date, bk.rows[bk.rows.length - 1].activity_date)}`)
            : '—';

        const vals = buckets.map(b => {
            const bucket = b.list[i];
            const a = bucket ? agg(bucket.rows) : null;
            return {
                name: b.name, color: b.color,
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
                : `Moyenne par personne ayant saisi : <b>${fmtDec(total / Math.max(1, vals.filter(x => x.active > 0).length))}${unit}</b>.`
        };
    };
}

/**
 * Le poids d'une action, dit en français et lu dans le barème enregistré.
 *
 * Écrire « vaut vingt points » dans un commentaire d'écran était une bombe à
 * retardement : le barème est réglable depuis l'écran Barème, et la phrase est
 * devenue fausse au premier changement. On la lit désormais à la source.
 */
function weightWord(key) {
    // Muet si le barème n'a pas pu être chargé : SCORE_WEIGHTS porterait alors
    // les valeurs par défaut du fichier, et annoncer un poids qui n'est pas
    // celui appliqué serait pire que de ne rien dire.
    if (!scoreWeightsMeta().loaded) return '';
    const w = SCORE_WEIGHTS.find(x => x.key === key);
    if (!w) return '';
    const v = Number(w.w);
    if (!Number.isFinite(v)) return '';
    return `Le barème en cours lui accorde ${fmtInt(v)} point${Math.abs(v) === 1 ? '' : 's'}.`;
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

   Chaque carte reçoit un contexte : ses dates, sa granularité, et si elle est
   dessinée en grand. Rien ici ne lit plus l'état global directement, sans quoi
   une carte à dates propres afficherait la période globale sous un autre titre.
   -------------------------------------------------------------------------- */

const CHARTS = [
    {
        key: 'score', icon: '⭐', wide: true,
        title: 'Score de productivité par personne',
        sub: ctx => `Une courbe par personne, ${granWord(ctx.gran)} par ${granWord(ctx.gran)}`,
        metric: 'productivity_score',
        note: () => `Chaque courbe est une personne, sa couleur est la même dans tous les graphiques
            et dans le classement. Une courbe qui s'interrompt signale des jours sans aucune saisie,
            jamais un zéro inventé. Attention si l'équipe mêle les deux métiers : le score d'un BDR
            et celui d'un commercial ne comptent pas les mêmes actions, deux courbes de métiers
            différents se lisent chacune dans le temps, pas l'une contre l'autre. Le classement, lui,
            sépare les métiers.`,
        hover: () => `le classement complet de l'équipe sur le moment pointé, la part de chacun dans
            le total, l'avance du premier sur le second, et la moyenne par personne ayant saisi.`,
        render: (host, shown, ctx) => drawLines(host, shown, 'productivity_score', ctx)
    },
    {
        key: 'calls', icon: '📞',
        title: 'Appels passés par personne',
        sub: ctx => `Barres groupées par ${granWord(ctx.gran)}`,
        metric: 'calls_made',
        note: ctx => `Le volume d'appels est le premier levier d'un BDR : c'est la seule métrique
            entièrement sous son contrôle. Les barres sont groupées par personne à l'intérieur de
            chaque ${granWord(ctx.gran)}. C'est un compteur commun aux deux métiers, donc l'un des
            rares qui se compare directement entre un BDR et un commercial. Attendez-vous quand même
            à un écart d'ordre de grandeur : le téléphone est le métier du premier, pas du second.`,
        hover: () => `tout le monde sur le moment pointé, classé, avec la part de chacun.`,
        render: (host, shown, ctx) => drawBars(host, shown, 'calls_made', ctx)
    },
    {
        key: 'meetings', icon: '🤝',
        title: 'Rendez-vous obtenus',
        sub: ctx => `Le résultat qui compte, par ${granWord(ctx.gran)}`,
        metric: 'meetings_booked',
        note: () => `${weightWord('meetings_booked')} C'est de loin l'action la plus lourde du barème.
            Un BDR qui en obtient peu malgré beaucoup d'appels doit être regardé sur le taux de
            conversion plutôt que sur le volume. Ce compteur est celui du rendez-vous <b>décroché</b>
            par la prospection : le premier rendez-vous <b>tenu</b> par un commercial est le RDV1,
            un autre compteur. Une courbe plate à zéro ici pour un commercial est donc normale, pas
            un mauvais résultat.`,
        hover: () => `tout le monde sur le moment pointé, classé, avec la part de chacun.`,
        render: (host, shown, ctx) => drawBars(host, shown, 'meetings_booked', ctx)
    },
    {
        key: 'rate', icon: '🎯', wide: true,
        title: 'Taux de rendez-vous',
        sub: () => 'Rendez-vous obtenus pour cent appels aboutis',
        metric: 'meeting_rate',
        note: ctx => `Le taux est recalculé depuis les volumes du ${granWord(ctx.gran)}, jamais moyenné.
            Attention aux petits volumes : deux appels aboutis et un rendez-vous donnent 50 %, ce qui
            ne veut rien dire. L'info-bulle donne les volumes pour trancher.`,
        hover: () => `le taux de chacun sur le moment pointé, avec les volumes d'appels aboutis et
            de rendez-vous qui ont servi à le calculer.`,
        render: (host, shown, ctx) => drawRates(host, shown, ctx)
    }
];

/** Les huit meilleurs du classement de la période globale : au-delà, les
    courbes deviennent illisibles. Ce sont les mêmes personnes sur les six
    cartes, y compris celles qui portent leurs propres dates, pour qu'une
    couleur désigne toujours la même personne d'un graphique à l'autre. */
const shownPeople = () => people.slice(0, MAX_SERIES);

const legendOf = shown => shown.map(p => ({ color: p.color, label: nameOf(p) }));

function bucketsOf(list, ctx) {
    return list.map(p => ({
        name: nameOf(p), color: p.color,
        list: bucketize(rowsForRange(p.byDate, ctx.from, ctx.to), ctx.gran)
    }));
}

function drawLines(host, shown, key, ctx) {
    const bk = bucketsOf(shown, ctx);
    if (!bk.length || !bk[0].list.length) return host.innerHTML = emptyStateHtml();
    lineChart(host, {
        labels: bk[0].list.map(b => b.label),
        series: bk.map(b => ({
            name: b.name, color: b.color,
            values: b.list.map(x => agg(x.rows).productivity_score)
        })),
        height: ctx.big ? 480 : 320,
        tip: teamTip(bk, key, ctx.gran)
    });
}

function drawBars(host, shown, key, ctx) {
    const bk = bucketsOf(shown, ctx);
    if (!bk.length || !bk[0].list.length) return host.innerHTML = emptyStateHtml();
    barChart(host, {
        labels: bk[0].list.map(b => b.label),
        series: bk.map(b => ({
            name: b.name, color: b.color,
            values: b.list.map(x => agg(x.rows)[key])
        })),
        height: ctx.big ? 420 : 260,
        tip: teamTip(bk, key, ctx.gran)
    });
}

function drawRates(host, shown, ctx) {
    const bk = bucketsOf(shown, ctx);
    if (!bk.length || !bk[0].list.length) return host.innerHTML = emptyStateHtml();
    const gran = ctx.gran;

    lineChart(host, {
        labels: bk[0].list.map(b => b.label),
        series: bk.map(b => ({
            name: b.name, color: b.color,
            values: b.list.map(x => agg(x.rows).meeting_rate)
        })),
        height: ctx.big ? 460 : 300,
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

/* Les boutons d'une carte sont recréés à chaque rendu : on les recâble ici,
   comme partout ailleurs dans ce fichier. La même fonction sert à la grille des
   graphiques et à celle du duel, pour que les deux se comportent pareil. */
function wireCards(grid) {
    grid.querySelectorAll('[data-zoom]').forEach(b =>
        b.addEventListener('click', () => openModal(b.dataset.zoom)));

    // Déplier ou replier le panneau ne touche qu'à un attribut : inutile de
    // refaire un rendu, et surtout inutile de redessiner un SVG pour cela.
    grid.querySelectorAll('[data-dates]').forEach(b =>
        b.addEventListener('click', () => {
            const k = b.dataset.dates;
            const panel = grid.querySelector(`[data-panel="${k}"]`);
            const willOpen = panel.hidden;
            panel.hidden = !willOpen;
            if (willOpen) datesOpen.add(k); else datesOpen.delete(k);
        }));

    grid.querySelectorAll('[data-scope-from], [data-scope-to]').forEach(inp =>
        inp.addEventListener('change', () => {
            const k = inp.dataset.scopeFrom || inp.dataset.scopeTo;
            const from = grid.querySelector(`[data-scope-from="${k}"]`).value;
            const to = grid.querySelector(`[data-scope-to="${k}"]`).value;
            if (!from || !to) return;
            scopes.set(k, normalizeRange({ from, to }));
            datesOpen.add(k);
            // refresh et non un simple redessin : les jours demandés ne sont
            // peut-être pas encore chargés.
            refresh();
        }));

    // On garde le panneau déplié après un retour à la période globale : faire
    // disparaître le bouton qu'on vient de cliquer est déroutant, et il faut
    // pouvoir relire la pastille qui confirme que la carte suit à nouveau.
    grid.querySelectorAll('[data-scope-reset]').forEach(b =>
        b.addEventListener('click', () => {
            const k = b.dataset.scopeReset;
            scopes.delete(k);
            datesOpen.add(k);
            refresh();
        }));
}

function renderCharts() {
    const grid = document.getElementById('charts-grid');
    const shown = shownPeople();

    if (!shown.length) {
        grid.innerHTML = `<div class="chart-card">${emptyStateHtml('Aucun compte à afficher.')}</div>`;
        return;
    }

    const ctxs = new Map(CHARTS.map(c => [c.key, ctxFor(c.key)]));
    const legend = legendOf(shown);

    grid.innerHTML = CHARTS.map(c => {
        const ctx = ctxs.get(c.key);
        return `
        <div class="chart-card${c.wide ? ' chart-card--wide' : ''}${ctx.scoped ? ' chart-card--scoped' : ''}">
            <div class="chart-head">
                <div class="chart-icon">${c.icon}</div>
                <div class="chart-titles">
                    <h3 class="chart-title">${escapeHtml(c.title)}</h3>
                    <p class="chart-sub">${escapeHtml(subOf(c, ctx))}</p>
                </div>
                ${toolsHtml(c.key)}
            </div>
            ${datesBarHtml(ctx)}
            ${legendHtml(legend)}
            <div data-host="${c.key}"></div>
            <details class="chart-note"><summary>Comment lire ce graphique</summary>
                <p>${c.note(ctx)}</p>
                <p class="chart-note-hover"><b>Au survol :</b> ${c.hover(ctx)}</p>
            </details>
        </div>`;
    }).join('')
        + (people.length > MAX_SERIES
            ? `<p class="chart-hint">Seuls les ${MAX_SERIES} premiers du classement sont tracés,
               au-delà les courbes deviennent illisibles. Le classement ci-dessus reste complet.</p>`
            : '');

    CHARTS.forEach(c => {
        const host = grid.querySelector(`[data-host="${c.key}"]`);
        if (host) c.render(host, shown, ctxs.get(c.key));
    });

    wireCards(grid);
}

/* --------------------------------------------------------------------------
   Duel de deux BDR
   -------------------------------------------------------------------------- */

/** La légende du duel, identique dans la carte et dans la fenêtre agrandie. */
const duelLegend = (A, B) => [
    { periodStyle: 'a', color: A_MAIN, label: nameOf(A) },
    { periodStyle: 'b', color: B_MAIN, label: nameOf(B) }
];

/* Les deux dessins du duel, sortis de renderDuel pour pouvoir être refaits dans
   la fenêtre d'agrandissement sans dupliquer une ligne de leur contenu. Ils
   reçoivent leur contexte comme les cartes de la grille : les chiffres et le
   rang sont ceux de la période de la carte, pas ceux du classement global. */
function drawDuelCompare(host, A, B, ctx) {
    const st = statsFor(ctx.from, ctx.to);
    const sA = st.get(A.profile.user_id), sB = st.get(B.profile.user_id);
    if (!sA || !sB) return host.innerHTML = emptyStateHtml();

    const dec = state.mode === 'avg';
    const fV = v => (dec ? fmtDec(v) : fmtInt(v));

    compareChart(host, {
        // Union des métiers des deux personnes comparées : comparer un BDR et un
        // commercial affiche les compteurs des deux, avec des zéros là où le
        // métier ne s'applique pas. Deux BDR voient exactement les mêmes lignes
        // qu'avant.
        rows: metricsForAny([A.profile, B.profile]).map(m => ({
            label: m.short, colorA: A_MAIN, colorB: B_MAIN,
            a: valOf(sA.a, m.key, state.mode), b: valOf(sB.a, m.key, state.mode)
        })),
        labelA: nameOf(A), labelB: nameOf(B),
        fmt: fV,
        tip: i => {
            const m = metricsForAny([A.profile, B.profile])[i];
            const w = SCORE_WEIGHTS.find(x => x.key === m.key);
            const side = (sp, color) => [
                { color, label: m.short, value: fV(valOf(sp.a, m.key, state.mode)), em: true },
                { label: 'Cumul', value: fmtInt(sp.a[m.key]), muted: true },
                { label: 'Par jour actif',
                  value: sp.a.activeDays > 0 ? fmtDec(sp.a[m.key] / sp.a.activeDays) : '–', muted: true },
                { label: 'Jours saisis', sub: `sur ${sp.a.days} j`, value: fmtInt(sp.a.activeDays), muted: true },
                { label: 'Rang au score', value: `${sp.rank}${sp.rank === 1 ? 'er' : 'e'}`, muted: true }
            ];
            const va = valOf(sA.a, m.key, state.mode), vb = valOf(sB.a, m.key, state.mode);
            const diff = va - vb;
            const pct = vb !== 0 ? (diff / Math.abs(vb)) * 100 : null;
            const dir = diff > 0.0001 ? 'up' : diff < -0.0001 ? 'down' : 'flat';
            return {
                title: m.label,
                meta: dec
                    ? `Moyenne par jour actif · ${periodLabelShort(ctx.from, ctx.to)}`
                    : `Cumul sur ${periodLabelShort(ctx.from, ctx.to)}`,
                sections: [
                    { accent: 'a', badge: 'A', head: nameOf(A), rows: side(sA, A_MAIN) },
                    { accent: 'b', badge: 'B', head: nameOf(B), rows: side(sB, B_MAIN) }
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

}

/* compareChart calcule sa hauteur d'après le nombre de lignes : elle n'a donc
   pas de variante agrandie, elle gagne seulement en largeur. */
function drawDuelTime(host, A, B, ctx) {
    const gran = ctx.gran;
    const bA = bucketize(rowsForRange(A.byDate, ctx.from, ctx.to), gran);
    const bB = bucketize(rowsForRange(B.byDate, ctx.from, ctx.to), gran);
    if (!bA.length) return host.innerHTML = emptyStateHtml();

    lineChart(host, {
        labels: bA.map(b => b.label),
        series: [
            { name: nameOf(A), color: A_MAIN, values: bA.map(b => agg(b.rows).productivity_score), area: true },
            { name: nameOf(B), color: B_MAIN, values: bB.map(b => agg(b.rows).productivity_score) }
        ],
        height: ctx.big ? 460 : 300,
        tip: i => {
            const ga = agg(bA[i] ? bA[i].rows : []);
            const gb = agg(bB[i] ? bB[i].rows : []);
            const line = (g, color) => [
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
                    { accent: 'a', badge: 'A', head: nameOf(A), rows: line(ga, A_MAIN) },
                    { accent: 'b', badge: 'B', head: nameOf(B), rows: line(gb, B_MAIN) }
                ],
                deltas: [{
                    label: 'Score', html: `<span class="delta delta--${
                        diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'}">${
                        diff > 0 ? '▲ +' : diff < 0 ? '▼ −' : '= '}${fmtInt(Math.abs(diff))} pts</span>`
                }]
            };
        }
    });

}

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
    const ctxC = ctxFor('duel-compare');
    const ctxT = ctxFor('duel-time');

    grid.innerHTML = `
        <div class="chart-card chart-card--wide${ctxC.scoped ? ' chart-card--scoped' : ''}">
            <div class="chart-head">
                <div class="chart-icon">⚔️</div>
                <div class="chart-titles">
                    <h3 class="chart-title">${escapeHtml(nameOf(A))} contre ${escapeHtml(nameOf(B))}</h3>
                    <p class="chart-sub">Action par action, ${dec ? 'en moyenne par jour actif' : 'en cumul'}, sur ${
                        escapeHtml(periodLabelShort(ctxC.from, ctxC.to))}</p>
                </div>
                ${toolsHtml('duel-compare')}
            </div>
            ${datesBarHtml(ctxC)}
            ${legendHtml(duelLegend(A, B))}
            <div data-host="duel-compare"></div>
        </div>
        <div class="chart-card chart-card--wide${ctxT.scoped ? ' chart-card--scoped' : ''}">
            <div class="chart-head">
                <div class="chart-icon">📈</div>
                <div class="chart-titles">
                    <h3 class="chart-title">Score dans le temps</h3>
                    <p class="chart-sub">Les deux trajectoires, ${granWord(ctxT.gran)} par ${granWord(ctxT.gran)}${
                        ctxT.scoped ? ` · ${escapeHtml(periodLabelShort(ctxT.from, ctxT.to))}` : ''}</p>
                </div>
                ${toolsHtml('duel-time')}
            </div>
            ${datesBarHtml(ctxT)}
            ${legendHtml(duelLegend(A, B))}
            <div data-host="duel-time"></div>
        </div>`;

    drawDuelCompare(grid.querySelector('[data-host="duel-compare"]'), A, B, ctxC);
    drawDuelTime(grid.querySelector('[data-host="duel-time"]'), A, B, ctxT);

    wireCards(grid);

    selA.onchange = () => { state.duelA = selA.value; renderDuel(); };
    selB.onchange = () => { state.duelB = selB.value; renderDuel(); };
}

/* --------------------------------------------------------------------------
   Agrandissement d'une carte, et dates propres en grand

   Le squelette de la fenêtre existait déjà dans team.html depuis que la page a
   été calquée sur le tableau de bord, mais rien ne le pilotait : c'est ce moteur
   qui manquait. Même ergonomie que sur la page Performances, jusqu'à la barre de
   dates de la fenêtre, qui écrit dans le même état que le panneau de la carte.
   Changer les dates en grand, c'est les changer sur la carte : deux réglages
   parallèles pour la même carte seraient une source de doute permanente.

   Aucun contenu n'est dupliqué. La fenêtre appelle la même fonction de dessin
   que la carte, avec un hôte plus large et une hauteur plus généreuse. Deux
   dessins qui divergeraient au fil des évolutions seraient pires que pas
   d'agrandissement du tout.
   -------------------------------------------------------------------------- */

let openKey = null;

/** Ce qu'il faut savoir pour redessiner une carte, qu'elle vienne de la grille
    ou du duel. Renvoie null quand il n'y a rien à montrer. */
function expandable(key) {
    const ctx = ctxFor(key, { big: true });
    const c = CHARTS.find(x => x.key === key);
    if (c) {
        const shown = shownPeople();
        if (!shown.length) return null;
        return {
            ctx,
            icon: c.icon,
            title: c.title,
            sub: subOf(c, ctx),
            legend: legendOf(shown),
            note: `<p>${c.note(ctx)}</p>
                   <p class="chart-note-hover"><b>Au survol :</b> ${c.hover(ctx)}</p>`,
            draw: host => c.render(host, shown, ctx)
        };
    }

    const A = personBy(state.duelA), B = personBy(state.duelB);
    if (!A || !B || A === B) return null;

    if (key === 'duel-compare') return {
        ctx,
        icon: '⚔️',
        title: `${nameOf(A)} contre ${nameOf(B)}`,
        sub: `Action par action, ${state.mode === 'avg' ? 'en moyenne par jour actif' : 'en cumul'}, sur ${
            periodLabelShort(ctx.from, ctx.to)}`,
        legend: duelLegend(A, B),
        note: `<p>Chaque ligne est une action, les deux barres se lisent l'une contre l'autre.
               Le survol donne le cumul, la moyenne par jour actif, le nombre de jours saisis,
               et l'écart en valeur comme en pourcentage.</p>`,
        draw: host => drawDuelCompare(host, A, B, ctx)
    };

    if (key === 'duel-time') return {
        ctx,
        icon: '📈',
        title: `Score dans le temps : ${nameOf(A)} et ${nameOf(B)}`,
        sub: `Les deux trajectoires, ${granWord(ctx.gran)} par ${granWord(ctx.gran)}${
            ctx.scoped ? ` · ${periodLabelShort(ctx.from, ctx.to)}` : ''}`,
        legend: duelLegend(A, B),
        note: `<p>Deux trajectoires de score sur la même échelle. Une courbe qui s'interrompt
               signale des périodes sans aucune saisie, jamais un zéro inventé.</p>`,
        draw: host => drawDuelTime(host, A, B, ctx)
    };

    return null;
}

function openModal(key) {
    // On n'ouvre pas une fenêtre vide : si la carte n'a rien à montrer, le
    // bouton ne fait rien plutôt que d'afficher un cadre blanc.
    if (!expandable(key)) return;
    openKey = key;
    document.getElementById('modal').hidden = false;
    document.body.style.overflow = 'hidden';
    paintModal();
}

function closeModal() {
    openKey = null;
    document.getElementById('modal').hidden = true;
    document.body.style.overflow = '';
}

function paintModal() {
    const e = openKey ? expandable(openKey) : null;
    // Le contenu a pu disparaître sous les pieds de la fenêtre : une personne
    // décochée, un duel devenu impossible. On referme plutôt que de montrer une
    // carte vide.
    if (!e) return closeModal();

    document.getElementById('modal-title').textContent = `${e.icon}  ${e.title}`;
    document.getElementById('modal-sub').textContent = e.sub;

    // La barre de dates de la fenêtre montre l'état de la carte, pas un état à
    // elle : les deux lisent et écrivent le même scopes.
    const from = document.getElementById('modal-from');
    const to = document.getElementById('modal-to');
    from.value = e.ctx.from; from.max = T;
    to.value = e.ctx.to; to.max = T;
    const pill = document.getElementById('modal-scope');
    pill.textContent = scopePill(e.ctx);
    pill.className = 'pill ' + (e.ctx.scoped ? 'pill--warn' : 'pill--info');

    document.getElementById('modal-body').innerHTML = `
        ${legendHtml(e.legend)}
        <div id="modal-host"></div>
        <details class="chart-note" open><summary>Comment lire ce graphique</summary>
            ${e.note}
        </details>`;
    e.draw(document.getElementById('modal-host'));
}

/* --------------------------------------------------------------------------
   Synthèse et export
   -------------------------------------------------------------------------- */

function renderSummary() {
    const el = document.getElementById('control-summary');
    const gran = effGran();
    const team = agg(people.flatMap(p => p.rows));
    const withData = people.filter(p => p.a.activeDays > 0).length;

    // Deux causes de retrait, deux compteurs. Les mélanger reviendrait à dire
    // « quatre comptes exclus » sans distinguer ce que l'outil a écarté de ce
    // que l'on a soi-même décoché, et c'est précisément la confusion à éviter.
    const byFilters = Math.max(0, allProfiles.length - eligible.length);
    const byHand = eligible.filter(pr => state.excluded.has(pr.user_id)).length;

    el.innerHTML = `<p class="summary-sentence">
        Sur <b>${periodLabel(state.from, state.to)}</b>, ${people.length} compte${people.length > 1 ? 's' : ''}
        suivi${people.length > 1 ? 's' : ''}, dont <b>${withData}</b> avec au moins une saisie.
        Un point de graphique représente <b>un ${granWord(gran)}</b>${
            scopes.size > 0 ? ', sur les graphiques qui suivent cette période' : ''}.
        Total de l'équipe : <b>${fmtInt(team.productivity_score)} points</b>.
        ${byFilters > 0 ? `${byFilters} compte${byFilters > 1 ? 's' : ''} exclu${byFilters > 1 ? 's' : ''} par les filtres.` : ''}
    </p>
    ${byHand > 0 ? `
        <p class="summary-sentence summary-sentence--warn">
            <b>Périmètre restreint à la main :</b> ${byHand} personne${byHand > 1 ? 's' : ''}
            décochée${byHand > 1 ? 's' : ''} dans « Qui est compté ». Les totaux, les
            moyennes et les classements ci-dessous ne portent pas sur toute l'équipe.
            <button type="button" class="btn btn--ghost" id="btn-recheck-all">
                Tout recocher
            </button>
        </p>` : ''}
    ${scopes.size > 0 ? `
        <p class="summary-sentence">
            <b>${scopes.size} graphique${scopes.size > 1
                ? 's sur leurs propres dates' : ' sur ses propres dates'}.</b>
            Le classement, les indicateurs de tête et l'export ci-dessous restent
            sur la période ci-dessus : seuls les graphiques concernés en sortent,
            et ils l'affichent dans leur en-tête.
            <button type="button" class="btn btn--ghost" id="btn-reset-scopes">
                Tout remettre sur la période globale
            </button>
        </p>` : ''}
    ${people.length === 0 && byFilters > 0 && byHand === 0 ? `
        <p class="summary-sentence">
            <b>Tous les comptes de la période sont masqués par les filtres.</b>
            C'est le réglage par défaut : les comptes de démonstration et les
            comptes désactivés sont écartés pour ne pas fausser les classements.
            <button type="button" class="btn btn--ghost" id="btn-include-all">
                Afficher les ${byFilters} compte${byFilters > 1 ? 's' : ''} masqué${byFilters > 1 ? 's' : ''}
            </button>
        </p>` : ''}`;

    // Les boutons sont recréés à chaque rendu : on les recâble ici plutôt que
    // dans le câblage initial, qui ne les verrait pas.
    const inc = document.getElementById('btn-include-all');
    if (inc) inc.addEventListener('click', () => {
        state.demo = true;
        state.inactive = true;
        refresh();
    });
    const all = document.getElementById('btn-recheck-all');
    if (all) all.addEventListener('click', () => { state.excluded.clear(); refresh(); });
    const gl = document.getElementById('btn-reset-scopes');
    if (gl) gl.addEventListener('click', () => { scopes.clear(); refresh(); });
}

function exportCsv() {
    // Colonnes des seuls métiers présents dans l'export : une équipe 100 % BDR
    // produit exactement le même fichier qu'avant.
    const cols = metricsForAny(people.map(p => p.profile));
    // Deux rangs et non un : le rang de métier est celui qui se lit, le rang
    // global celui qui explique les couleurs des graphiques. Un tableur qui
    // n'aurait que le second referait le classement mêlé qu'on vient d'écarter.
    const head = ['Rang metier', 'Rang global', 'Personne', 'E-mail', 'Metier', 'Admin', 'Demo', 'Actif',
        'Jours saisis', 'Jours periode',
        ...cols.map(m => m.short), 'Taux aboutis %', 'Taux RDV %', 'Score'];
    const lines = people.map(p => [
        p.jobRank, p.rank, nameOf(p), p.profile.email || '', jobLabel(p.profile),
        p.profile.is_admin ? 'oui' : 'non',
        p.profile.is_demo ? 'oui' : 'non', p.profile.is_active ? 'oui' : 'non',
        p.a.activeDays, p.a.days,
        ...cols.map(m => p.a[m.key]),
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
    // Un export qui ne contient qu'une partie de l'équipe doit le dire dans son
    // nom : un fichier transmis à quelqu'un d'autre n'emporte pas l'écran avec
    // lui, et rien n'y rappellerait que des personnes ont été décochées.
    const restricted = eligible.some(pr => state.excluded.has(pr.user_id));
    a.download = `equipe-${state.from}_${state.to}${restricted ? '-perimetre-restreint' : ''}.csv`;
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
        // Si une carte est ouverte en grand pendant qu'un réglage change, elle
        // doit suivre : une fenêtre figée sur d'anciens chiffres tromperait.
        if (openKey) paintModal();
    } catch (e) {
        toast(humanError(e), 'error');
    }
}

/* --------------------------------------------------------------------------
   Qui compte, nom par nom

   Les deux filtres au-dessus répondent à une question de nature : un compte de
   démonstration n'est pas une vraie personne. Cette liste-ci répond à une
   question de circonstance : ce mois-ci, untel était en formation, tel autre
   vient d'arriver. Aucun réglage automatique ne peut deviner cela, c'est donc
   un choix assumé et affiché.

   Décocher retire la personne de tout : classement, totaux d'équipe,
   graphiques, comparaison, export. Un demi-retrait, où la personne resterait
   affichée sans compter, donnerait un tableau que plus personne ne sait lire.
   -------------------------------------------------------------------------- */
function renderPeoplePick() {
    const box = document.getElementById('people-pick');
    const note = document.getElementById('explain-people');
    if (!box || !note) return;

    if (!eligible.length) {
        box.innerHTML = '<p class="pick-empty">Aucun compte ne passe les deux filtres ci-dessus.</p>';
        note.textContent = '';
        return;
    }

    box.innerHTML = eligible.map(pr => {
        const id = pr.user_id;
        const on = !state.excluded.has(id);
        const person = people.find(x => x.profile.user_id === id);
        const marks = [pr.is_demo ? 'démo' : '', pr.is_active ? '' : 'désactivé']
            .filter(Boolean).join(', ');
        // La pastille reprend la couleur du classement, pour que la liste et les
        // graphiques désignent la même personne sans effort de mémoire.
        const dot = on && person ? person.color : 'var(--gray-300)';
        // La case et le lien sont deux gestes différents : le lien reste hors du
        // label, sinon cliquer sur « fiche » cocherait ou décocherait la
        // personne au passage.
        return `<div class="person-pick${on ? '' : ' is-off'}">
            <label class="person-tick">
                <input type="checkbox" data-person="${id}"${on ? ' checked' : ''}>
                <span class="person-dot" style="background: ${dot}"></span>
                <span class="person-name">${escapeHtml(nameOfProfile(pr))}${
                    marks ? ` <em>${marks}</em>` : ''}</span>
            </label>
            <a class="person-open" href="${linkFor('./dashboard.html', id)}"
               title="Voir la fiche de ${escapeHtml(nameOfProfile(pr))}, telle qu'elle la voit">fiche</a>
        </div>`;
    }).join('');

    const off = eligible.filter(pr => state.excluded.has(pr.user_id)).length;
    note.innerHTML = off === 0
        ? 'Tout le monde compte. Décocher quelqu\'un le retire des classements, '
          + 'des totaux, des graphiques et de l\'export. « Fiche » ouvre sa page '
          + 'de performances telle qu\'elle la voit, en lecture seule.'
        : `<b>${off} personne${off > 1 ? 's' : ''} retirée${off > 1 ? 's' : ''} `
          + `du calcul à la main.</b> Les totaux ci-dessous ne portent donc plus sur `
          + `toute l\'équipe. <button type="button" class="btn-link" id="btn-recheck">`
          + `Tout recocher</button>`;

    // Cases et bouton sont recréés à chaque rendu : on les recâble ici, comme
    // ailleurs dans ce fichier, plutôt que dans le câblage initial.
    box.querySelectorAll('[data-person]').forEach(cb => {
        cb.addEventListener('change', () => {
            const id = cb.dataset.person;
            if (cb.checked) state.excluded.delete(id);
            else state.excluded.add(id);
            refresh();
        });
    });
    const again = document.getElementById('btn-recheck');
    if (again) again.addEventListener('click', () => { state.excluded.clear(); refresh(); });
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

    // Ce réglage ne vaut que pour les graphiques restés sur la période globale :
    // une carte à dates propres déduit sa granularité de sa propre longueur.
    document.getElementById('explain-gran').textContent = (state.gran === 'auto'
        ? `Choisi automatiquement : un ${granWord(effGran())} par point.`
        : `Chaque point du graphique regroupe un ${granWord(effGran())}.`)
        + (scopes.size > 0 ? ' Les graphiques à dates propres choisissent la leur.' : '');
    document.getElementById('explain-mode').textContent = state.mode === 'total'
        ? 'Le classement additionne tout sur la période.'
        : 'Le classement divise par le nombre de jours réellement saisis, ce qui ne pénalise pas une absence.';
    document.getElementById('explain-demo').textContent = state.demo
        ? 'Les comptes de démonstration comptent dans les classements.'
        : 'Les comptes de démonstration sont ignorés partout.';

    renderPeoplePick();
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

    // Fenêtre d'agrandissement : trois façons de la fermer, comme sur la page
    // Performances. La croix, le clic à côté de la carte, et Échap.
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal').addEventListener('click', e => {
        if (e.target.id === 'modal') closeModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && openKey) closeModal();
    });

    // Les dates de la fenêtre agrandie passent par refresh et non par un simple
    // repeint : élargir une carte peut demander des jours qui ne sont pas encore
    // chargés, et il faut alors un aller-retour avant de pouvoir dessiner.
    document.getElementById('modal-reset').addEventListener('click', () => {
        if (!openKey) return;
        scopes.delete(openKey);
        datesOpen.add(openKey);
        refresh();
    });
    const bindModalDate = id => document.getElementById(id).addEventListener('change', () => {
        const from = document.getElementById('modal-from').value;
        const to = document.getElementById('modal-to').value;
        if (!from || !to || !openKey) return;
        scopes.set(openKey, normalizeRange({ from, to }));
        refresh();
    });
    bindModalDate('modal-from'); bindModalDate('modal-to');

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
        await requireAuth({ needs: 'team' });
        renderNav();

        // Garde-fou côté écran. La vraie barrière est la RLS : sans le rôle
        // admin, la base ne renverrait de toute façon que ses propres lignes.
        if (!canReadAll()) {
            document.querySelector('.page-main').innerHTML = `
                <div class="page-container"><div class="chart-card">
                    <h3 class="chart-title">Page réservée à l'encadrement</h3>
                    <p class="chart-sub">Votre compte n'a pas accès à la vue d'équipe.
                       Retournez à <a href="./dashboard.html">vos performances</a>.</p>
                </div></div>`;
            hideVeil();
            return;
        }

        allProfiles = await listProfiles();
        // Le barème sert aux commentaires des graphiques, pas au calcul : les
        // scores viennent de la base, déjà pondérés. La vue d'équipe ne le
        // chargeait pas et citait donc les valeurs par défaut du fichier, qui
        // deviennent fausses dès le premier réglage depuis l'écran Barème.
        await loadScoreWeights();
        wire();
        // Les graphiques se redessinent à la largeur disponible : la fenêtre
        // agrandie aussi, sinon son contenu resterait à l'ancienne taille.
        onResize(() => { renderCharts(); renderDuel(); if (openKey) paintModal(); });
        await refresh();
        hideVeil();
    } catch (e) {
        if (String(e.message || e).includes('Non authentifié')) return;
        toast(humanError(e), 'error');
        hideVeil();
    }
})();
