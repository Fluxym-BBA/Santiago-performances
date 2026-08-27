/* ============================================================================
   MON CALENDRIER (v23)

   POURQUOI CETTE PAGE EXISTE ALORS QUE LE TABLEAU DÉTAILLÉ EXISTE DÉJÀ

   Le tableau détaillé de Mes performances contient exactement la même donnée :
   une ligne par jour, douze colonnes. Ce qui lui manque n'est pas l'information,
   c'est la forme. Un tableau se lit ligne à ligne ; un mois se regarde. Les
   trous, les lundis creux, la semaine de salon, la reprise après les congés :
   tout cela se voit dans une grille et ne se voit dans aucun tableau trié par
   date.

   CE QU'ELLE NE FAIT PAS. Aucune comparaison, aucune période B, aucune échelle
   de lecture, aucun objectif, aucun écart. Tout cela vit dans Mes performances
   et n'a rien à faire ici : la valeur de cet écran tient à ce qu'il ne montre
   presque rien. Elle n'écrit rien non plus, elle relit.

   CE QU'ELLE SERT VRAIMENT. Montrer les jours qui n'ont jamais été saisis. Le
   seul test qui compte pour cet outil est que les chiffres soient saisis tous
   les jours, et rien ne rend un oubli aussi évident qu'une case vide au milieu
   d'une grille. C'est la raison pour laquelle le premier chiffre de la page est
   le nombre de jours ouvrés saisis, et non un volume d'appels.

   PAS DE ROUGE, PAS DE VERT. La couleur dit ce qui a été fait, jamais si
   c'était bien. Un calendrier noté deviendrait un bulletin, et un bulletin, on
   ne l'ouvre pas.
   ========================================================================== */

import {
    requireAuth, metricsFor, viewedProfile, isViewingOther, linkFor,
    todayISO, addDaysISO, fetchRange, fetchProfilesRange, joursOuvres,
    PROFILE_BY_KIND, profileText, scoreOf
} from './api.js';
import { $, fmtInt, escapeHtml, hideVeil } from './ui.js';
import { renderNav } from './nav.js';

/* --------------------------------------------------------------------------
   DATES

   Toutes les dates circulent en chaînes ISO. Les objets Date ne servent qu'au
   calcul, et toujours construits à midi : à minuit, un décalage horaire d'une
   heure suffit à faire reculer une date d'un jour, et un calendrier qui décale
   les colonnes deux fois par an est un calendrier faux.
   -------------------------------------------------------------------------- */

const dOf = iso => new Date(`${iso}T12:00:00`);
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    + `-${String(d.getDate()).padStart(2, '0')}`;

/** Jour de la semaine, lundi = 0. La semaine française commence le lundi. */
const dow = iso => (dOf(iso).getDay() + 6) % 7;

const lundiDe = iso => addDaysISO(iso, -dow(iso));
const estWeekEnd = iso => dow(iso) >= 5;

function moisBornes(iso) {
    const d = dOf(iso);
    const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const to = isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12));
    return { from, to };
}

const semaineBornes = iso => ({ from: lundiDe(iso), to: addDaysISO(lundiDe(iso), 6) });

/** Les jours réellement affichés, week-ends compris. */
function bornesVue(state) {
    return state.vue === 'week' ? semaineBornes(state.ancre) : moisBornes(state.ancre);
}

/**
 * Les jours de la grille. En vue mois, la grille déborde jusqu'au lundi
 * précédent et au dimanche suivant : sept colonnes alignées sur les jours de la
 * semaine valent mieux qu'une première ligne tronquée, sinon la comparaison
 * verticale d'un lundi à l'autre ne veut plus rien dire.
 */
function joursGrille(state) {
    const { from, to } = bornesVue(state);
    const debut = state.vue === 'week' ? from : lundiDe(from);
    const fin = state.vue === 'week' ? to : addDaysISO(to, 6 - dow(to));
    const jours = [];
    for (let j = debut; j <= fin; j = addDaysISO(j, 1)) jours.push(j);
    return jours;
}

