/* ==========================================================================
   OBJECTIFS.JS — le volet « Objectifs » de l'écran Barème et objectifs.

   Module à part et non un ajout à js/bareme.js, qui fait déjà 29 Ko et qu'un
   autre chantier peut toucher en parallèle. bareme.js ne gagne que six lignes,
   le temps d'ouvrir le volet et d'appeler initObjectifs() une fois.

   CE QUE CET ÉCRAN RÈGLE, ET POURQUOI IL EXISTE

   Les objectifs étaient journaliers et réglés par chacun. Au 26 août, Dominique
   avait mis zéro partout, Santiago aussi. Les deux avaient éteint leurs jauges,
   et ils avaient raison : un objectif journalier de rendez-vous n'a pas de sens
   pour un BDR, un jour sans rendez-vous est un jour normal, et une jauge à 0 %
   chaque soir ne dit rien d'autre que « ignore-moi ». Ce que Dominique suit,
   c'est un nombre de rendez-vous dans le mois.

   D'où trois échelles, et une main unique sur les valeurs.

   QUATRE PARTIS PRIS

   1. UN CHAMP VIDE N'EST PAS UN ZÉRO. Vide veut dire « pas d'objectif », donc
      aucune jauge. Zéro veut dire « ne rien faire est l'attente ». Ce sont deux
      phrases différentes et l'écran ne les confond jamais : vider un champ
      appelle clearTarget, taper 0 appelle setTarget avec 0.

   2. RIEN N'EST DÉDUIT AUTOMATIQUEMENT. Le bouton « déduire de l'objectif
      mensuel » remplit les champs, il n'enregistre pas. Un objectif calculé et
      écrit dans le dos de Bruno serait présenté à l'équipe comme une attente,
      alors que personne ne l'aurait décidé.

   3. L'ENREGISTREMENT NE TOUCHE QUE CE QUI A CHANGÉ. On compare champ par champ
      à ce que la base contient, et on n'appelle la base que sur les écarts.
      Réécrire les treize valeurs à chaque fois ferait remonter treize
      horodatages identiques, et l'historique de « qui a changé quoi et quand »
      ne servirait plus à rien.

   4. LES CHAMPS SONT CONSTRUITS DEPUIS METRICS, jamais écrits dans le HTML. Une
      treizième métrique apparaîtra ici toute seule le jour où elle existera.
   ========================================================================== */

import {
    METRICS, TARGET_SCALES, TARGET_JOBS,
    loadTargets, targetsLoaded, jobTargets, userTargets, targetJobOf,
    setTarget, clearTarget, humanError,
    listProfiles, todayISO, joursOuvres, fromISO, toISO
} from './api.js';
import { escapeHtml, toast, fmtInt } from './ui.js';

let jobKey = 'bdr';        // métier affiché
let scaleKey = 'month';    // échelle affichée : le mois d'abord, c'est la demande
let whoId = '';            // personne de la section « objectif personnel »
let profils = [];          // ceux qui saisissent quelque chose
let pret = false;          // initObjectifs n'a de sens qu'une fois

/* Le mois est l'échelle d'ouverture, et non le jour. C'est l'échelle qui a
   déclenché ce lot, et celle qui a du sens pour la moitié de l'équipe. */

/* --------------------------------------------------------------------------
   Aides
   -------------------------------------------------------------------------- */

/** Les métriques réglables pour un métier : celles qui ont un objectif. */
function metriquesDe(job) {
    return METRICS.filter(m => m.target && m.jobs.includes(job));
}

/** Premier et dernier jour du mois qui contient une date ISO. */
function bornesDuMois(iso) {
    const d = fromISO(iso);
    const debut = new Date(d.getFullYear(), d.getMonth(), 1);
    const fin = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return [toISO(debut), toISO(fin)];
}

/** Jours ouvrés du mois en cours, base des valeurs déduites. */
function ouvresDuMois() {
    const [de, a] = bornesDuMois(todayISO());
    return joursOuvres(de, a);
}

