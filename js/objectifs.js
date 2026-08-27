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
    fiscalBounds, fiscalStartMonth, saveSettings, knownMonths, canWriteAny, myProfile,
    fmtCible, cibleChamp, lireCible, auDixieme, TARGET_MAX,
    loadVisibility, visibilityLoaded, jobVisibility, userVisibility,
    setVisibility, removeVisibility, clearUserVisibility, clearVisibilityExceptions,
    visibilityExceptionUsers
} from './api.js';
import { escapeHtml, toast } from './ui.js';

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

/**
 * Ce qu'il y a dans un champ d'objectif, tel que la base l'acceptera.
 *
 * Renvoie l'objet de lireCible ({ etat, value, arrondi }), augmenté du champ
 * lui-même et de ce qui y a été tapé, pour que l'appelant puisse nommer le
 * coupable et corriger l'affichage.
 *
 * CE QUI A CHANGÉ EN v18, ET POURQUOI C'EST IMPORTANT. L'ancienne version
 * renvoyait null aussi bien pour « champ vide » que pour « je n'y comprends
 * rien » : un « 4O » avec un O majuscule effaçait donc l'objectif sans un mot.
 * Les deux cas sont maintenant distincts, et l'enregistrement refuse de partir
 * tant qu'un champ est illisible.
 */
function lireChamp(id) {
    const el = document.getElementById(id);
    if (!el) return { etat: 'vide', value: null, arrondi: false, el: null, brut: '' };
    const brut = String(el.value);
    return { ...lireCible(brut), el, brut: brut.trim() };
}

/**
 * Relit tous les champs d'une grille et sépare le bon grain de l'ivraie.
 *
 * Les valeurs arrondies sont RÉÉCRITES dans leur champ au passage : celui qui a
 * tapé 2,55 doit voir 2,6 apparaître sous ses yeux, pas le découvrir au
 * rechargement de la page. Une valeur changée en silence est une valeur qu'on
 * ne s'explique plus six mois après.
 */
function lireGrille(prefixe, metriques) {
    const lues = {};
    const fautes = [];
    const arrondies = [];
    metriques.forEach(m => {
        const lu = lireChamp(`${prefixe}${m.key}`);
        const mauvais = lu.etat === 'illisible' || lu.etat === 'trop';
        // Le liseré rouge est reposé à chaque lecture, jamais accumulé : un champ
        // corrigé le perd sans qu'on ait à se souvenir de l'avoir mis.
        if (lu.el) lu.el.classList.toggle('obj-input--ko', mauvais);
        if (mauvais) { fautes.push({ m, lu }); return; }
        if (lu.arrondi && lu.el) {
            lu.el.value = cibleChamp(lu.value);
            arrondies.push({ m, lu });
        }
        lues[m.key] = lu.value;
    });
    return { lues, fautes, arrondies };
}

/** La phrase qui explique un champ refusé, sans jargon. */
function phraseFautes(fautes) {
    const dire = f => f.lu.etat === 'trop'
        ? `« ${f.m.short} » dépasse le maximum de ${fmtCible(TARGET_MAX)}`
        : `« ${f.m.short} » ne se lit pas comme un nombre (« ${f.lu.brut} »)`;
    return fautes.map(dire).join(', ')
        + '. Un nombre positif, avec au plus un chiffre après la virgule, '
        + 'point ou virgule au choix. Rien n\'a été enregistré.';
}