const LONG = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const MOIS_AN = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
const JOUR_MOIS = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });
const DOWS = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];

/* --------------------------------------------------------------------------
   ÉTAT
   Rien n'est mémorisé d'une visite à l'autre, comme sur Mes performances : la
   mémorisation des réglages est un sujet à traiter en une fois pour tous les
   écrans, ou pas du tout.
   -------------------------------------------------------------------------- */

const state = { vue: 'month', ancre: todayISO(), pivot: null, sel: todayISO() };
const data = { rows: new Map(), profs: new Map(), from: null, to: null };
let compteurs = [];

const T = todayISO();

/* --------------------------------------------------------------------------
   LECTURE
   -------------------------------------------------------------------------- */

/**
 * Une seule requête de données et une de profils, pour toute la grille visible.
 * Changer de compteur affiché ou de densité ne relit rien : c'est un redessin.
 */
async function charge() {
    const jours = joursGrille(state);
    const from = jours[0];
    const to = jours[jours.length - 1];
    if (data.from === from && data.to === to) { dessine(); return; }

    const [rows, profs] = await Promise.all([
        fetchRange(from, to),
        fetchProfilesRange(from, to).catch(() => new Map())
    ]);
    data.rows = new Map(rows.map(r => [r.activity_date, r]));
    data.profs = profs;
    data.from = from;
    data.to = to;
    recentreSelection();
    dessine();
}

/**
 * Après un changement de période, le jour sélectionné n'est plus dans la
 * grille. Plutôt que de laisser le panneau vide, on retombe sur le jour le plus
 * utile : aujourd'hui s'il est dans la période, sinon le dernier jour saisi,
 * sinon le premier jour. Un panneau vide à chaque changement de mois obligerait
 * à cliquer avant de pouvoir lire quoi que ce soit.
 */
function recentreSelection() {
    const { from, to } = bornesVue(state);
    if (state.sel >= from && state.sel <= to) return;
    if (T >= from && T <= to) { state.sel = T; return; }
    const saisis = [...data.rows.keys()].filter(j => j >= from && j <= to).sort();
    state.sel = saisis.length ? saisis[saisis.length - 1] : from;
}

/** La valeur d'un compteur pour un jour. null quand elle n'a pas été mesurée. */
function valeur(iso, key) {
    const r = data.rows.get(iso);
    if (!r) return null;
    const v = r[key];
    return v === null || v === undefined ? null : Number(v);
}

/* --------------------------------------------------------------------------
   RENDU
   -------------------------------------------------------------------------- */

/** Teinte de fond d'une case, proportionnelle au maximum de la période. */
function teinte(hex, ratio) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${(0.06 + 0.62 * ratio).toFixed(3)})`;
}

/** La bande de profil, en bas de la case. Vide quand rien n'est déclaré. */
function bandeHtml(iso) {
    const l = data.profs.get(iso);
    if (!l || !l.length) return '';
    const parts = l.map(x => {
        const m = PROFILE_BY_KIND[x.kind];
        return `<i style="width:${Math.max(0, Math.min(100, x.share))}%;`
            + `background:${m ? m.color : 'var(--gray-300)'}"></i>`;
    }).join('');
    return `<span class="cal-band">${parts}</span>`;
}