/** Valeur d'un champ : null quand il est vide, sinon un entier positif. */
function lireChamp(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const brut = String(el.value).trim();
    if (brut === '') return null;
    const n = parseInt(brut, 10);
    if (Number.isNaN(n) || n < 0) return null;
    return n;
}

/* --------------------------------------------------------------------------
   Les deux sélecteurs
   -------------------------------------------------------------------------- */

function renderSegs() {
    document.getElementById('obj-job-seg').innerHTML = TARGET_JOBS.map(j => `
        <button type="button" data-job="${j.key}" class="${j.key === jobKey ? 'is-on' : ''}"
                aria-pressed="${j.key === jobKey ? 'true' : 'false'}">${escapeHtml(j.label)}</button>`).join('');

    document.getElementById('obj-scale-seg').innerHTML = TARGET_SCALES.map(sc => `
        <button type="button" data-scale="${sc.key}" class="${sc.key === scaleKey ? 'is-on' : ''}"
                aria-pressed="${sc.key === scaleKey ? 'true' : 'false'}">${escapeHtml(sc.label)}</button>`).join('');
}

/* --------------------------------------------------------------------------
   Objectifs du métier
   -------------------------------------------------------------------------- */

function renderJobGrid() {
    const metriques = metriquesDe(jobKey);
    const actuels = jobTargets(jobKey, scaleKey);

    /* Les valeurs des deux autres échelles sont rappelées sous chaque champ.
       Sans ce rappel, on fixe 18 rendez-vous par mois en oubliant qu'un
       objectif journalier de 2 traîne encore, et les deux jauges racontent
       alors deux histoires différentes de la même semaine. */
    const autres = {};
    TARGET_SCALES.forEach(sc => { autres[sc.key] = jobTargets(jobKey, sc.key); });

    document.getElementById('obj-grid').innerHTML = `
        <div class="obj-grid">
            ${metriques.map(m => {
                const v = actuels[m.key];
                const rappel = TARGET_SCALES.filter(sc => sc.key !== scaleKey).map(sc => {
                    const x = autres[sc.key][m.key];
                    return `${sc.court} ${x == null ? '—' : fmtInt(x)}`;
                }).join(' · ');
                return `
                <div class="obj-cell">
                    <label class="obj-lab" for="oj-${m.key}">${escapeHtml(m.short)}</label>
                    <input class="obj-input" type="number" min="0" step="1" id="oj-${m.key}"
                           inputmode="numeric" placeholder="pas d'objectif"
                           value="${v == null ? '' : v}">
                    <div class="obj-hint">${escapeHtml(rappel)}</div>
                </div>`;
            }).join('')}
        </div>`;

    // Le bouton de déduction n'a de sens que sur les échelles qui se déduisent.
    const bouton = document.getElementById('obj-derive');
    bouton.hidden = scaleKey === 'month';
    if (!bouton.hidden) {
        const n = ouvresDuMois();
        bouton.textContent = scaleKey === 'day'
            ? `Déduire du mensuel (${n} jours ouvrés ce mois)`
            : `Déduire du mensuel (${n} jours ouvrés ce mois, semaine de 5)`;
    }
}

/** Remplit les champs à partir du mensuel, sans rien enregistrer. */
function deriver() {
    const mensuels = jobTargets(jobKey, 'month');
    const n = ouvresDuMois();
    if (!n) return;
    let touche = 0;
    metriquesDe(jobKey).forEach(m => {
        const mois = mensuels[m.key];
        const el = document.getElementById(`oj-${m.key}`);
        if (!el) return;
        if (mois == null) { el.value = ''; return; }
        const val = scaleKey === 'day'
            ? Math.round(mois / n)
            : Math.round((mois / n) * 5);
        el.value = String(val);
        touche++;
    });
    const statut = document.getElementById('obj-status');
    statut.style.color = '';
    statut.textContent = touche
        ? `${touche} valeur${touche > 1 ? 's' : ''} proposée${touche > 1 ? 's' : ''} `
          + "d'après le mensuel. Rien n'est enregistré : relisez, corrigez, puis enregistrez."
        : "Aucun objectif mensuel n'est posé pour ce métier : il n'y a rien à déduire.";
}