/** La phrase qui annonce les arrondis, quand il y en a. */
function phraseArrondis(arrondies) {
    if (!arrondies.length) return '';
    const dire = a => `${a.m.short} → ${fmtCible(a.lu.value)}`;
    return ` ${arrondies.length} valeur${arrondies.length > 1 ? 's' : ''} `
         + `arrondie${arrondies.length > 1 ? 's' : ''} au dixième (${arrondies.map(dire).join(', ')}).`;
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
                    return `${sc.court} ${x == null ? '—' : fmtCible(x)}`;
                }).join(' · ');
                return `
                <div class="obj-cell">
                    <label class="obj-lab" for="oj-${m.key}">${escapeHtml(m.short)}</label>
                    <input class="obj-input" type="text" id="oj-${m.key}"
                           inputmode="decimal" placeholder="pas d'objectif"
                           autocomplete="off" spellcheck="false"
                           value="${cibleChamp(v)}">
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

    /* Le bouton de déduction part de l'échelle la plus large qui soit renseignée.
       Depuis la v17 c'est l'exercice quand il est posé, et c'est le sens de la
       demande : les objectifs sont décidés à l'année, le reste en découle. Sur
       l'onglet Année lui-même il n'y a rien au-dessus, donc rien à déduire. */
    const bouton = document.getElementById('obj-derive');
    const src = sourceDeDeduction();
    bouton.hidden = !src;
    if (!bouton.hidden) {
        bouton.textContent = src === 'year'
            ? `Déduire de l'annuel (${ouvresExercice()} jours ouvrés dans l'exercice)`
            : `Déduire du mensuel (${ouvresDuMois()} jours ouvrés ce mois)`;
    }
}

/** Jours ouvrés de l'exercice qui contient aujourd'hui. */
function ouvresExercice() {
    const b = fiscalBounds(todayISO());
    return joursOuvres(b.from, b.to);
}

/**
 * D'où déduire les valeurs de l'onglet courant : 'year', 'month', ou null quand
 * il n'y a rien au-dessus ou rien de posé au-dessus.
 */
function sourceDeDeduction() {
    if (scaleKey === 'year') return null;
    if (Object.keys(jobTargets(jobKey, 'year')).length) return 'year';
    if (scaleKey === 'month') return null;
    if (Object.keys(jobTargets(jobKey, 'month')).length) return 'month';
    return null;
}

/**
 * Remplit les champs à partir de l'échelle du dessus, sans rien enregistrer.
 *
 * TOUT SE DÉDUIT AU PRORATA DES JOURS OUVRÉS, et pas en divisant par douze ou
 * par cinquante-deux. C'est déjà la logique du reste de l'outil — « reste 146 en
 * 3 jours ouvrés » — et c'est la seule qui donne un objectif de mois d'août plus
 * petit qu'un objectif de mois de mars. Un douzième partout aurait affiché un
 * retard mécanique chaque été.
 *
 * Rien n'est enregistré : les valeurs sont proposées dans les champs, à relire
 * et à corriger avant de cliquer sur Enregistrer. Une déduction est une aide à
 * la saisie, pas une décision.
 */
function deriver() {
    const src = sourceDeDeduction();
    if (!src) return;

    const source = jobTargets(jobKey, src);
    const base = src === 'year' ? ouvresExercice() : ouvresDuMois();
    if (!base) return;

    /* Combien de jours ouvrés dans l'échelle visée. La semaine est prise à cinq
       par convention : compter les jours ouvrés de LA semaine courante ferait
       varier l'objectif hebdomadaire d'une semaine à l'autre selon les jours
       fériés, ce qui n'a pas de sens pour une valeur qu'on pose une fois. */
    const cible = scaleKey === 'day' ? 1
                : scaleKey === 'week' ? 5
                : ouvresDuMois();

    let touche = 0;
    metriquesDe(jobKey).forEach(m => {
        const haut = source[m.key];
        const el = document.getElementById(`oj-${m.key}`);
        if (!el) return;
        if (haut == null) { el.value = ''; return; }
        /* Au dixième et non à l'entier depuis la v18 : 1 000 rendez-vous sur un
           exercice de 252 jours ouvrés font 3,97 par jour. Arrondir à 4 ajoutait
           sept rendez-vous sur l'exercice, soit une semaine et demie de travail
           inventée par la division. */
        el.value = cibleChamp(Math.max(0, auDixieme((haut / base) * cible)));
        touche++;
    });

    const nom = src === 'year' ? "l'annuel" : 'le mensuel';
    const statut = document.getElementById('obj-status');
    statut.style.color = '';
    statut.textContent = touche
        ? `${touche} valeur${touche > 1 ? 's' : ''} proposée${touche > 1 ? 's' : ''} `
          + `d'après ${nom}, au prorata des jours ouvrés. Rien n'est enregistré : `
          + 'relisez, corrigez, puis enregistrez.'
        : `Aucun objectif ${src === 'year' ? 'annuel' : 'mensuel'} n'est posé pour ce `
          + "métier : il n'y a rien à déduire.";
}

/* --------------------------------------------------------------------------
   LES RÉGLAGES GÉNÉRAUX (v17)

   Deux valeurs qui ne sont ni des objectifs ni des affichages, mais qui
   changent la lecture de tout l'outil : le mois où commence l'exercice, et la
   durée au-delà de laquelle un contact redevient inconnu. Toutes deux vivaient
   en base sans écran, donc n'étaient modifiables qu'en SQL.

   Réservées au propriétaire, côté écran comme côté base : la RLS d'app_settings
   n'autorise l'écriture qu'à can_write_any(), le masquage ici n'est qu'une
   politesse pour ne pas montrer un bouton qui refuserait de servir.
   -------------------------------------------------------------------------- */

const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
                 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function renderReglages() {
    const boite = document.getElementById('obj-settings');
    if (!boite) return;
    if (!canWriteAny(myProfile())) { boite.hidden = true; return; }
    boite.hidden = false;

    const debut = fiscalStartMonth();
    const sel = document.getElementById('set-fiscal');
    sel.innerHTML = MOIS_FR.map((nom, i) => `
        <option value="${i + 1}"${i + 1 === debut ? ' selected' : ''}>${nom}</option>`).join('');

    document.getElementById('set-known').value = String(knownMonths());

    const b = fiscalBounds(todayISO());
    document.getElementById('set-fiscal-hint').textContent =
        `Exercice en cours : du ${formatCourt(b.from)} au ${formatCourt(b.to)}, `
        + `${joursOuvres(b.from, b.to)} jours ouvrés.`;
}

