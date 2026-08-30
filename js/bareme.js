/* ==========================================================================
   BAREME.JS — Le barème du score, et son effet vérifié avant d'enregistrer.

   Cette page existe pour une raison simple : le score n'est stocké nulle part.
   C'est une expression de la vue v_daily_kpi, recalculée à chaque affichage.
   Enregistrer un barème ne lance donc aucun recalcul : il renote instantanément
   tout l'historique, de tout le monde, y compris le meilleur jour de tous les
   temps. Un réglage aussi large ne se fait pas à l'aveugle, d'où l'aperçu.

   Trois principes tenus par ce fichier :

   1. AUCUN POIDS ÉCRIT EN DUR. Les champs sont construits depuis SCORE_WEIGHTS,
      lui-même chargé depuis la table score_weights au démarrage. Une valeur
      recopiée ici serait une troisième définition du barème, après la vue SQL
      et api.js, et c'est précisément ce que la migration v8 a supprimé.

   2. L'APERÇU PORTE SUR DE VRAIES PERSONNES, CHOISIES. La version précédente
      calculait l'effet sur les seuls comptes réels et prospecteurs : le
      propriétaire, qui ne saisit rien, ne voyait donc presque rien, et les
      trois mois de saisie des comptes de démonstration étaient ignorés alors
      qu'ils sont la seule matière abondante disponible pour calibrer. La liste
      montre maintenant tous les comptes, et c'est un bouton par ligne qui
      décide qui entre dans le calcul.

   3. LES MOYENNES SE RECALCULENT DEPUIS LES VOLUMES. Le score moyen d'une
      journée saisie est la somme des scores divisée par la somme des journées,
      jamais la moyenne des moyennes par personne : celui qui a saisi deux
      journées ne pèse pas autant que celui qui en a saisi cinquante. La colonne
      par personne, elle, reste une moyenne par personne, ce qui est la seule
      lecture juste pour comparer deux individus.

   4. UN SEUL BARÈME, DEUX MÉTIERS. Le sélecteur de métier ne crée pas un
      barème par métier : il choisit ce qu'on regarde. Les dix-huit champs restent
      dans le DOM, cachés en display:none, et l'enregistrement porte toujours
      sur les dix-huit poids. Deux raisons de tenir ce choix : une valeur tapée
      puis masquée n'est pas perdue au changement de vue, et les huit poids
      propres à un métier n'ont de toute façon aucun effet sur l'autre, qui ne
      saisit jamais ces actions. Ce qui n'est pas comparable, c'est le score
      d'un BDR et celui d'un commercial ; c'est la vue d'équipe qui règle ce
      problème en classant chaque métier séparément, pas cet écran.

   Aucun contrôle de droit ici n'est une protection : la RLS refuse l'écriture
   du barème à quiconque n'est pas propriétaire. Ce qui est fait ici, c'est ne
   pas promettre un bouton qui sera refusé.
   ========================================================================== */

import {
    requireAuth, myProfile, listProfiles, fetchTeamRange, humanError,
    todayISO, addDaysISO, levelLabel, canWriteAny,
    SCORE_WEIGHTS, currentWeights, saveScoreWeights, scoreWeightsMeta, scoreWith,
    weightJobs, jobsOf, jobLabel, isContributor
} from './api.js';
import { renderNav } from './nav.js';
import { escapeHtml, fmtInt, toast, hideVeil, delta } from './ui.js';

/* Fenêtre de chargement. Large volontairement : les données sont chargées une
   fois, et changer de fenêtre d'aperçu ne doit pas relancer une requête. À huit
   comptes et deux ans, cela représente quelques centaines de lignes. */
const HISTORY_DAYS = 730;

const WINDOWS = [
    { key: '30',  days: 30,          label: '30 jours' },
    { key: '90',  days: 90,          label: '90 jours' },
    { key: '365', days: 365,         label: '12 mois' },
    { key: 'all', days: HISTORY_DAYS, label: 'Tout' }
];

/* Les trois vues de l'écran. `jobs` dit quels métiers entrent dans l'aperçu,
   null valant « tout le monde », y compris les comptes sans métier. */