async function saveJob() {
    const statut = document.getElementById('obj-status');
    const actuels = jobTargets(jobKey, scaleKey);
    const travaux = [];

    metriquesDe(jobKey).forEach(m => {
        const avant = actuels[m.key];
        const apres = lireChamp(`oj-${m.key}`);
        if (apres === avant) return;                     // rien n'a bougé
        if (apres === null) {
            travaux.push({ quoi: 'retire', metric: m.key });
        } else {
            travaux.push({ quoi: 'pose', metric: m.key, value: apres });
        }
    });

    if (!travaux.length) {
        statut.style.color = '';
        statut.textContent = 'Rien n\'a changé.';
        return;
    }

    statut.style.color = '';
    statut.textContent = 'Enregistrement…';
    try {
        // En série et non en parallèle : treize appels simultanés sur le plan
        // gratuit se font parfois refuser, et une écriture partielle serait
        // impossible à raconter à l'utilisateur.
        for (const t of travaux) {
            if (t.quoi === 'pose') {
                await setTarget({ scope: 'job', job: jobKey, scale: scaleKey,
                                  metric: t.metric, value: t.value });
            } else {
                await clearTarget({ scope: 'job', job: jobKey, scale: scaleKey,
                                    metric: t.metric });
            }
        }
        await loadTargets();
        renderJobGrid();
        renderUserGrid();
        statut.style.color = 'var(--success)';
        const poses = travaux.filter(t => t.quoi === 'pose').length;
        const retires = travaux.length - poses;
        statut.textContent = [
            poses ? `${poses} objectif${poses > 1 ? 's' : ''} enregistré${poses > 1 ? 's' : ''}` : '',
            retires ? `${retires} retiré${retires > 1 ? 's' : ''}` : ''
        ].filter(Boolean).join(', ') + '.';
        toast('Objectifs du métier mis à jour.', 'success');
    } catch (e) {
        statut.style.color = 'var(--danger)';
        statut.textContent = humanError(e);
    }
}

/* --------------------------------------------------------------------------
   Objectif personnel

   Le placeholder de chaque champ montre la valeur du métier : c'est ce qui
   s'appliquera si on laisse vide. Sans ce repère, on saisit une exception sans
   savoir à quoi on fait exception.
   -------------------------------------------------------------------------- */

function renderWho() {
    const sel = document.getElementById('obj-who');
    sel.innerHTML = profils.map(p => {
        const job = targetJobOf(p);
        const suffixe = job === 'sales' ? 'commercial' : job === 'bdr' ? 'BDR' : 'sans métier';
        return `<option value="${p.user_id}"${p.user_id === whoId ? ' selected' : ''}>`
             + `${escapeHtml(p.display_name)} (${suffixe})</option>`;
    }).join('');
    if (!whoId && profils.length) whoId = profils[0].user_id;
}

function renderUserGrid() {
    const cible = profils.find(p => p.user_id === whoId);
    const zone = document.getElementById('obj-user-grid');
    if (!cible) { zone.innerHTML = '<p class="obj-none">Aucun profil à afficher.</p>'; return; }

    const job = targetJobOf(cible);
    if (!job) {
        zone.innerHTML = `<p class="obj-none">${escapeHtml(cible.display_name)} n'est ni BDR ni `
                       + 'commercial : aucun objectif ne s\'applique, et lui en poser un '
                       + 'n\'afficherait aucune jauge.</p>';
        return;
    }

    const perso = userTargets(whoId, scaleKey);
    const metier = jobTargets(job, scaleKey);

    zone.innerHTML = `
        <div class="obj-grid">
            ${metriquesDe(job).map(m => {
                const v = perso[m.key];
                const d = metier[m.key];
                return `
                <div class="obj-cell${v != null ? ' obj-cell--perso' : ''}">
                    <label class="obj-lab" for="ou-${m.key}">${escapeHtml(m.short)}</label>
                    <input class="obj-input" type="number" min="0" step="1" id="ou-${m.key}"
                           inputmode="numeric"
                           placeholder="${d == null ? 'pas d\'objectif' : fmtInt(d)}"
                           value="${v == null ? '' : v}">
                    <div class="obj-hint">${d == null
                        ? 'le métier n\'en a pas'
                        : `métier ${fmtInt(d)}`}${v != null ? ' · exception en place' : ''}</div>
                </div>`;
            }).join('')}
        </div>`;
}

