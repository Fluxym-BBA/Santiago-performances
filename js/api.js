/* ==========================================================================
   API.JS — Client Supabase, authentification, accès aux données, dates.
   Aucune dépendance locale : supabase-js est chargé depuis le CDN en ESM.
   ========================================================================== */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const CFG = window.APP_CONFIG || {};

export const CONFIG_OK =
    typeof CFG.SUPABASE_URL === 'string' &&
    CFG.SUPABASE_URL.startsWith('https://') &&
    !CFG.SUPABASE_URL.includes('VOTRE-REF-PROJET') &&
    typeof CFG.SUPABASE_ANON_KEY === 'string' &&
    CFG.SUPABASE_ANON_KEY.length > 40;

export const supabase = createClient(
    CONFIG_OK ? CFG.SUPABASE_URL : 'https://placeholder.supabase.co',
    CONFIG_OK ? CFG.SUPABASE_ANON_KEY : 'placeholder.anon.key',
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }
);

/* --------------------------------------------------------------------------
   Définition centrale des métriques : une seule source de vérité,
   réutilisée par la saisie, le dashboard, les graphiques et le tableau.
   -------------------------------------------------------------------------- */

export const METRICS = [
    {
        key: 'companies_created', target: 'companies_target', group: 'crm',
        label: 'Entreprises créées', short: 'Entreprises',
        hint: 'Nouveaux comptes ajoutés au CRM', color: '#6366f1'
    },
    {
        key: 'contacts_created', target: 'contacts_target', group: 'crm',
        label: 'Contacts créés', short: 'Contacts',
        hint: 'Nouvelles fiches contact renseignées', color: '#8b5cf6'
    },
    {
        key: 'calls_made', target: 'calls_made_target', group: 'calls',
        label: "Nombre d'appels", short: 'Appels',
        hint: 'Tous les appels passés, aboutis ou non', color: '#00A7E1'
    },
    {
        key: 'calls_connected', target: 'calls_connected_target', group: 'calls',
        label: 'Appels aboutis', short: 'Aboutis',
        hint: 'Interlocuteur réellement joint', color: '#0ea5e9'
    },
    {
        key: 'meetings_booked', target: 'meetings_target', group: 'calls',
        label: 'Rendez-vous obtenus', short: 'RDV',
        hint: 'Le seul chiffre qui compte vraiment', color: '#10b981'
    },
    {
        key: 'emails_sent', target: 'emails_target', group: 'emails',
        label: 'E-mails envoyés', short: 'E-mails',
        hint: 'E-mails de prospection sortants', color: '#f59e0b'
    }
];

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map(m => [m.key, m]));

export const EMPTY_DAY = Object.fromEntries(METRICS.map(m => [m.key, 0]));

/* --------------------------------------------------------------------------
   Dates — tout est manipulé en heure locale, jamais en UTC, pour éviter
   le décalage classique qui fait basculer une saisie sur la veille.
   -------------------------------------------------------------------------- */