const JOB_VIEWS = [
    { key: 'all',   label: 'Les deux métiers', jobs: null },
    { key: 'bdr',   label: 'BDR',              jobs: ['bdr'] },
    { key: 'sales', label: 'Commercial',       jobs: ['sales'] }
];

/* Les groupes de poids, dans l'ordre d'affichage. L'appartenance n'est pas
   écrite ici : elle est demandée à weightJobs(), qui la lit dans METRICS. Un
   poids dont les deux métiers se servent est « commun », les autres sont
   propres à leur métier. */
/* Les trois totaux de l'entonnoir, sortis du rangement par métier depuis la v30.

   Ce sont des colonnes du barème comme les autres, mais elles ne se règlent plus
   de la même façon : depuis la v30 les points vivent dans les six catégories, et
   ces trois-là sont à zéro. Les laisser mélangées aux catégories, dans le groupe
   « Communs aux deux métiers », c'était offrir six champs et trois pièges au
   milieu, tous nommés « Rendez-vous » ou presque.

   Elles ne sont pas retirées de l'écran pour autant. Elles sont la seule chose
   qui donne encore des points aux journées d'avant l'entonnoir, et un poids qui
   existe en base sans apparaître nulle part est un poids que personne ne pourra
   corriger le jour où il aura été mis là par erreur. */
const LEGACY_KEYS = ['calls_connected', 'calls_engaged', 'meetings_booked'];

const WEIGHT_GROUPS = [
    {
        key: 'both', title: 'Communs aux deux métiers',
        note: 'Ces poids comptent pour tout le monde. Les toucher déplace les deux classements à la fois.',
        match: j => j.includes('bdr') && j.includes('sales')
    },
    {
        key: 'bdr', title: 'Propres au BDR',
        note: 'Sans effet sur le score d\'un commercial, qui ne saisit jamais ces actions.',
        match: j => j.includes('bdr') && !j.includes('sales')
    },
    {
        key: 'sales', title: 'Propres au commercial',
        note: 'Sans effet sur le score d\'un BDR, qui ne saisit jamais ces actions.',
        match: j => j.includes('sales') && !j.includes('bdr')
    },
    {
        key: 'legacy', title: 'Les trois totaux, avant l\'entonnoir',
        note: 'À laisser à zéro. Un total S\'AJOUTE à chacune de ses catégories, il ne la remplace pas : '
            + 'mettre 5 ici donne 5 points de plus à chacun des trois rendez-vous. Ces poids ne servent plus '
            + 'qu\'aux journées antérieures à l\'entonnoir, où le détail par catégorie n\'existait pas.',
        keys: LEGACY_KEYS,
        hint: 's\'ajoute à chacune de ses catégories'
    }
];

let profiles = [];
let rows = [];
let winKey = '30';
let jobKey = 'all';

/* Qui est retiré de l'aperçu. On mémorise les exclusions et non les inclusions :
   un compte créé après coup entre ainsi dans le calcul par défaut, au lieu
   d'être oublié silencieusement. Rien n'est persisté d'une visite à l'autre,
   c'est un écran de calibrage et non un tableau de bord quotidien. */
const excluded = new Set();

const winOf = () => WINDOWS.find(w => w.key === winKey) || WINDOWS[0];
const jobOf = () => JOB_VIEWS.find(j => j.key === jobKey) || JOB_VIEWS[0];

/** Vrai si ce profil entre dans la vue métier courante. */
function inJobView(p) {
    const want = jobOf().jobs;
    if (!want) return true;
    return jobsOf(p).some(j => want.includes(j));
}

/* --------------------------------------------------------------------------
   Chargement
   -------------------------------------------------------------------------- */

async function load() {
    profiles = await listProfiles();

    // Aucun filtre : les comptes de démonstration et désactivés sont chargés,
    // puisque c'est l'écran qui laisse ensuite décider lesquels comptent. Les
    // exclure ici priverait le calibrage de la seule masse de données existante.
    rows = await fetchTeamRange(addDaysISO(todayISO(), -(HISTORY_DAYS - 1)), todayISO(),
        { includeDemo: true, includeInactive: true, onlyBdr: false });
}

