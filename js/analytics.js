/* ==========================================================================
   ANALYTICS.JS — Calculs partagés, sans état ni DOM.

   Ces fonctions étaient dans dashboard.js. Elles en sont sorties le jour où la
   vue d'équipe a eu besoin des mêmes agrégats : dupliquer un calcul de taux ou
   de jours actifs aurait garanti que les deux pages finissent par afficher des
   chiffres différents pour la même chose.

   Règle : aucun accès au DOM, aucune variable d'état, aucun appel réseau. Tout
   entre par les arguments. C'est ce qui rend ce module testable et sûr à
   réutiliser depuis n'importe quelle page.
   ========================================================================== */

import {
    METRICS, METRIC_BY_KEY, EMPTY_DAY, isWeekend, formatShort, startOfWeek,
    startOfMonth, weekLabel, monthLabel, addDaysISO, diffDays, periodLength
} from './api.js';

/* --- Lecture d'une ligne -------------------------------------------------- */

export const num = (r, k) => Number(r?.[k]) || 0;
export const score = r => num(r, 'productivity_score');

/* --- Métriques ouvertes en cours de route -----------------------------------

   Les appels avec échange ne sont comptés que depuis le 25/08/2026 : avant
   cette date, le compteur n'existait pas à l'écran et personne ne pouvait
   répondre à la question. Additionner ces journées comme des zéros ferait dire
   à l'écran qu'aucune conversation n'a eu lieu pendant trois mois, et surtout
   diviserait un numérateur portant sur trois semaines par un dénominateur
   portant sur trois mois.

   La frontière est la DATE, pas la présence d'une valeur. C'est un choix, et il
   mérite d'être expliqué.

   Fonder la règle sur « la colonne est-elle renseignée ? » obligerait à toucher
   le compteur chaque jour, même pour dire zéro, sous peine de voir tous les
   taux disparaître. Aucun des six autres compteurs ne fonctionne comme ça :
   ne pas saisir d'e-mail vaut zéro e-mail, personne ne clique pour le
   confirmer. Le compteur d'échanges suit désormais la même logique, et la
   colonne porte un DEFAULT 0 en base depuis la migration v7.

   La date sert donc de filet : une journée antérieure au 25/08 reste hors du
   calcul même si elle porte une valeur, ce qui protège les corrections
   d'historique saisies après coup. Le jour où une septième métrique arrivera en
   cours de route, il suffira de lui déclarer un `since` dans METRICS. */

/** Clé dont la valeur n'a de sens qu'à partir d'une certaine date. */
export const MEASURED_KEY = 'calls_engaged';

/** Date d'ouverture du compteur, telle que déclarée dans METRICS. */
export const measuredSince = () => METRIC_BY_KEY[MEASURED_KEY]?.since || null;

/**
 * Vrai si la journée est postérieure à l'ouverture du compteur, donc si sa
 * valeur veut dire quelque chose. Une valeur absente y compte pour zéro, comme
 * pour n'importe quel autre compteur. Comparaison de chaînes ISO, sûre au
 * format AAAA-MM-JJ et sans fuseau horaire.
 */
export const isMeasured = (r, k = MEASURED_KEY) => {
    if (r == null) return false;
    const since = METRIC_BY_KEY[k]?.since;
    return !since || String(r.activity_date || '') >= since;
};

/** Un jour est « actif » dès qu'une action y a été saisie. Sert aux moyennes. */
export const isActive = r => num(r, 'total_actions') > 0;

/**
 * Journée vide, pour boucher les trous d'une période sans fausser les calculs.
 * Les taux y valent NULL et non zéro : un jour sans ligne n'a pas un taux de
 * conversion nul, il n'en a pas. Les volumes valent zéro, y compris les
 * échanges : une journée sans aucune saisie n'apporte rien ni au numérateur ni
 * au dénominateur, et c'est isMeasured qui décide si elle entre dans le calcul.
 */
export const zeroDay = iso => ({
    ...EMPTY_DAY, activity_date: iso, productivity_score: 0, total_actions: 0,
    [MEASURED_KEY]: 0,
    connect_rate: null, engage_rate: null, meeting_rate: null,
    meeting_rate_engaged: null, calls_per_meeting: null, notes: null
});

/** Lignes d'une période à partir d'un index par date, jours manquants à zéro. */
export function rowsForRange(byDate, from, to) {
    const out = [];
    for (let iso = from; diffDays(to, iso) >= 0; iso = addDaysISO(iso, 1)) {
        out.push(byDate.get(iso) || zeroDay(iso));
    }
    return out;
}

const SUM_KEYS = [...METRICS.map(m => m.key), 'productivity_score', 'total_actions'];