/** Une date ISO en « 1er octobre 2025 », pour un rappel qui se lit sans effort. */
function formatCourt(iso) {
    const [a, m, j] = iso.split('-').map(Number);
    return `${j === 1 ? '1er' : j} ${MOIS_FR[m - 1]} ${a}`;
}

async function enregistrerReglages() {
    const statut = document.getElementById('set-status');
    const mois = Number(document.getElementById('set-fiscal').value);
    const known = Number(document.getElementById('set-known').value);

    if (!(mois >= 1 && mois <= 12)) { statut.textContent = 'Mois invalide.'; return; }
    if (!(known >= 1 && known <= 120)) {
        statut.style.color = 'var(--danger)';
        statut.textContent = 'La durée doit tenir entre 1 et 120 mois.';
        return;
    }

    try {
        await saveSettings({ fiscal_year_start_month: mois, known_contact_months: known });
        statut.style.color = '';
        statut.textContent = 'Réglages enregistrés. Les écrans déjà ouverts les '
            + 'reprendront à leur prochain chargement.';
        renderReglages();
        repeindre();
    } catch (e) {
        statut.style.color = 'var(--danger)';
        statut.textContent = humanError(e);
    }
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
    const metriques = metriquesDe(jobKey);
    const { lues, fautes, arrondies } = lireGrille('oj-', metriques);

    /* Un seul champ illisible et RIEN ne part. Enregistrer les autres laisserait
       l'écran à moitié à jour, avec un message de succès par-dessus. */
    if (fautes.length) {
        statut.style.color = 'var(--danger)';
        statut.textContent = phraseFautes(fautes);
        return;
    }

    const travaux = [];
    metriques.forEach(m => {
        const avant = actuels[m.key];
        const apres = lues[m.key];
        if (apres === avant) return;                     // rien n'a bougé
        if (apres === null) {
            travaux.push({ quoi: 'retire', metric: m.key });
        } else {
            travaux.push({ quoi: 'pose', metric: m.key, value: apres });
        }
    });

    if (!travaux.length) {
        statut.style.color = '';
        statut.textContent = 'Rien n\'a changé.' + phraseArrondis(arrondies);
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
        ].filter(Boolean).join(', ') + '.' + phraseArrondis(arrondies);
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
                    <input class="obj-input" type="text" id="ou-${m.key}"
                           inputmode="decimal"
                           autocomplete="off" spellcheck="false"
                           placeholder="${d == null ? 'pas d\'objectif' : fmtCible(d)}"
                           value="${cibleChamp(v)}">
                    <div class="obj-hint">${d == null
                        ? 'le métier n\'en a pas'
                        : `métier ${fmtCible(d)}`}${v != null ? ' · exception en place' : ''}</div>
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
    const metriques = metriquesDe(job);
    const { lues, fautes, arrondies } = lireGrille('ou-', metriques);

    if (fautes.length) {
        statut.style.color = 'var(--danger)';
        statut.textContent = phraseFautes(fautes);
        return;
    }

    const travaux = [];
    metriques.forEach(m => {
        const avant = actuels[m.key];
        const apres = lues[m.key];
        if (apres === avant) return;
        travaux.push(apres === null
            ? { quoi: 'retire', metric: m.key }
            : { quoi: 'pose', metric: m.key, value: apres });
    });

    if (!travaux.length) {
        statut.style.color = '';
        statut.textContent = 'Rien n\'a changé.' + phraseArrondis(arrondies);
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
        statut.textContent = (retires === travaux.length
            ? `${cible.display_name} suit à nouveau les objectifs de son métier.`
            : `Objectif personnel de ${cible.display_name} mis à jour.`)
            + phraseArrondis(arrondies);
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
    renderReglages();
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

    /* Le champ refusé redevient normal dès la première frappe : garder le rouge
       jusqu'au prochain clic sur Enregistrer donnerait à croire que la
       correction n'a pas été prise. */
    const oublieLeRouge = ev => {
        if (ev.target.classList.contains('obj-input--ko')) {
            ev.target.classList.remove('obj-input--ko');
        }
    };
    document.getElementById('obj-grid').addEventListener('input', oublieLeRouge);
    document.getElementById('obj-user-grid').addEventListener('input', oublieLeRouge);

    document.getElementById('obj-user-grid').addEventListener('change', ev => {
        const sel = ev.target.closest('[data-vis-user]');
        if (sel) basculeVisUser(sel.dataset.visUser, sel.value);
    });

    document.getElementById('obj-vis-force').addEventListener('click', forcerAffichage);
    document.getElementById('obj-user-vis-reset').addEventListener('click', retablirAffichage);

    document.getElementById('obj-save').addEventListener('click', saveJob);
    document.getElementById('obj-derive').addEventListener('click', deriver);
    document.getElementById('set-save').addEventListener('click', enregistrerReglages);
    document.getElementById('obj-apply').addEventListener('click', appliquer);
    document.getElementById('obj-user-save').addEventListener('click', saveUser);
    document.getElementById('obj-user-follow').addEventListener('click', suivreLeMetier);
}
