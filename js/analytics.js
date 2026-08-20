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
    METRICS, EMPTY_DAY, isWeekend, formatShort, startOfWeek, startOfMonth,
    weekLabel, monthLabel, addDaysISO, diffDays, periodLength
} from './api.js';

/* --- Lecture d'une ligne -------------------------------------------------- */

export const num = (r, k) => Number(r?.[k]) || 0;
export const score = r => num(r, 'productivity_score');

/** Un jour est « actif » dès qu'une action y a été saisie. Sert aux moyennes. */
export const isActive = r => num(r, 'total_actions') > 0;

/** Journée vide, pour boucher les trous d'une période sans fausser les calculs. */
export const zeroDay = iso => ({
    ...EMPTY_DAY, activity_date: iso, productivity_score: 0, total_actions: 0,
    connect_rate: null, meeting_rate: null, calls_per_meeting: null, notes: null
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
    return a.activeDays > 0 ? raw / a.activeDays : 0;
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