export function toISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const j = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${j}`;
}

export function fromISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}

export const todayISO = () => toISO(new Date());

export function addDaysISO(iso, n) {
    const d = fromISO(iso);
    d.setDate(d.getDate() + n);
    return toISO(d);
}

export function diffDays(isoA, isoB) {
    return Math.round((fromISO(isoA) - fromISO(isoB)) / 86400000);
}

export const isWeekend = iso => [0, 6].includes(fromISO(iso).getDay());

export function formatLong(iso) {
    const d = fromISO(iso);
    const txt = d.toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    return d.getDate() === 1 ? txt.replace(/ 1 /, ' 1er ') : txt;
}

export function formatShort(iso) {
    return fromISO(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

export function relativeLabel(iso) {
    const n = diffDays(todayISO(), iso);
    if (n === 0) return "Aujourd'hui";
    if (n === 1) return 'Hier';
    if (n === -1) return 'Demain';
    if (n > 1) return `Il y a ${n} jours`;
    return `Dans ${-n} jours`;
}

/* --------------------------------------------------------------------------
   Authentification
   -------------------------------------------------------------------------- */

export async function getSession() {
    const { data } = await supabase.auth.getSession();
    return data.session || null;
}

/** Redirige vers login.html si aucune session valide. Renvoie la session. */
export async function requireAuth() {
    if (!CONFIG_OK) {
        document.body.innerHTML =
            '<div style="max-width:620px;margin:80px auto;padding:32px;font-family:Inter,sans-serif;' +
            'background:#fff;border-radius:20px;box-shadow:0 15px 50px rgba(0,0,0,.12)">' +
            '<h1 style="font-size:20px;color:#0B2046">Configuration manquante</h1>' +
            '<p style="margin-top:12px;color:#4b5563;line-height:1.6">Le fichier <code>js/config.js</code> ' +
            "n'est pas renseigné. Ouvrez-le et collez l'URL du projet Supabase ainsi que la clé " +
            '<code>anon public</code> (Project Settings → API).</p></div>';
        throw new Error('Configuration Supabase absente');
    }
    const session = await getSession();
    if (!session) {
        const back = encodeURIComponent(location.pathname.split('/').pop() + location.search);
        location.replace(`./login.html?next=${back}`);
        throw new Error('Non authentifié');
    }
    return session;
}

export async function signIn(email, password) {
    return supabase.auth.signInWithPassword({ email: email.trim(), password });
}

export async function signOut() {
    await supabase.auth.signOut();
    location.replace('./login.html');
}

/* --------------------------------------------------------------------------
   Données — activité quotidienne
   -------------------------------------------------------------------------- */

function userId(session) {
    return session.user.id;
}

/** Ligne d'un jour donné, ou null si rien n'a encore été saisi. */
export async function fetchDay(iso) {
    const { data, error } = await supabase
        .from('daily_activity')
        .select('*')
        .eq('activity_date', iso)
        .maybeSingle();
    if (error) throw error;
    return data;
}

/** Vue enrichie (taux + score) pour un jour donné. */
export async function fetchDayKpi(iso) {
    const { data, error } = await supabase
        .from('v_daily_kpi')
        .select('*')
        .eq('activity_date', iso)
        .maybeSingle();
    if (error) throw error;
    return data;
}

/** Toutes les lignes entre deux dates incluses, triées chronologiquement. */
export async function fetchRange(fromIso, toIso) {
    const { data, error } = await supabase
        .from('v_daily_kpi')
        .select('*')
        .gte('activity_date', fromIso)
        .lte('activity_date', toIso)
        .order('activity_date', { ascending: true });
    if (error) throw error;
    return data || [];
}

/** Meilleur jour de l'utilisateur au score de productivité. */
export async function fetchBestDay() {
    const { data, error } = await supabase.from('v_best_day').select('*').maybeSingle();
    if (error) throw error;
    return data;
}

/** Écrit une valeur exacte (ou plusieurs) sur un jour, en créant la ligne si besoin. */
export async function saveDay(iso, patch, session) {
    const payload = { user_id: userId(session), activity_date: iso, ...patch };
    const { data, error } = await supabase
        .from('daily_activity')
        .upsert(payload, { onConflict: 'user_id,activity_date' })
        .select()
        .single();
    if (error) throw error;
    return data;
}

/** Incrément atomique côté base (boutons + / -). Renvoie la ligne à jour. */
export async function bump(metricKey, delta, iso) {
    const { data, error } = await supabase.rpc('bump_metric', {
        p_metric: metricKey, p_delta: delta, p_date: iso
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
}

/* --------------------------------------------------------------------------
   Données — objectifs journaliers
   -------------------------------------------------------------------------- */

export const DEFAULT_TARGETS = {
    companies_target: 5, contacts_target: 10, calls_made_target: 40,
    calls_connected_target: 10, meetings_target: 2, emails_target: 30
};

export async function fetchTargets() {
    const { data, error } = await supabase.from('daily_targets').select('*').maybeSingle();
    if (error) throw error;
    return { ...DEFAULT_TARGETS, ...(data || {}) };
}

export async function saveTargets(patch, session) {
    const payload = { user_id: userId(session), ...patch };
    const { data, error } = await supabase
        .from('daily_targets')
        .upsert(payload, { onConflict: 'user_id' })
        .select()
        .single();
    if (error) throw error;
    return data;
}

/* --------------------------------------------------------------------------
   Messages d'erreur lisibles par un humain
   -------------------------------------------------------------------------- */

export function humanError(error) {
    if (!error) return 'Erreur inconnue';
    const msg = error.message || String(error);
    if (error.code === '23514' || msg.includes('daily_activity_calls_coherent')) {
        return "Impossible : il y aurait plus d'appels aboutis que d'appels passés.";
    }
    if (error.code === '23514') return 'Valeur refusée par la base (elle doit être positive).';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        return 'Connexion à la base impossible. Vérifiez votre réseau.';
    }
    if (msg.includes('JWT') || msg.includes('expired')) {
        return 'Session expirée, reconnectez-vous.';
    }
    if (msg.includes('row-level security') || error.code === '42501') {
        return "Droits insuffisants sur cette donnée (RLS). Êtes-vous bien connecté ?";
    }
    if (msg.includes('Invalid login credentials')) return 'E-mail ou mot de passe incorrect.';
    return msg;
}

/* --------------------------------------------------------------------------
   Périodes — semaines (ISO, lundi → dimanche), mois, trimestres.
   Tout reste en heure locale, comme le reste du module.
   -------------------------------------------------------------------------- */

/** Lundi de la semaine contenant `iso`. */
export function startOfWeek(iso) {
    const d = fromISO(iso);
    const shift = (d.getDay() + 6) % 7;   // 0 = lundi
    d.setDate(d.getDate() - shift);
    return toISO(d);
}

export const endOfWeek = iso => addDaysISO(startOfWeek(iso), 6);

export function startOfMonth(iso) {
    const d = fromISO(iso);
    return toISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function endOfMonth(iso) {
    const d = fromISO(iso);
    return toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/** Décale une date de n mois en restant dans le mois cible (31 janvier + 1 mois = 28/29 février). */
export function addMonthsISO(iso, n) {
    const d = fromISO(iso);
    const day = d.getDate();
    const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, last));
    return toISO(target);
}

export function startOfQuarter(iso) {
    const d = fromISO(iso);
    return toISO(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1));
}

export const endOfQuarter = iso => endOfMonth(addMonthsISO(startOfQuarter(iso), 2));

/** Numéro de semaine ISO 8601. */
export function isoWeek(iso) {
    const d = fromISO(iso);
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayNr = (target.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);          // jeudi de la semaine
    const firstThursday = new Date(target.getFullYear(), 0, 4);
    const fDayNr = (firstThursday.getDay() + 6) % 7;
    firstThursday.setDate(firstThursday.getDate() - fDayNr + 3);
    return 1 + Math.round((target - firstThursday) / (7 * 86400000));
}

export const weekLabel = iso => `S${isoWeek(iso)}`;

export const monthLabel = iso =>
    fromISO(iso).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });

/** Nombre de jours calendaires d'une période bornes incluses. */
export const periodLength = (from, to) => diffDays(to, from) + 1;

/** Nombre de jours ouvrés (lundi → vendredi) d'une période. */
export function countWorkdays(from, to) {
    let n = 0;
    for (let iso = from; diffDays(to, iso) >= 0; iso = addDaysISO(iso, 1)) {
        if (!isWeekend(iso)) n++;
    }
    return n;
}

/** Période de même longueur, immédiatement avant celle fournie. */
export function previousPeriod(from, to) {
    const len = periodLength(from, to);
    return { from: addDaysISO(from, -len), to: addDaysISO(from, -1) };
}

/** Même période, un an plus tôt. */
export const samePeriodLastYear = (from, to) => ({
    from: addMonthsISO(from, -12), to: addMonthsISO(to, -12)
});

/** Libellé lisible d'une période ("12 août 2026" ou "du 1er au 31 juillet 2026"). */
export function periodLabel(from, to) {
    if (from === to) return formatLong(from).replace(/^\w+\s/, '');
    const a = fromISO(from), b = fromISO(to);
    const sameYear = a.getFullYear() === b.getFullYear();
    const sameMonth = sameYear && a.getMonth() === b.getMonth();
    const optA = sameMonth
        ? { day: 'numeric' }
        : (sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
    // « 1 août » ne se dit pas : on force l'ordinal sur le premier du mois.
    const ord = (d, txt) => d.getDate() === 1 ? txt.replace(/^1(?!\d)/, '1er') : txt;
    return `du ${ord(a, a.toLocaleDateString('fr-FR', optA))} au ${ord(b, b.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }))}`;
}

/** Libellé court, pour les puces et les légendes de graphiques. */
export function periodLabelShort(from, to) {
    return from === to ? formatShort(from) : `${formatShort(from)} → ${formatShort(to)}`;
}

/** Renvoie la plus ancienne des deux dates. */
export const minISO = (a, b) => (diffDays(b, a) >= 0 ? a : b);

/** Renvoie la plus récente des deux dates. */
export const maxISO = (a, b) => (diffDays(b, a) >= 0 ? b : a);
