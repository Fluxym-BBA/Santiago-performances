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

   5. LE DÉFAUT DU MÉTIER EST DÉJÀ RÉTROACTIF, MAIS PAS VISIBLEMENT (ajouté le
      27/08). Il s'applique à qui n'a pas d'exception personnelle, donc à
      Santiago et Dominique dès sa première écriture. Ce qui trompait, c'est que
      la migration v12 a converti les anciens réglages individuels de Christophe,
      Damien et des trois comptes de démonstration en exceptions : sept valeurs
      posées à leur nom qui l'emportent sur tout défaut, sans que l'écran du
      métier le dise. Le bloc « ces personnes ne suivent pas ce défaut » le dit
      maintenant, et le bouton efface les exceptions plutôt que d'y recopier le
      défaut. Recopier serait rétroactif une fois puis figé, et le prochain
      changement de défaut ne toucherait plus personne.
   ========================================================================== */

import {
    METRICS, TARGET_SCALES, TARGET_JOBS,
    loadTargets, targetsLoaded, jobTargets, userTargets, targetJobOf,
    setTarget, clearTarget, applyJobTargets, humanError,
    listProfiles, todayISO, joursOuvres, fromISO, toISO,
    loadVisibility, visibilityLoaded, jobVisibility, userVisibility,
    setVisibility, removeVisibility, clearUserVisibility, clearVisibilityExceptions,
    visibilityExceptionUsers
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
    /* !m.hidden écarte les sous-totaux que la page de saisie n'affiche pas.
       Depuis la v14, calls_engaged est la somme des deux compteurs d'échange :
       proposer d'y poser un objectif ferait miroiter une jauge qui n'existe
       nulle part, et un objectif que personne ne verrait jamais. */
    return METRICS.filter(m => m.target && !m.hidden && m.jobs.includes(job));
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

/** « Damien », « Damien et Christophe », « Damien, Christophe et Sales 1 ». */
function enumere(noms) {
    if (noms.length <= 1) return noms[0] || '';
    return noms.slice(0, -1).join(', ') + ' et ' + noms[noms.length - 1];
}

/**
 * Les personnes du métier affiché qui portent au moins une exception
 * personnelle sur l'échelle affichée, et que le défaut ne touche donc pas.
 *
 * Le tri des métiers reproduit celui de la base (apply_job_targets) : commercial
 * l'emporte sur BDR, ce que targetJobOf fait déjà. Si les deux définitions
 * divergeaient un jour, l'écran annoncerait un nombre et la base en effacerait
 * un autre.
 */
function exceptions(job, scale) {
    return profils.filter(p => {
        if (targetJobOf(p) !== job) return false;
        const perso = userTargets(p.user_id, scale);
        return Object.values(perso).some(v => v != null);
    });
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

    /* L'affichage de la jauge ne dépend pas de l'échelle : une seule valeur par
       compteur, la même sur les trois onglets. */
    const vis = jobVisibility(jobKey);

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
                    ${!visibilityLoaded() ? '' : `
                    <label class="obj-vis" for="vj-${m.key}">
                        <input type="checkbox" id="vj-${m.key}" data-vis-job="${m.key}"
                               ${vis[m.key] === false ? '' : 'checked'}>
                        <span>jauge affichée</span>
                    </label>`}
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

/* --------------------------------------------------------------------------
   « Qui ne suit pas ce défaut », et le bouton qui règle la question
   -------------------------------------------------------------------------- */

function renderApply() {
    const boite = document.getElementById('obj-apply-box');
    const texte = document.getElementById('obj-apply-txt');
    const bouton = document.getElementById('obj-apply');
    const hors = exceptions(jobKey, scaleKey);
    const sc = TARGET_SCALES.find(x => x.key === scaleKey);

    if (!hors.length) {
        boite.hidden = false;
        boite.classList.remove('obj-apply--warn');
        texte.textContent = `Tout le monde suit ce défaut ${sc.article} : `
            + `aucun objectif personnel ne l'emporte sur ces valeurs.`;
        bouton.hidden = true;
        return;
    }

    boite.hidden = false;
    boite.classList.add('obj-apply--warn');
    const noms = enumere(hors.map(p => p.display_name));
    const pluriel = hors.length > 1;
    texte.textContent = `${noms} ${pluriel ? 'ont' : 'a'} un objectif personnel `
        + `${sc.article} qui l'emporte sur ce défaut. Ce que vous réglez ici ne `
        + `${pluriel ? 'les' : 'le'} concerne donc pas.`;
    bouton.hidden = false;
    bouton.textContent = pluriel
        ? `Aligner ces ${hors.length} personnes sur le défaut`
        : `Aligner ${hors[0].display_name} sur le défaut`;
}

/**
 * Efface les exceptions personnelles du métier affiché sur l'échelle affichée.
 *
 * La confirmation nomme les personnes et dit ce que l'opération ne fait pas :
 * elle ne touche ni les autres échelles, ni l'autre métier, ni la moindre donnée
 * d'activité. C'est irréversible — les valeurs personnelles ne sont pas
 * archivées ailleurs — et la confirmation le dit aussi.
 */
async function appliquer() {
    const statut = document.getElementById('obj-status');
    const hors = exceptions(jobKey, scaleKey);
    if (!hors.length) return;

    const sc = TARGET_SCALES.find(x => x.key === scaleKey);
    const metier = TARGET_JOBS.find(x => x.key === jobKey);
    const noms = hors.map(p => '  · ' + p.display_name).join('\n');
    const ok = confirm(
        `Aligner sur le défaut ${metier.label} ${sc.article} :\n\n${noms}\n\n`
        + `Leurs objectifs personnels ${sc.article} sont supprimés. Ils suivront `
        + `le défaut du métier, maintenant et à chaque fois que vous le changerez.\n\n`
        + `Les autres échelles ne bougent pas. Aucune donnée d'activité n'est touchée.\n\n`
        + `Cette suppression est définitive.`
    );
    if (!ok) return;

    statut.style.color = '';
    statut.textContent = 'Application…';
    try {
        const n = await applyJobTargets(jobKey, scaleKey);
        await loadTargets();
        repeindre();
        statut.style.color = 'var(--success)';
        statut.textContent = n
            ? `${n} valeur${n > 1 ? 's' : ''} personnelle${n > 1 ? 's' : ''} `
              + `supprimée${n > 1 ? 's' : ''}. ${hors.length > 1 ? 'Ces personnes suivent' : 'Cette personne suit'} `
              + 'à nouveau le défaut du métier.'
            : "Aucune valeur à supprimer : l'écran était déjà à jour.";
        toast('Objectifs personnels alignés sur le métier.', 'success');
    } catch (e) {
        statut.style.color = 'var(--danger)';
        statut.textContent = humanError(e);
    }
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
        renderApply();
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

    /* Trois états et non deux : « suit le métier » n'est pas la même chose que
       « affiché ». Une case à cocher les aurait confondus, et le jour où le
       défaut du métier change, seule la première suit. */
    const visPerso = userVisibility(whoId);
    const visMetier = jobVisibility(job);

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
                    ${!visibilityLoaded() ? '' : `
                    <select class="obj-vis-sel" data-vis-user="${m.key}"
                            aria-label="Affichage de la jauge : ${escapeHtml(m.short)}">
                        <option value=""${visPerso[m.key] === undefined ? ' selected' : ''}>
                            suit le métier (${visMetier[m.key] === false ? 'masquée' : 'affichée'})
                        </option>
                        <option value="1"${visPerso[m.key] === true ? ' selected' : ''}>jauge affichée</option>
                        <option value="0"${visPerso[m.key] === false ? ' selected' : ''}>jauge masquée</option>
                    </select>`}
                </div>`;
            }).join('')}
        </div>`;
}

/**
 * Vide les champs de la fiche personnelle, sans rien enregistrer.
 *
 * Volontairement sans effet sur la base : c'est le parti pris n° 2 de cet écran.
 * Le bouton propose, l'enregistrement décide. Une personne rendue au défaut de
 * son métier dans son dos, sans que Bruno ait cliqué sur « Enregistrer », serait
 * exactement le genre de changement silencieux qu'on refuse ici.
 */
function suivreLeMetier() {
    const cible = profils.find(p => p.user_id === whoId);
    const job = cible ? targetJobOf(cible) : null;
    if (!job) return;
    let vides = 0;
    metriquesDe(job).forEach(m => {
        const el = document.getElementById(`ou-${m.key}`);
        if (el && el.value !== '') { el.value = ''; vides++; }
    });
    const statut = document.getElementById('obj-user-status');
    statut.style.color = '';
    statut.textContent = vides
        ? `${vides} champ${vides > 1 ? 's' : ''} vidé${vides > 1 ? 's' : ''}. `
          + "Rien n'est enregistré : cliquez sur « Enregistrer » pour que "
          + `${cible.display_name} suive les objectifs de son métier.`
        : `${cible.display_name} suit déjà les objectifs de son métier.`;
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
        renderApply();
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

/* --------------------------------------------------------------------------
   AFFICHER OU MASQUER LES JAUGES (v16)

   POURQUOI CES RÉGLAGES S'ENREGISTRENT AU CLIC, alors que les valeurs attendent
   le bouton « Enregistrer ». Une valeur d'objectif se réfléchit, se compare aux
   autres échelles, se corrige avant d'être publiée : la retenir jusqu'au clic
   final a du sens. Un affichage de jauge n'a pas d'état intermédiaire, et
   surtout il ne dépend PAS de l'échelle : le retenir aurait perdu le réglage
   sans un mot dès qu'on passe de l'onglet Mois à l'onglet Semaine, qui redessine
   la grille.
   -------------------------------------------------------------------------- */

/** Le défaut d'affichage d'un métier. */
async function basculeVisJob(metric, affichee) {
    const statut = document.getElementById('obj-status');
    try {
        await setVisibility({ scope: 'job', job: jobKey, metric, visible: affichee });
        statut.style.color = '';
        statut.textContent = `Jauge ${affichee ? 'affichée' : 'masquée'} par défaut pour `
            + `${jobKey === 'bdr' ? 'les BDR' : 'les commerciaux'}. `
            + 'Les personnes qui ont leur propre réglage gardent le leur.';
        renderVisForce();
        renderUserGrid();
    } catch (e) {
        statut.style.color = 'var(--danger)';
        statut.textContent = humanError(e);
        renderJobGrid();      // remet la case sur ce que dit vraiment la base
    }
}

/** Le réglage d'une personne : suit le métier, forcé affiché, forcé masqué. */
async function basculeVisUser(metric, valeur) {
    const statut = document.getElementById('obj-user-status');
    const cible = profils.find(p => p.user_id === whoId);
    if (!cible) return;
    try {
        if (valeur === '') {
            await removeVisibility({ scope: 'user', userId: whoId, metric });
            statut.textContent = `${cible.display_name} suit de nouveau son métier sur ce compteur.`;
        } else {
            await setVisibility({ scope: 'user', userId: whoId, metric, visible: valeur === '1' });
            statut.textContent = `Jauge ${valeur === '1' ? 'affichée' : 'masquée'} pour `
                + `${cible.display_name}, quoi que fasse son métier.`;
        }
        statut.style.color = '';
        renderUserGrid();
        renderVisForce();
    } catch (e) {
        statut.style.color = 'var(--danger)';
        statut.textContent = humanError(e);
        renderUserGrid();
    }
}

/**
 * Le bouton de forçage ne s'affiche que s'il a quelque chose à faire, et il dit
 * combien de personnes il va toucher : « forcer » sans savoir sur qui, c'est le
 * genre de bouton qu'on ne clique jamais.
 */
function renderVisForce() {
    const bouton = document.getElementById('obj-vis-force');
    if (!bouton) return;
    if (!visibilityLoaded()) {
        bouton.hidden = true;
        const r = document.getElementById('obj-user-vis-reset');
        if (r) r.hidden = true;
        return;
    }
    const concernes = visibilityExceptionUsers()
        .map(id => profils.find(p => p.user_id === id))
        .filter(p => p && targetJobOf(p) === jobKey);
    bouton.hidden = concernes.length === 0;
    if (!bouton.hidden) {
        bouton.textContent = `Forcer l'affichage à ${concernes.length} personne`
            + `${concernes.length > 1 ? 's' : ''} (${enumere(concernes.map(p => p.display_name))})`;
    }

    const reset = document.getElementById('obj-user-vis-reset');
    if (reset) reset.hidden = Object.keys(userVisibility(whoId)).length === 0;
}

/** Efface les choix d'affichage de tout un métier. */
async function forcerAffichage() {
    const statut = document.getElementById('obj-status');
    const quoi = jobKey === 'bdr' ? 'des BDR' : 'des commerciaux';
    if (!confirm(`Effacer les choix d'affichage personnels ${quoi} ?\n\n`
        + 'Tout le monde revient au réglage ci-dessus, et suivra aussi les prochains.')) return;
    try {
        const n = await clearVisibilityExceptions(jobKey);
        await loadVisibility();
        statut.style.color = '';
        statut.textContent = `${n} réglage${n > 1 ? 's' : ''} personnel${n > 1 ? 's' : ''} `
            + `effacé${n > 1 ? 's' : ''}.`;
        repeindre();
    } catch (e) {
        statut.style.color = 'var(--danger)';
        statut.textContent = humanError(e);
    }
}

/** Rend une personne au défaut d'affichage de son métier. */
async function retablirAffichage() {
    const statut = document.getElementById('obj-user-status');
    const cible = profils.find(p => p.user_id === whoId);
    if (!cible) return;
    try {
        const n = await clearUserVisibility(whoId);
        statut.style.color = '';
        statut.textContent = `${n} réglage${n > 1 ? 's' : ''} effacé${n > 1 ? 's' : ''} : `
            + `${cible.display_name} suit l'affichage de son métier.`;
        renderUserGrid();
        renderVisForce();
    } catch (e) {
        statut.style.color = 'var(--danger)';
        statut.textContent = humanError(e);
    }
}

function repeindre() {
    renderSegs();
    renderJobGrid();
    renderApply();
    renderUserGrid();
    renderVisForce();
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

    /* L'affichage des jauges est facultatif : si la table n'est pas là, l'écran
       reste utilisable pour les valeurs et les réglages d'affichage disparaissent
       plutôt que d'afficher des cases qui ne répondraient pas. */
    await loadVisibility();

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
        renderVisForce();
    });

    /* Délégation plutôt qu'un écouteur par case : les grilles sont redessinées à
       chaque changement d'échelle, de métier ou de personne, et rebrancher
       treize écouteurs à chaque fois finit par en laisser traîner. */
    document.getElementById('obj-grid').addEventListener('change', ev => {
        const c = ev.target.closest('[data-vis-job]');
        if (c) basculeVisJob(c.dataset.visJob, c.checked);
    });

    document.getElementById('obj-user-grid').addEventListener('change', ev => {
        const sel = ev.target.closest('[data-vis-user]');
        if (sel) basculeVisUser(sel.dataset.visUser, sel.value);
    });

    document.getElementById('obj-vis-force').addEventListener('click', forcerAffichage);
    document.getElementById('obj-user-vis-reset').addEventListener('click', retablirAffichage);

    document.getElementById('obj-save').addEventListener('click', saveJob);
    document.getElementById('obj-derive').addEventListener('click', deriver);
    document.getElementById('obj-apply').addEventListener('click', appliquer);
    document.getElementById('obj-user-save').addEventListener('click', saveUser);
    document.getElementById('obj-user-follow').addEventListener('click', suivreLeMetier);
}