/* --------------------------------------------------------------------------
   Le formulaire du barème
   -------------------------------------------------------------------------- */

/** Le barème saisi à l'écran, borné, avec repli sur le barème courant. */
function formWeights() {
    const out = {};
    SCORE_WEIGHTS.forEach(x => {
        const el = document.getElementById(`w-${x.key}`);
        const v = Math.round(Number(el ? el.value : NaN));
        out[x.key] = Number.isFinite(v) && v >= 0 && v <= 1000 ? v : x.w;
    });
    return out;
}

/* Les poids d'un groupe, dans l'ordre de SCORE_WEIGHTS.

   Un groupe qui nomme ses clés les prend telles quelles. Les autres se servent
   dans METRICS, en laissant de côté ce qu'un groupe explicite a déjà réclamé :
   sans ce retrait, les trois totaux apparaîtraient deux fois à l'écran, une fois
   parmi les communs et une fois dans leur propre bloc, avec le même id de champ.
   Deux <input> de même id, c'est formWeights() qui ne lit plus que le premier. */
function weightsOfGroup(g) {
    if (g.keys) return SCORE_WEIGHTS.filter(x => g.keys.includes(x.key));
    return SCORE_WEIGHTS.filter(x =>
        !LEGACY_KEYS.includes(x.key) && g.match(weightJobs(x.key)));
}

/** Vrai si ce groupe de poids est visible dans la vue métier courante. */
function groupVisible(g) {
    const want = jobOf().jobs;
    if (!want) return true;
    if (g.key === 'both') return true;
    /* Les totaux hérités concernent les deux métiers et sont surtout un piège :
       ils restent visibles quelle que soit la vue. */
    if (g.key === 'legacy') return true;
    return want.includes(g.key);
}

/**
 * Construit les champs depuis SCORE_WEIGHTS, groupés par métier.
 *
 * Les dix-huit champs sont écrits à chaque fois, y compris ceux d'un métier qu'on
 * ne regarde pas : c'est ce qui permet à formWeights() de lire une valeur tapée
 * avant un changement de vue au lieu de la remplacer par le poids enregistré.
 * Le masquage est fait en display:none inline, sans classe nouvelle dans
 * app.css, pour ne pas toucher un fichier que d'autres écrans partagent.
 */
function renderWeights() {
    const grid = document.getElementById('w-grid');
    const note = document.getElementById('w-note');
    if (!grid) return;
    const cur = currentWeights();
    const allowed = canWriteAny(myProfile());

    const fieldHtml = (x, g) => `
        <div class="field">
            <label for="w-${x.key}">${x.icon} ${escapeHtml(x.label)}</label>
            <input type="number" id="w-${x.key}" min="0" max="1000" step="1"
                   inputmode="numeric" value="${cur[x.key]}" ${allowed ? '' : 'disabled'}>
            <p class="field-note">${escapeHtml(g.hint || `points par ${x.label.toLowerCase()}`)}</p>
        </div>`;

    grid.innerHTML = WEIGHT_GROUPS.map(g => {
        const list = weightsOfGroup(g);
        if (!list.length) return '';
        return `
        <div data-wgroup="${g.key}"${groupVisible(g) ? '' : ' style="display:none"'}>
            <p class="seg-label">${escapeHtml(g.title)}
                <span class="td-muted">· ${escapeHtml(g.note)}</span></p>
            <div class="form-grid">${list.map(x => fieldHtml(x, g)).join('')}</div>
        </div>`;
    }).join('');

    const submit = document.getElementById('w-submit');
    const reset = document.getElementById('w-reset');
    if (submit) submit.disabled = !allowed;
    if (reset) reset.disabled = !allowed;

    const meta = scoreWeightsMeta();
    const parts = [];
    if (!allowed) {
        parts.push('Seul le <b>propriétaire</b> peut modifier le barème. ' +
            'Un barème propre à chacun rendrait les scores incomparables entre deux personnes, ' +
            "ce qui est précisément l'usage de la vue d'équipe.");
    }
    if (!meta.loaded) {
        parts.push('⚠ Le barème n\'a pas pu être lu en base : les valeurs affichées sont celles ' +
            'du repli inscrit dans le code. Enregistrer depuis cet écran resterait sans effet visible ' +
            'tant que la lecture échoue.');
    } else if (meta.changed) {
        const w = whenLabel(meta.updatedAt);
        parts.push(`Dernière modification ${w ? `le ${escapeHtml(w.date)} (${escapeHtml(w.ago)})` : ''} ` +
            `par ${escapeHtml(nameOf(meta.updatedBy))}.`);
    } else {
        parts.push('Barème d\'origine, jamais modifié depuis la mise en service.');
    }
    parts.push('Le score n\'est stocké nulle part : il est recalculé à chaque affichage. ' +
        'Un barème enregistré s\'applique donc à <b>tout l\'historique</b> et pour <b>tout le monde</b>, ' +
        'y compris au meilleur jour de tous les temps.');
    parts.push('Le sélecteur de métier ne masque que l\'affichage : <b>enregistrer envoie toujours ' +
        'les douze poids</b>, y compris ceux d\'un métier que vous ne regardez pas. Une valeur ' +
        'modifiée puis masquée reste donc prise en compte, et la liste des changements avant ' +
        'confirmation la nommera.');
    if (note) note.innerHTML = parts.join(' ');
}