function celluleHtml(iso, { dansPeriode, pivot, max }) {
    if (!dansPeriode) {
        return `<div class="cal-cell cal-cell--out" aria-hidden="true">`
            + `<span class="cal-head"><span class="cal-num">${dOf(iso).getDate()}</span></span></div>`;
    }

    const r = data.rows.get(iso);
    const classes = ['cal-cell'];
    if (estWeekEnd(iso)) classes.push('cal-cell--we');
    if (!r) classes.push('cal-cell--empty');
    if (iso === T) classes.push('cal-cell--today');
    if (iso === state.sel) classes.push('is-sel');

    const v = valeur(iso, pivot.key);
    const fond = (r && v && max > 0)
        ? `<span class="cal-fill" style="background:${teinte(pivot.color, v / max)}"></span>` : '';

    let valeurHtml;
    if (!r) valeurHtml = `<span class="cal-val cal-val--none">non saisi</span>`;
    else if (v === null) valeurHtml = `<span class="cal-val cal-val--none">non mesuré</span>`;
    else valeurHtml = `<span class="cal-val${v === 0 ? ' cal-val--zero' : ''}">${fmtInt(v)}</span>`;

    /* En vue semaine, la case est cinq fois plus grande : tous les compteurs y
       tiennent en clair, y compris ceux à zéro. Les masquer ferait bouger les
       lignes d'un jour à l'autre et rendrait la lecture verticale impossible. */
    let lignes = '';
    if (state.vue === 'week' && r) {
        lignes = `<span class="cal-lines">` + compteurs.map(m => {
            const val = valeur(iso, m.key);
            const zero = val === 0 || val === null;
            return `<span class="cal-linerow${zero ? ' is-zero' : ''}">`
                + `<span>${escapeHtml(m.short)}</span>`
                + `<b>${val === null ? '—' : fmtInt(val)}</b></span>`;
        }).join('') + `</span>`;

        const prof = data.profs.get(iso);
        if (prof && prof.length) {
            lignes += `<span class="cal-week-profile">${escapeHtml(profileText(prof, { long: true }))}</span>`;
        }
    }

    const note = r && r.notes ? '<span class="cal-flag" aria-label="Note du jour">📝</span>' : '';

    return `<button type="button" class="${classes.join(' ')}" data-iso="${iso}"
                    aria-label="${escapeHtml(LONG.format(dOf(iso)))}">`
        + fond
        + `<span class="cal-head"><span class="cal-num">${dOf(iso).getDate()}</span>${note}</span>`
        + valeurHtml + lignes + bandeHtml(iso)
        + `</button>`;
}

function dessineGrille() {
    const jours = joursGrille(state);
    const { from, to } = bornesVue(state);
    const pivot = compteurs.find(m => m.key === state.pivot) || compteurs[0];

    /* L'intensité se rapporte au maximum de la période AFFICHÉE, pas à un
       maximum absolu : une échelle qui ne bouge jamais écraserait tous les mois
       calmes dans la même teinte pâle. La légende le dit, sinon le dégradé se
       lirait comme une note. */
    let max = 0;
    jours.forEach(j => {
        if (j < from || j > to) return;
        const v = valeur(j, pivot.key);
        if (v !== null && v > max) max = v;
    });

    $('#cal-dows').className = `cal-dows${state.vue === 'week' ? ' cal-dows--week' : ''}`;
    $('#cal-dows').innerHTML = DOWS.map(d => `<span>${d}</span>`).join('');
    $('#cal-grid').className = `cal-grid cal-grid--${state.vue === 'week' ? 'week' : 'month'}`;
    $('#cal-grid').innerHTML = jours
        .map(j => celluleHtml(j, { dansPeriode: j >= from && j <= to, pivot, max }))
        .join('');
}

function dessineEntete() {
    const { from, to } = bornesVue(state);
    const ouvres = joursOuvres(from, to);

    if (state.vue === 'week') {
        $('#cal-label').textContent = `Semaine du ${JOUR_MOIS.format(dOf(from))}`;
        $('#cal-sub').textContent = `du ${JOUR_MOIS.format(dOf(from))} au `
            + `${LONG.format(dOf(to)).replace(/^\w+ /, '')} · ${ouvres} jours ouvrés`;
    } else {
        $('#cal-label').textContent = MOIS_AN.format(dOf(from));
        $('#cal-sub').textContent = `${ouvres} jours ouvrés, fériés déduits`;
    }
}