async function saveUser() {
    const statut = document.getElementById('obj-user-status');
    const cible = profils.find(p => p.user_id === whoId);
    const job = cible ? targetJobOf(cible) : null;
    if (!job) return;

    const actuels = userTargets(whoId, scaleKey);
    const travaux = [];
    metriquesDe(job).forEach(m => {
        const avant = actuels[m.key];
        const apres = lireChamp(`ou-${m.key}`);
        if (apres === avant) return;
        travaux.push(apres === null
            ? { quoi: 'retire', metric: m.key }
            : { quoi: 'pose', metric: m.key, value: apres });
    });

    if (!travaux.length) {
        statut.style.color = '';
        statut.textContent = 'Rien n\'a changé.';
        return;
    }

    statut.style.color = '';
    statut.textContent = 'Enregistrement…';
    try {
        for (const t of travaux) {
            if (t.quoi === 'pose') {
                await setTarget({ scope: 'user', userId: whoId, scale: scaleKey,
                                  metric: t.metric, value: t.value });
            } else {
                await clearTarget({ scope: 'user', userId: whoId, scale: scaleKey,
                                    metric: t.metric });
            }
        }
        await loadTargets();
        renderUserGrid();
        statut.style.color = 'var(--success)';
        const retires = travaux.filter(t => t.quoi === 'retire').length;
        statut.textContent = retires === travaux.length
            ? `${cible.display_name} suit à nouveau les objectifs de son métier.`
            : `Objectif personnel de ${cible.display_name} mis à jour.`;
        toast('Objectif personnel mis à jour.', 'success');
    } catch (e) {
        statut.style.color = 'var(--danger)';
        statut.textContent = humanError(e);
    }
}

/* --------------------------------------------------------------------------
   Démarrage du volet
   -------------------------------------------------------------------------- */

function repeindre() {
    renderSegs();
    renderJobGrid();
    renderUserGrid();
}

/**
 * Appelé une seule fois, à la première ouverture du volet. Rien n'est chargé
 * avant : quelqu'un qui vient régler le barème n'a pas à attendre la liste des
 * profils.
 */
export async function initObjectifs() {
    if (pret) return;
    pret = true;

    const ok = await loadTargets();
    if (!ok || !targetsLoaded()) {
        document.getElementById('obj-grid').innerHTML =
            '<p class="obj-none">Les objectifs n\'ont pas pu être lus. La migration '
          + 'sql/targets-migration-v12.sql n\'est peut-être pas passée : rien d\'autre '
          + 'dans l\'application n\'est affecté, mais cet écran ne peut rien afficher.</p>';
        return;
    }

    try {
        const tous = await listProfiles();
        // Ceux qui ne saisissent rien n'ont pas d'objectif à recevoir.
        profils = (tous || []).filter(p => p.is_bdr || p.is_sales)
            .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name), 'fr'));
    } catch (e) {
        profils = [];
        toast(humanError(e), 'error');
    }

    renderWho();
    repeindre();

    document.getElementById('obj-job-seg').addEventListener('click', ev => {
        const b = ev.target.closest('button[data-job]');
        if (!b || b.dataset.job === jobKey) return;
        jobKey = b.dataset.job;
        repeindre();
    });

    document.getElementById('obj-scale-seg').addEventListener('click', ev => {
        const b = ev.target.closest('button[data-scale]');
        if (!b || b.dataset.scale === scaleKey) return;
        scaleKey = b.dataset.scale;
        repeindre();
    });

    document.getElementById('obj-who').addEventListener('change', ev => {
        whoId = ev.target.value;
        renderUserGrid();
    });

    document.getElementById('obj-save').addEventListener('click', saveJob);
    document.getElementById('obj-derive').addEventListener('click', deriver);
    document.getElementById('obj-user-save').addEventListener('click', saveUser);
}