/* --------------------------------------------------------------------------
   L'aperçu

   Tout est calculé dans le navigateur, à partir des lignes déjà chargées.
   Rien n'est écrit, rien n'est relu : on peut donc essayer dix barèmes de
   suite sans faire bouger le score de qui que ce soit.
   -------------------------------------------------------------------------- */

/**
 * Une ligne par compte, y compris ceux qui n'ont rien saisi sur la fenêtre :
 * les faire disparaître de la liste laisserait croire à un oubli, alors que
 * l'information utile est justement qu'il n'y a rien à noter chez eux.
 */
function buildRows() {
    const w = winOf();
    const from = addDaysISO(todayISO(), -(w.days - 1));
    const cur = currentWeights();
    const next = formWeights();

    const per = new Map();
    rows.forEach(r => {
        if (r.activity_date < from) return;
        // Une journée sans aucune action n'est pas une journée travaillée : la
        // compter tirerait toutes les moyennes vers le bas sans rien dire du
        // barème, qui est le seul sujet de cet écran.
        if (Number(r.total_actions) <= 0) return;
        const e = per.get(r.user_id) || { days: 0, before: 0, after: 0, meetings: 0, firsts: 0 };
        e.days++;
        e.before += scoreWith(r, cur);
        e.after += scoreWith(r, next);
        // Deux compteurs de rendez-vous, jamais additionnés : meetings_booked est
        // le RDV décroché par la prospection, first_meetings le premier rendez-vous
        // tenu par le commercial. Les cumuler compterait deux fois la même
        // rencontre, ce que la colonne d'aperçu doit se garder de faire.
        e.meetings += Number(r.meetings_booked) || 0;
        e.firsts += Number(r.first_meetings) || 0;
        per.set(r.user_id, e);
    });

    // La vue métier filtre la population : régler le poids du RDV1 en voyant
    // la moyenne de cinq BDR qui n'en saisissent aucun ne dit rien d'utile.
    return profiles.filter(inJobView).map(p => {
        const e = per.get(p.user_id) || { days: 0, before: 0, after: 0, meetings: 0, firsts: 0 };
        return {
            id: p.user_id,
            name: p.display_name || p.email || 'compte sans nom',
            demo: !!p.is_demo,
            active: p.is_active !== false,
            // Le badge doit dire « ne saisit rien », pas « ne prospecte pas » :
            // un commercial ne prospecte pas au sens du BDR et saisit pourtant
            // tous les jours. isContributor répond à la bonne question.
            contributor: isContributor(p),
            job: jobLabel(p),
            level: levelLabel(p),
            days: e.days,
            meetings: e.meetings,
            firsts: e.firsts,
            sumBefore: e.before,
            sumAfter: e.after,
            before: e.days ? e.before / e.days : 0,
            after: e.days ? e.after / e.days : 0,
            on: e.days > 0 && !excluded.has(p.user_id)
        };
    });
}