function dessineSynthese() {
    const { from, to } = bornesVue(state);
    const pivot = compteurs.find(m => m.key === state.pivot) || compteurs[0];
    const ouvres = joursOuvres(from, to);

    let saisis = 0, saisisOuvres = 0, total = 0, mesures = 0;
    for (let j = from; j <= to; j = addDaysISO(j, 1)) {
        const r = data.rows.get(j);
        if (!r) continue;
        saisis++;
        if (!estWeekEnd(j)) saisisOuvres++;
        const v = valeur(j, pivot.key);
        if (v !== null) { total += v; mesures++; }
    }

    /* Une moyenne sur les jours saisis, jamais sur les jours du calendrier :
       diviser par trente un mois travaillé vingt jours donne un chiffre que
       personne ne reconnaît. Le libellé le dit en toutes lettres. */
    const moy = mesures ? total / mesures : null;
    const manquants = Math.max(0, ouvres - Math.min(saisisOuvres, ouvres));
    const passe = to > T ? T : to;
    const ouvresEcoules = passe >= from ? joursOuvres(from, passe) : 0;
    const trous = Math.max(0, ouvresEcoules - Math.min(saisisOuvres, ouvresEcoules));

    const stat = (val, lib, alerte = false) =>
        `<div class="cal-stat${alerte ? ' cal-stat--alert' : ''}"><b>${val}</b><span>${lib}</span></div>`;

    $('#cal-summary').innerHTML =
        stat(`${saisisOuvres} / ${ouvresEcoules}`,
             trous ? `jours ouvrés saisis · ${trous} manquant${trous > 1 ? 's' : ''}`
                   : 'jours ouvrés saisis à ce jour', trous > 0)
        + stat(fmtInt(total), `${escapeHtml(pivot.label.toLowerCase())} sur la période`)
        + stat(moy === null ? '—' : fmtInt(moy), 'par jour saisi, en moyenne')
        + (manquants !== trous
            ? stat(fmtInt(ouvres), 'jours ouvrés au total sur la période') : '');
}

function dessineDetail() {
    const iso = state.sel;
    const box = $('#cal-detail');
    const { from, to } = bornesVue(state);
    if (iso < from || iso > to) { box.innerHTML =
        `<p class="cal-detail-empty">Choisissez un jour dans la grille pour en voir le détail.</p>`;
        return; }

    const r = data.rows.get(iso);
    const prof = data.profs.get(iso);
    const lien = linkFor('index.html', viewedProfile() ? viewedProfile().user_id : null, { date: iso });
    const bouton = `<a class="cal-detail-open" href="./${escapeHtml(lien)}">`
        + `${r ? 'Ouvrir cette journée' : 'Saisir cette journée'}</a>`;

    const titre = `<div class="cal-detail-head"><h3>${escapeHtml(LONG.format(dOf(iso)))}</h3>`
        + (prof && prof.length
            ? `<span class="dp-tip">${prof.map(x => {
                    const m = PROFILE_BY_KIND[x.kind];
                    return `<span class="dp-dot" style="background:${m ? m.color : 'var(--gray-300)'}"></span>`;
               }).join('')}<span>${escapeHtml(profileText(prof, { long: true }))}</span></span>`
            : `<span class="cal-detail-empty">Profil non renseigné</span>`)
        + bouton + `</div>`;

    if (!r) {
        box.innerHTML = titre
            + `<p class="cal-detail-empty">Aucune saisie pour ce jour. Une case hachurée veut dire `
            + `que rien n'a jamais été enregistré, pas qu'il ne s'est rien passé.</p>`;
        return;
    }

    const valeurs = compteurs.map(m => {
        const v = valeur(iso, m.key);
        const zero = v === 0 || v === null;
        return `<div class="cal-valrow${zero ? ' is-zero' : ''}">`
            + `<span>${escapeHtml(m.label)}</span>`
            + `<b>${v === null ? '—' : fmtInt(v)}</b></div>`;
    }).join('');

    const pts = scoreOf(r);
    box.innerHTML = titre
        + `<div class="cal-values">${valeurs}`
        + `<div class="cal-valrow"><span>Score du jour</span><b>${fmtInt(pts)}</b></div></div>`
        + (r.notes ? `<div class="cal-detail-note">${escapeHtml(r.notes)}</div>` : '');
}

