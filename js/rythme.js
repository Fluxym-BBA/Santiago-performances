/* ==========================================================================
   RYTHME.JS — L'attendu : le rythme nécessaire pour tenir un objectif.

   Ces fonctions vivaient dans dashboard.js, pour UNE personne. La vue d'équipe
   en a besoin à son tour, pour un ensemble de personnes. Les dupliquer aurait
   garanti que deux écrans finissent par annoncer deux « attendu » différents
   pour le même mois, exactement le piège que analytics.js a déjà évité pour
   les taux. Elles sont donc ici, une seule fois.

   LA RÈGLE, inchangée depuis la v21 : l'attendu d'une période est une SOMME,
   jamais une division. Pour chaque maille (semaine, mois, exercice) qui recouvre
   la période, on retient la part de l'objectif de cette maille qui correspond
   aux jours ouvrés réellement compris dans la période. Voir l'en-tête de
   dashboard.js pour les quatre raisons.

   ÉQUIPE : l'attendu de l'équipe est la SOMME des attendus individuels. Une
   personne n'entre dans la somme d'un compteur que si son métier le tient
   (un BDR n'a pas d'objectif de RDV1) ; parmi celles-là, celles qui n'ont pas
   d'objectif sont comptées à part, et l'appelant doit le dire : une somme
   partielle affichée comme complète donnerait une avance imaginaire.

   Aucun DOM, aucun état, aucun réseau : tout entre par les arguments. Les
   objectifs eux-mêmes sont lus dans le cache de api.js (loadTargets).
   ========================================================================== */

import {
    METRIC_BY_KEY, jobsOf, targetFor, targetVisible, joursOuvres, fiscalBounds,
    startOfWeek, endOfWeek, startOfMonth, endOfMonth, addDaysISO
} from './api.js';

/** Les quatre mailles de lecture de l'objectif, dans l'ordre où elles se lisent. */
export const REF_SCALES = [
    { v: 'day',   l: 'J', mot: 'journalier' },
    { v: 'week',  l: 'S', mot: 'hebdomadaire' },
    { v: 'month', l: 'M', mot: 'mensuel' },
    { v: 'year',  l: 'A', mot: "de l'exercice" }
];

export const motDe = v => (REF_SCALES.find(s => s.v === v) || {}).mot || '';

/** Bornes de la maille qui contient ce jour. L'année est l'exercice, pas l'an civil. */
export function mailleDe(scale, iso) {
    if (scale === 'week')  return { from: startOfWeek(iso), to: endOfWeek(iso) };
    if (scale === 'month') return { from: startOfMonth(iso), to: endOfMonth(iso) };
    if (scale === 'year')  return fiscalBounds(iso);
    return { from: iso, to: iso };
}

/* joursOuvres() reboucle sur chaque jour. Sur un exercice, l'appeler pour
   chaque compteur de chaque carte ferait plusieurs milliers de tours pour
   toujours retomber sur les mêmes bornes. Le cache est vidé à chaque
   rafraîchissement, les fériés d'une année ne changeant pas en cours de page. */
let _ouvres = new Map();
export function ouvres(de, a) {
    const k = de + '|' + a;
    if (!_ouvres.has(k)) _ouvres.set(k, joursOuvres(de, a));
    return _ouvres.get(k);
}
export const videCacheOuvres = () => { _ouvres = new Map(); };

/**
 * Cible d'UN compteur pour UNE personne à une maille, ou null.
 *
 * null n'est pas zéro. Un compteur sans objectif ne doit afficher aucun trait,
 * surtout pas un trait à zéro qui ferait croire à un objectif atteint. C'est la
 * distinction tenue depuis la v12. On respecte la visibilité (v16) : un objectif
 * masqué reste masqué ici.
 */
export function cibleDe(profil, key, scale) {
    if (!profil || scale === 'off') return null;
    if (!targetVisible(profil, key)) return null;
    const v = targetFor(profil, key, scale).value;
    return v == null ? null : v;
}

/** Attendu d'UN compteur pour UNE personne sur une période, ou null. */
export function attenduUn(profil, key, de, a, scale) {
    const cible = cibleDe(profil, key, scale);
    if (cible == null) return null;

    // La maille du jour se passe de découpage : chaque jour ouvré pèse la cible.
    if (scale === 'day') return cible * ouvres(de, a);

    let total = 0, cur = de, garde = 0;
    while (cur <= a && garde++ < 3000) {
        const m = mailleDe(scale, cur);
        const jm = ouvres(m.from, m.to);
        if (jm > 0) {
            const from = m.from > de ? m.from : de;
            const to   = m.to   < a  ? m.to   : a;
            total += (cible * ouvres(from, to)) / jm;
        }
        cur = addDaysISO(m.to, 1);
    }
    return total;
}

/**
 * Attendu d'une carte pour UNE personne. Une carte peut porter plusieurs
 * compteurs (les fiches CRM sont la somme des entreprises et des contacts).
 *
 * Si UN SEUL des compteurs n'a pas d'objectif, on renvoie null : une somme
 * partielle afficherait un objectif anormalement bas et donnerait l'illusion
 * d'une avance.
 */
export function attendu(profil, keys, de, a, scale) {
    const liste = Array.isArray(keys) ? keys : [keys];
    let total = 0;
    for (const k of liste) {
        const v = attenduUn(profil, k, de, a, scale);
        if (v == null) return null;
        total += v;
    }
    return total;
}

/** Vrai si le métier de cette personne tient ce compteur. */
export function tientLeCompteur(profil, key) {
    const m = METRIC_BY_KEY[key];
    if (!m) return false;
    const j = jobsOf(profil);
    // Sans métier déclaré, personne n'est exclu : même repli que metricsFor.
    return !j.length || m.jobs.some(x => j.includes(x));
}

/**
 * Attendu d'une carte pour UN ENSEMBLE de personnes.
 *
 * Renvoie { value, covered, total, profils } :
 *   total    personnes dont le métier tient la carte (tous ses compteurs) ;
 *   covered  parmi elles, celles dont l'objectif est défini ;
 *   profils  ces dernières, pour que l'appelant compare l'attendu au réalisé DE
 *            CES PERSONNES-LÀ : comparer un attendu partiel au réalisé de toute
 *            l'équipe afficherait une avance qui n'existe pas ;
 *   value    somme de leurs attendus, null si aucune n'en a.
 *
 * L'appelant affiche value, et signale covered < total plutôt que de le taire.
 */
export function attenduEquipe(profils, keys, de, a, scale) {
    const liste = Array.isArray(keys) ? keys : [keys];
    let value = 0, covered = 0, total = 0;
    const profilsCouverts = [];
    for (const p of profils || []) {
        if (!liste.every(k => tientLeCompteur(p, k))) continue;
        total++;
        const v = attendu(p, liste, de, a, scale);
        if (v == null) continue;
        covered++;
        profilsCouverts.push(p);
        value += v;
    }
    return { value: covered ? value : null, covered, total, profils: profilsCouverts };
}