/** Rangs calculés sur les seuls comptes retenus : un exclu n'a pas de rang. */
function ranksOf(list, key) {
    const sorted = list.filter(x => x.on).slice().sort((a, b) => b[key] - a[key]);
    return new Map(sorted.map((x, i) => [x.id, i + 1]));
}

function renderPreview() {
    const host = document.getElementById('preview');
    if (!host) return;

    const list = buildRows();
    const kept = list.filter(x => x.on);
    const cur = currentWeights();
    const next = formWeights();
    const changed = SCORE_WEIGHTS.filter(x => next[x.key] !== cur[x.key]);

    const rB = ranksOf(list, 'before');
    const rA = ranksOf(list, 'after');

    // Ordre d'affichage : les comptes retenus d'abord, par score décroissant
    // avec le barème essayé, puis les autres. On lit ainsi le classement sans
    // avoir à sauter des lignes grises.
    list.sort((a, b) => {
        if (a.on !== b.on) return a.on ? -1 : 1;
        if (a.on) return b.after - a.after;
        if (a.days !== b.days) return b.days - a.days;
        return a.name.localeCompare(b.name, 'fr');
    });

    const totDays = kept.reduce((t, x) => t + x.days, 0);
    const totB = kept.reduce((t, x) => t + x.sumBefore, 0);
    const totA = kept.reduce((t, x) => t + x.sumAfter, 0);
    const perDayB = totDays ? totB / totDays : 0;
    const perDayA = totDays ? totA / totDays : 0;
    const pct = perDayB > 0 ? ((perDayA - perDayB) / perDayB) * 100 : 0;
    const moved = kept.filter(x => rB.get(x.id) !== rA.get(x.id)).length;

    const w = winOf();
    const jv = jobOf();
    const who = jv.jobs ? `des comptes « ${jv.label.toLowerCase()} »` : 'de tous les comptes';

    /* Un poids modifié dans un groupe masqué compte quand même : le dire ici
       évite le pire malentendu possible sur cet écran, croire n'avoir touché
       que le métier affiché. */
    const hidden = changed.filter(x => {
        const g = WEIGHT_GROUPS.find(gr => gr.match(weightJobs(x.key)));
        return g && !groupVisible(g);
    });
    const hiddenNote = hidden.length
        ? ` <b>Attention :</b> ${fmtInt(hidden.length)} poids modifié(s) hors de la vue affichée
            (${hidden.map(x => escapeHtml(x.label.toLowerCase())).join(', ')}) et
            ${hidden.length > 1 ? 'ils seront enregistrés' : 'il sera enregistré'} aussi.`
        : '';

    let head;
    if (!kept.length) {
        head = `<p class="field-note">Aucun compte retenu, ou aucune journée saisie sur
            ${escapeHtml(w.label.toLowerCase())} par les comptes retenus ${escapeHtml(who)}.
            Choisissez une fenêtre plus large, une autre vue métier, ou remettez des comptes dans
            l'aperçu. Le barème reste enregistrable.${hiddenNote}</p>`;
    } else if (!changed.length) {
        head = `<p class="field-note">Barème identique à celui enregistré : rien ne bougerait.
            Modifiez un champ ci-dessus pour voir l'effet sur
            <b>${fmtInt(kept.length)}</b> compte(s) et <b>${fmtInt(totDays)}</b> journée(s) saisie(s)
            sur ${escapeHtml(w.label.toLowerCase())}, ${escapeHtml(who)}.</p>`;
    } else {
        head = `<p class="field-note">
            ${changed.map(x => `<b>${escapeHtml(x.label.toLowerCase())}</b> ${x.w} → ${next[x.key]}`).join(', ')}.
            Sur <b>${fmtInt(kept.length)}</b> compte(s) ${escapeHtml(who)} et
            <b>${fmtInt(totDays)}</b> journée(s) saisie(s),
            le score moyen d'une journée passerait de <b>${fmtInt(Math.round(perDayB))}</b> à
            <b>${fmtInt(Math.round(perDayA))}</b> (${pct >= 0 ? '+' : ''}${pct.toFixed(1)} %).
            ${moved === 0
                ? 'Le classement ne change pas.'
                : `<b>${fmtInt(moved)}</b> personne(s) changent de rang.`}${hiddenNote}</p>`;
    }

    const badges = x => [
        x.demo ? '<b class="badge badge--demo">Démo</b>' : '',
        !x.active ? '<b class="badge">Désactivé</b>' : '',
        // En vue « les deux métiers » le métier est une information ; dans une
        // vue filtrée il est déjà dit par le sélecteur, le répéter est du bruit.
        x.job && jobKey === 'all' ? `<b class="badge">${escapeHtml(x.job)}</b>` : '',
        !x.contributor ? '<b class="badge">Ne saisit rien</b>' : ''
    ].filter(Boolean).join(' ');

    const rankCell = x => {
        if (!x.on) return '<span class="td-muted">—</span>';
        const b = rB.get(x.id), a = rA.get(x.id);
        if (b === a) return `${a} <span class="td-muted">=</span>`;
        // Un rang qui baisse en numéro est une progression : la flèche suit le
        // mérite, pas le nombre, sinon la couleur dit le contraire du fait.
        return `${a} <span class="delta delta--${a < b ? 'up' : 'down'}">${a < b ? '▲' : '▼'} ${b}</span>`;
    };

    const cell = (x, v) => (x.on ? v : `<span class="td-muted">${v}</span>`);

    /* Colonnes de résultat selon la vue. Jamais additionnées : le RDV obtenu et
       le RDV1 sont deux événements distincts, portés par deux personnes. En vue
       « les deux métiers » on montre donc deux colonnes plutôt qu'une somme qui
       n'aurait aucun sens. */
    const resultCols = jobKey === 'bdr'
        ? [{ th: 'RDV', get: x => x.meetings }]
        : jobKey === 'sales'
        ? [{ th: 'RDV1', get: x => x.firsts }]
        : [{ th: 'RDV', get: x => x.meetings }, { th: 'RDV1', get: x => x.firsts }];

    host.innerHTML = `
        ${head}
        <div class="table-wrap">
            <table>
                <thead><tr>
                    <th>Compte</th><th>Journées</th>${resultCols.map(c => `<th>${c.th}</th>`).join('')}
                    <th>Score moyen actuel</th><th>Avec ce barème</th><th>Écart</th><th>Rang</th>
                    <th>Dans l'aperçu</th>
                </tr></thead>
                <tbody>${list.map(x => `
                    <tr>
                        <td data-th="Compte">${escapeHtml(x.name)} ${badges(x)}</td>
                        <td data-th="Journées">${x.days ? cell(x, fmtInt(x.days)) : '<span class="td-muted">aucune</span>'}</td>
                        ${resultCols.map(c => `<td data-th="${c.th}">${x.days
                            ? cell(x, fmtInt(c.get(x)))
                            : '<span class="td-muted">—</span>'}</td>`).join('')}
                        <td data-th="Score moyen actuel">${x.days ? cell(x, fmtInt(Math.round(x.before))) : '<span class="td-muted">—</span>'}</td>
                        <td data-th="Avec ce barème" class="td-score">${x.days
                            ? (x.on ? `<b>${fmtInt(Math.round(x.after))}</b>` : `<span class="td-muted">${fmtInt(Math.round(x.after))}</span>`)
                            : '<span class="td-muted">—</span>'}</td>
                        <td data-th="Écart">${x.days && x.on
                            ? delta(Math.round(x.after), Math.round(x.before)).html
                            : '<span class="td-muted">—</span>'}</td>
                        <td data-th="Rang">${rankCell(x)}</td>
                        <td data-th="" class="td-action">${x.days
                            ? `<button class="toggle ${x.on ? 'toggle--on' : ''}" type="button"
                                       data-uid="${escapeHtml(x.id)}"
                                       aria-pressed="${x.on ? 'true' : 'false'}">${x.on ? 'Compté' : 'Ignoré'}</button>`
                            : '<span class="td-muted">rien à noter</span>'}</td>
                    </tr>`).join('')}</tbody>
            </table>
        </div>`;
}