/**
 * Agrégat d'une liste de jours.
 * Les taux ne sont jamais des moyennes de taux : ils sont recalculés depuis les
 * volumes cumulés, sinon un jour à deux appels pèserait autant qu'un jour à
 * cinquante.
 */
export function agg(rows) {
    const a = { days: rows.length, activeDays: 0 };
    SUM_KEYS.forEach(k => { a[k] = 0; });

    rows.forEach(r => {
        if (isActive(r)) a.activeDays++;
        SUM_KEYS.forEach(k => { a[k] += num(r, k); });
    });

    a.workdays = rows.filter(r => !isWeekend(r.activity_date)).length;
    a.connect_rate = a.calls_made > 0 ? (a.calls_connected / a.calls_made) * 100 : null;
    a.meeting_rate = a.calls_connected > 0 ? (a.meetings_booked / a.calls_connected) * 100 : null;
    a.calls_per_meeting = a.meetings_booked > 0 ? a.calls_made / a.meetings_booked : null;
    a.crm = a.companies_created + a.contacts_created;

    /* Sous-période mesurée : elle a ses propres dénominateurs. Le taux
       d'échange se calcule sur les aboutis DES JOURNÉES MESURÉES, pas sur tous
       les aboutis de la période, sinon il baisse mécaniquement à chaque journée
       ancienne ajoutée à la sélection. */
    let mDays = 0, mActive = 0, mCalls = 0, mConn = 0, mMeet = 0, mEng = 0;
    rows.forEach(r => {
        if (!isMeasured(r)) return;
        mDays++;
        if (isActive(r)) mActive++;
        mCalls += num(r, 'calls_made');
        mConn += num(r, 'calls_connected');
        mMeet += num(r, 'meetings_booked');
        mEng += num(r, MEASURED_KEY);
    });

    /* Le total d'échanges est RECALCULÉ sur les seules journées comptées, et
       n'est pas la somme brute de la colonne. Sans cette ligne, une journée
       antérieure au 25/08 corrigée après coup verrait ses échanges entrer au
       numérateur alors que ses aboutis restent hors du dénominateur : le taux
       d'échange dépasserait la réalité sans qu'on comprenne pourquoi. */
    a[MEASURED_KEY] = mEng;

    a.measuredDays = mDays;
    a.measuredActiveDays = mActive;
    a.measured_calls_made = mCalls;
    a.measured_connected = mConn;
    a.measured_meetings = mMeet;

    // Aboutis sans conversation, sur les seules journées mesurées. NULL tant
    // qu'aucune journée n'est mesurée : la soustraction n'aurait aucun sens.
    a.calls_unengaged = mActive > 0 ? Math.max(0, mConn - a.calls_engaged) : null;
    a.engage_rate = mConn > 0 ? (a.calls_engaged / mConn) * 100 : null;
    a.meeting_rate_engaged = a.calls_engaged > 0 ? (mMeet / a.calls_engaged) * 100 : null;

    /* Mesure complète = toutes les journées saisies de la période sont
       postérieures à l'ouverture du compteur. C'est la condition pour comparer
       un étage d'entonnoir ou un taux à un autre : sans elle, deux étages
       porteraient sur deux périmètres différents. Aucun clic n'est requis, seule
       la date compte. */
    a.fullyMeasured = a.activeDays > 0 && mActive === a.activeDays;
    return a;
}

/**
 * Valeur d'un agrégat selon le mode de lecture.
 * En moyenne, on divise par les jours ACTIFS et non par les jours calendaires :
 * un week-end ou un jour de formation ne doit pas diluer la performance.
 */
export function valOf(a, key, mode = 'total') {
    const raw = key === 'crm' ? a.crm : (a[key] ?? 0);
    if (mode === 'total') return raw;
    /* Les échanges se moyennent sur les journées où ils ont été mesurés, pas
       sur toutes les journées saisies : sinon la moyenne d'une période à cheval
       sur le 25/08 serait divisée par un nombre de jours dont la plupart ne
       pouvaient pas en porter. */
    const base = key === MEASURED_KEY
        ? (a.measuredActiveDays ?? a.activeDays)
        : a.activeDays;
    return base > 0 ? raw / base : 0;
}

/** Regroupe des jours en paquets (jour, semaine ISO ou mois). */
export function bucketize(rows, gran) {
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

/** Granularité choisie automatiquement selon la longueur de la période. */
export function autoGran(from, to) {
    const span = periodLength(from, to);
    if (span <= 31) return 'day';
    if (span <= 180) return 'week';
    return 'month';
}

export const granWord = g => (g === 'day' ? 'jour' : g === 'week' ? 'semaine' : 'mois');
