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
    return fromISO(iso).toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
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