/**
 * Le métier regardé. Rendu en JS comme la fenêtre, pour la même raison : il
 * porte un état sélectionné que le HTML ne peut pas connaître au chargement.
 */
function renderJobs() {
    const seg = document.getElementById('job-seg');
    if (!seg) return;
    seg.innerHTML = JOB_VIEWS.map(j => `
        <button type="button" data-job="${j.key}" class="${j.key === jobKey ? 'is-on' : ''}"
                aria-pressed="${j.key === jobKey ? 'true' : 'false'}">${escapeHtml(j.label)}</button>`).join('');
}

/** La fenêtre d'observation. Rendue en JS pour porter l'état sélectionné. */
function renderWindow() {
    const seg = document.getElementById('win-seg');
    if (!seg) return;
    seg.innerHTML = WINDOWS.map(w => `
        <button type="button" data-win="${w.key}" class="${w.key === winKey ? 'is-on' : ''}"
                aria-pressed="${w.key === winKey ? 'true' : 'false'}">${escapeHtml(w.label)}</button>`).join('');
}

/* --------------------------------------------------------------------------
   Petits formats
   -------------------------------------------------------------------------- */

/** Horodatage en clair, avec l'ancienneté qui est l'information utile. */
function whenLabel(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    if (isNaN(d)) return null;
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    const date = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' });
    if (days <= 0) return { date, ago: "aujourd'hui" };
    if (days === 1) return { date, ago: 'hier' };
    if (days < 30) return { date, ago: `il y a ${days} j` };
    const months = Math.round(days / 30);
    return { date, ago: `il y a ${months} mois` };
}