function dessineLegende() {
    const pivot = compteurs.find(m => m.key === state.pivot) || compteurs[0];
    const echelle = [0.1, 0.35, 0.6, 0.85, 1]
        .map(x => `<i style="background:${teinte(pivot.color, x)}"></i>`).join('');

    $('#cal-legend').innerHTML =
        `<span class="cal-legend-item">Fond&nbsp;: <span class="cal-legend-scale">${echelle}</span>`
        + ` de zéro au plus fort jour de la période</span>`
        + `<span class="cal-legend-item"><span class="cal-legend-box cal-cell--empty"></span>`
        + ` jamais saisi</span>`
        + `<span class="cal-legend-item"><b>0</b> saisi à zéro</span>`
        + `<span class="cal-legend-item">📝 note du jour</span>`
        + `<span class="cal-legend-item">La bande du bas donne le profil de la journée.</span>`;
}

function dessine() {
    dessineEntete();
    dessineSynthese();
    dessineGrille();
    dessineDetail();
    dessineLegende();
}

/* --------------------------------------------------------------------------
   DÉMARRAGE
   -------------------------------------------------------------------------- */

(async function init() {
    /* needs 'bdr' veut dire « cette page parle de l'activité de quelqu'un »,
       BDR comme commercial, exactement comme la page de saisie et la page
       Performances. Un responsable qui consulte un membre y a accès par
       l'exception d'api.js, et n'a donc pas de porte fermée au nez depuis la
       vue d'équipe. */
    await requireAuth({ needs: 'bdr' });
    renderNav();

    compteurs = metricsFor(viewedProfile());
    state.pivot = (compteurs.find(m => m.key === 'calls_made') || compteurs[0]).key;

    $('#cal-metric').innerHTML = compteurs
        .map(m => `<option value="${m.key}"${m.key === state.pivot ? ' selected' : ''}>`
            + `${escapeHtml(m.label)}</option>`).join('');

    if (isViewingOther()) {
        document.querySelector('.page-hero h1').innerHTML =
            `Retracer <em>sa semaine</em>`;
    }

    $('#cal-prev').addEventListener('click', () => {
        state.ancre = state.vue === 'week'
            ? addDaysISO(state.ancre, -7)
            : moisBornes(addDaysISO(moisBornes(state.ancre).from, -1)).from;
        charge();
    });

    $('#cal-next').addEventListener('click', () => {
        state.ancre = state.vue === 'week'
            ? addDaysISO(state.ancre, 7)
            : addDaysISO(moisBornes(state.ancre).to, 1);
        charge();
    });

    $('#cal-today').addEventListener('click', () => {
        state.ancre = T;
        state.sel = T;
        charge();
    });

    document.querySelectorAll('#seg-vue button').forEach(b =>
        b.addEventListener('click', () => {
            state.vue = b.dataset.vue;
            document.querySelectorAll('#seg-vue button')
                .forEach(x => x.classList.toggle('is-on', x === b));
            charge();
        }));

    /* Changer de compteur ne relit rien : la donnée du mois est déjà là, toutes
       colonnes comprises. */
    $('#cal-metric').addEventListener('change', e => {
        state.pivot = e.target.value;
        dessine();
    });

    /* Un clic sélectionne, il ne navigue pas. La navigation passe par le bouton
       du panneau : sur un calendrier, un clic qui change de page fait perdre sa
       place à chaque fois qu'on voulait juste regarder. */
    $('#cal-grid').addEventListener('click', ev => {
        const cell = ev.target.closest('.cal-cell[data-iso]');
        if (!cell) return;
        state.sel = cell.dataset.iso;
        dessineGrille();
        dessineDetail();
    });

    await charge();
    hideVeil();
})();