function nameOf(id) {
    const p = profiles.find(x => x.user_id === id);
    return p ? (p.display_name || p.email || 'ce compte') : 'ce compte';
}

/* --------------------------------------------------------------------------
   Branchements

   Les écouteurs sont posés une seule fois, sur des conteneurs qui ne sont
   jamais réécrits. Le tableau et les boutons de fenêtre, eux, sont refaits à
   chaque frappe : y attacher des écouteurs directement les perdrait au premier
   rendu suivant.
   -------------------------------------------------------------------------- */

function wire() {
    const form = document.getElementById('weights-form');
    const status = document.getElementById('w-status');

    // L'aperçu se recalcule à la frappe : tout est local, rien n'est écrit.
    form?.addEventListener('input', renderPreview);

    document.getElementById('w-reset')?.addEventListener('click', () => {
        renderWeights();
        renderPreview();
        if (status) status.textContent = '';
    });

    document.getElementById('win-seg')?.addEventListener('click', ev => {
        const b = ev.target.closest('button[data-win]');
        if (!b) return;
        winKey = b.dataset.win;
        renderWindow();
        renderPreview();
    });

    /* Changer de métier ne réécrit PAS le formulaire : les champs gardent les
       valeurs en cours de saisie, seuls les groupes concernés apparaissent ou
       disparaissent. Appeler renderWeights() ici effacerait un poids tapé et
       non encore enregistré, ce qui est exactement ce qu'un écran de calibrage
       ne doit jamais faire. */
    document.getElementById('job-seg')?.addEventListener('click', ev => {
        const b = ev.target.closest('button[data-job]');
        if (!b) return;
        jobKey = b.dataset.job;
        renderJobs();
        WEIGHT_GROUPS.forEach(g => {
            const el = document.querySelector(`[data-wgroup="${g.key}"]`);
            if (el) el.style.display = groupVisible(g) ? '' : 'none';
        });
        renderPreview();
    });

    document.getElementById('preview')?.addEventListener('click', ev => {
        const b = ev.target.closest('button[data-uid]');
        if (!b) return;
        const id = b.dataset.uid;
        if (excluded.has(id)) excluded.delete(id); else excluded.add(id);
        renderPreview();
    });

    document.getElementById('pick-all')?.addEventListener('click', () => {
        excluded.clear();
        renderPreview();
    });

    document.getElementById('pick-real')?.addEventListener('click', () => {
        excluded.clear();
        profiles.filter(p => p.is_demo).forEach(p => excluded.add(p.user_id));
        renderPreview();
    });

    document.getElementById('pick-demo')?.addEventListener('click', () => {
        excluded.clear();
        profiles.filter(p => !p.is_demo).forEach(p => excluded.add(p.user_id));
        renderPreview();
    });

    document.getElementById('btn-reload')?.addEventListener('click', async () => {
        try {
            await load();
            renderPreview();
            toast('Données rechargées');
        } catch (e) {
            toast(humanError(e), 'error');
        }
    });

    form?.addEventListener('submit', async ev => {
        ev.preventDefault();
        const next = formWeights();
        const cur = currentWeights();
        const changed = SCORE_WEIGHTS.filter(x => next[x.key] !== cur[x.key]);
        if (!changed.length) { toast('Ce barème est déjà celui enregistré'); return; }

        const detail = changed.map(x => `  • ${x.label} : ${x.w} → ${next[x.key]}`).join('\n');
        if (!confirm('Enregistrer ce barème ?\n\n' + detail +
            '\n\nLe score n\'étant pas stocké, tout l\'historique de toute l\'équipe sera renoté ' +
            'immédiatement, y compris les journées déjà passées et le meilleur jour de tous les temps.')) return;

        const submit = document.getElementById('w-submit');
        if (submit) submit.disabled = true;
        if (status) status.textContent = 'Enregistrement…';
        try {
            await saveScoreWeights(next);
            renderWeights();
            renderPreview();
            if (status) status.textContent = '';
            toast('Barème enregistré. Les scores sont renotés.');
        } catch (e) {
            if (status) status.textContent = '';
            toast(humanError(e), 'error');
        } finally {
            if (submit) submit.disabled = !canWriteAny(myProfile());
        }
    });
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   Les deux volets

   Le barème dit combien vaut une action, les objectifs disent combien il en
   faut : deux réglages du même pilotage, tous deux réservés au propriétaire.

   Le volet des objectifs vit dans js/objectifs.js, et son import est différé
   jusqu'au premier clic. Deux raisons : quelqu'un qui vient corriger un poids
   n'a pas à attendre le chargement de la liste des profils, et bareme.js reste
   un fichier qu'on peut relire.
   -------------------------------------------------------------------------- */

function wireTabs() {
    const barre = document.getElementById('bo-tabs');
    if (!barre) return;

    barre.addEventListener('click', async ev => {
        const b = ev.target.closest('button[data-pane]');
        if (!b) return;

        barre.querySelectorAll('button[data-pane]').forEach(x => {
            const on = x === b;
            x.classList.toggle('is-on', on);
            x.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        document.getElementById('pane-bareme').hidden = b.dataset.pane !== 'bareme';
        document.getElementById('pane-objectifs').hidden = b.dataset.pane !== 'objectifs';

        if (b.dataset.pane === 'objectifs') {
            try {
                const mod = await import('./objectifs.js');
                await mod.initObjectifs();
            } catch (e) {
                toast(humanError(e), 'error');
            }
        }
    });
}

(async function main() {
    try {
        await requireAuth({ needs: 'admin' });
        renderNav();

        // Le barème est global : le laisser régler par plusieurs personnes,
        // c'est prendre le risque que deux d'entre elles le fassent le même
        // jour sans se le dire. La base refuse déjà l'écriture, cet écran
        // évite simplement de promettre un formulaire qui serait rejeté.
        if (!canWriteAny(myProfile())) {
            document.querySelector('.page-main').innerHTML = `
                <div class="page-container"><div class="chart-card">
                    <h3 class="chart-title">Page réservée au propriétaire</h3>
                    <p class="chart-sub">Le barème du score s'applique à toute l'équipe et à tout
                       l'historique : une seule personne le règle. Retournez à
                       <a href="./team.html">la vue d'équipe</a> ou à
                       <a href="./admin.html">la gestion des comptes</a>.</p>
                </div></div>`;
            hideVeil();
            return;
        }

        await load();
        renderJobs();
        renderWeights();
        renderWindow();
        renderPreview();
        wire();
        wireTabs();
        hideVeil();
    } catch (e) {
        if (String(e.message || e).includes('Non authentifié')) return;
        toast(humanError(e), 'error');
        hideVeil();
    }
})();
