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
   Pondérations du score de productivité.
   SOURCE UNIQUE côté application : la page de saisie, le dashboard et les
   explications affichées lisent toutes cette constante.
   Elle doit rester identique à la définition de la vue SQL v_daily_kpi,
   qui reste la source de vérité côté base.
   -------------------------------------------------------------------------- */

export const SCORE_WEIGHTS = [
    { key: 'calls_made', w: 1, icon: '📞', label: 'Appel passé', plural: 'appels passés' },
    { key: 'calls_connected', w: 3, icon: '✅', label: 'Appel abouti', plural: 'appels aboutis' },
    { key: 'meetings_booked', w: 20, icon: '🤝', label: 'Rendez-vous', plural: 'rendez-vous' },
    { key: 'emails_sent', w: 1, icon: '✉️', label: 'E-mail envoyé', plural: 'e-mails envoyés' },
    { key: 'companies_created', w: 2, icon: '🏢', label: 'Entreprise créée', plural: 'entreprises créées' },
    { key: 'contacts_created', w: 2, icon: '👤', label: 'Contact créé', plural: 'contacts créés' }
];

/** Score d'une ligne (ou d'un agrégat) à partir des pondérations ci-dessus. */
export const scoreOf = row =>
    SCORE_WEIGHTS.reduce((t, x) => t + (Number(row?.[x.key]) || 0) * x.w, 0);

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
/**
 * Page d'accueil naturelle d'un profil.
 * Un administrateur pur n'a rien à faire sur la page de saisie : sa porte
 * d'entrée est la vue d'équipe.
 */
export function homePageFor(p) {
    if (!p) return './login.html';
    if (p.is_bdr) return './index.html';
    if (p.is_admin) return './team.html';
    return './team.html';
}

/**
 * @param {object}  opts
 * @param {'bdr'|'admin'|null} opts.needs  Aptitude exigée par la page.
 */
export async function requireAuth({ needs = null } = {}) {
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
    // Le profil est chargé ici, une fois, avant tout accès aux données : le rôle
    // et le contexte consulté doivent être connus avant la première requête.
    await loadProfile(session);
    if (myProfile() && myProfile().is_active === false) {
        await signOut();
        throw new Error('Compte désactivé');
    }

    // Un profil qui n'a rien à faire sur cette page est redirigé vers la sienne
    // plutôt que de tomber sur un écran vide ou un message d'erreur. Ce n'est
    // pas une mesure de sécurité : celle-là est dans la base.
    const me = myProfile();
    // Exception nécessaire : un administrateur pur n'est pas commercial, mais il
    // doit pouvoir ouvrir les pages d'un commercial lorsqu'il en consulte un.
    // C'est le cas de `dashboard.html?u=...` ouvert depuis la vue d'équipe.
    const asVisitor = me.is_admin && isViewingOther();
    const wrong = (needs === 'bdr' && !me.is_bdr && !asVisitor)
               || (needs === 'admin' && !me.is_admin);
    if (wrong) {
        location.replace(homePageFor(me));
        throw new Error('Page non applicable à ce profil');
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
   Profils, rôles et périmètre de consultation

   Point d'architecture à ne pas perdre de vue : la Row Level Security suffisait
   tant que chacun ne voyait que ses lignes, et les requêtes pouvaient se passer
   de filtre. Dès lors qu'un administrateur voit tout le monde, la même requête
   renverrait l'activité de tous les utilisateurs mélangée. Chaque lecture porte
   donc désormais un filtre explicite sur l'utilisateur ciblé.

   La RLS reste la barrière de sécurité, le filtre n'est que la sélection du
   périmètre. Les deux sont nécessaires et ne servent pas à la même chose.
   -------------------------------------------------------------------------- */

let _me = null;        // mon profil
let _viewed = null;    // profil consulté, le mien par défaut

/**
 * Normalise un profil venant de la base.
 *
 * is_admin et is_bdr remplacent l'ancienne colonne role. Le repli sur role est
 * volontaire : il rend l'ordre de déploiement indifférent, l'application
 * fonctionnant avant comme après l'exécution de la migration.
 */
function normalize(p) {
    if (!p) return p;
    const isAdmin = p.is_admin ?? (p.role === 'admin');
    return {
        ...p,
        is_admin: !!isAdmin,
        is_bdr: p.is_bdr ?? (p.role ? p.role !== 'admin' : true),
        is_demo: !!p.is_demo,
        is_active: p.is_active !== false
    };
}

/** Rôle écrit en clair, pour que personne n'ait à deviner ce qu'il est ici. */
export function roleLabel(p) {
    if (!p) return '';
    if (p.is_admin && p.is_bdr) return 'Admin et BDR';
    if (p.is_admin) return 'Administrateur';
    if (p.is_bdr) return 'BDR';
    return 'Observateur';
}

/**
 * Charge mon profil, puis résout le contexte demandé par l'URL.
 *
 * Le paramètre `?u=<identifiant>` désigne l'utilisateur consulté. Faire porter
 * ce contexte par l'URL et non par la session est un choix de sécurité autant
 * que d'ergonomie : la page est rechargeable et partageable, on ne peut pas
 * « rester » par inadvertance dans le compte d'un tiers, et un rafraîchissement
 * ne réserve aucune surprise.
 */
export async function loadProfile(session) {
    const { data, error } = await supabase
        .from('profiles').select('*')
        .eq('user_id', session.user.id)
        .maybeSingle();
    if (error) throw error;

    _me = normalize(data) || normalize({
        user_id: session.user.id,
        email: session.user.email,
        display_name: (session.user.email || '').split('@')[0],
        is_admin: false, is_bdr: true, is_demo: false, is_active: true
    });

    _viewed = _me;

    const wanted = new URLSearchParams(location.search).get('u');
    if (wanted && wanted !== _me.user_id) {
        if (!_me.is_admin) {
            // Un non-administrateur qui bricole l'URL est renvoyé chez lui.
            // La base refuserait de toute façon de livrer les données.
            const url = new URL(location.href);
            url.searchParams.delete('u');
            location.replace(url.toString());
            throw new Error('Accès refusé');
        }
        const { data: other } = await supabase
            .from('profiles').select('*').eq('user_id', wanted).maybeSingle();
        if (other) _viewed = normalize(other);
    }
    return _me;
}

export function myProfile() { return _me; }
export function isAdmin() { return !!_me && _me.is_admin; }
export function isBdr() { return !!_me && _me.is_bdr; }

/** Profil dont on regarde les données. Jamais nul après loadProfile(). */
export function viewedProfile() { return _viewed || _me; }

/** Vrai quand on consulte quelqu'un d'autre : l'écran doit alors le dire. */
export function isViewingOther() {
    return !!_me && !!_viewed && _viewed.user_id !== _me.user_id;
}

/** Lien vers une page dans le contexte d'un utilisateur donné. */
export function linkFor(page, userId = null, extra = {}) {
    const url = new URL(page, location.href);
    if (userId && userId !== _me?.user_id) url.searchParams.set('u', userId);
    Object.entries(extra).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
    return url.pathname.split('/').pop() + url.search;
}

/** Identifiant ciblé par les lectures et les écritures. */
function target() {
    const v = viewedProfile();
    if (!v) throw new Error('Profil non chargé : appeler loadProfile() d\'abord');
    return v.user_id;
}

/**
 * Profils visibles. La RLS fait le tri des droits : un BDR ne récupère ici que
 * sa propre ligne, la liste n'a donc pas à être protégée côté front.
 */
export async function listProfiles() {
    const { data, error } = await supabase
        .from('profiles').select('*')
        .order('is_active', { ascending: false })
        .order('is_demo', { ascending: true })
        .order('display_name', { ascending: true });
    if (error) throw error;
    return (data || []).map(normalize);
}

/** Modification d'un profil par un administrateur. Les garde-fous sont côté base. */
export async function adminUpdateProfile(userId, patch) {
    const { data, error } = await supabase.rpc('admin_update_profile', {
        p_user_id: userId,
        p_display_name: patch.display_name ?? null,
        p_is_admin: patch.is_admin ?? null,
        p_is_bdr: patch.is_bdr ?? null,
        p_is_demo: patch.is_demo ?? null,
        p_is_active: patch.is_active ?? null
    });
    if (error) throw error;
    return normalize(Array.isArray(data) ? data[0] : data);
}

/** Effacement des données d'activité d'un compte, sans toucher au compte. */
export async function adminWipeActivity(userId, fromIso = null, toIso = null) {
    const { data, error } = await supabase.rpc('admin_wipe_activity', {
        p_user_id: userId, p_from: fromIso, p_to: toIso
    });
    if (error) throw error;
    return Number(data) || 0;
}


/* --------------------------------------------------------------------------
   Données — activité quotidienne

   Toutes ces fonctions travaillent sur l'utilisateur consulté, pas sur
   l'utilisateur connecté. C'est ce qui permet à un administrateur de lire le
   tableau de bord de quelqu'un d'autre, et de corriger sa saisie, sans aucune
   duplication de code.
   -------------------------------------------------------------------------- */

/** Ligne d'un jour donné, ou null si rien n'a encore été saisi. */
export async function fetchDay(iso) {
    const { data, error } = await supabase
        .from('daily_activity')
        .select('*')
        .eq('user_id', target())
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
        .eq('user_id', target())
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
        .eq('user_id', target())
        .gte('activity_date', fromIso)
        .lte('activity_date', toIso)
        .order('activity_date', { ascending: true });
    if (error) throw error;
    return data || [];
}

/** Meilleur jour de l'utilisateur consulté au score de productivité. */
export async function fetchBestDay() {
    const { data, error } = await supabase
        .from('v_best_day')
        .select('*')
        .eq('user_id', target())
        .maybeSingle();
    if (error) throw error;
    return data;
}

/** Écrit une valeur exacte (ou plusieurs) sur un jour, en créant la ligne si besoin. */
export async function saveDay(iso, patch, session) {
    const payload = { user_id: target(), activity_date: iso, ...patch };
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
        p_metric: metricKey, p_delta: delta, p_date: iso,
        // Nul quand on saisit pour soi : la base retombe alors sur auth.uid().
        p_user_id: isViewingOther() ? target() : null
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
}

/* --------------------------------------------------------------------------
   Données — équipe (administrateurs)
   -------------------------------------------------------------------------- */

/**
 * Activité de tous les utilisateurs sur une plage, profil compris.
 * Les comptes de démonstration sont exclus par défaut : sans cela, un jeu de
 * données fabriqué pour une présentation viendrait fausser tous les classements.
 */
export async function fetchTeamRange(fromIso, toIso,
    { includeDemo = false, includeInactive = false, onlyBdr = true } = {}) {
    let q = supabase
        .from('v_team_daily')
        .select('*')
        .gte('activity_date', fromIso)
        .lte('activity_date', toIso)
        .order('activity_date', { ascending: true });
    // Un administrateur pur ne prospecte pas : le faire figurer dans un
    // classement avec un score de zéro n'aurait aucun sens.
    if (onlyBdr) q = q.eq('is_bdr', true);
    if (!includeDemo) q = q.eq('is_demo', false);
    if (!includeInactive) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
}

/* --------------------------------------------------------------------------
   Données — objectifs journaliers
   -------------------------------------------------------------------------- */

export const DEFAULT_TARGETS = {
    companies_target: 5, contacts_target: 10, calls_made_target: 40,
    calls_connected_target: 10, meetings_target: 2, emails_target: 30
};

export async function fetchTargets() {
    const { data, error } = await supabase
        .from('daily_targets').select('*')
        .eq('user_id', target())
        .maybeSingle();
    if (error) throw error;
    return { ...DEFAULT_TARGETS, ...(data || {}) };
}

export async function saveTargets(patch, session) {
    const payload = { user_id: target(), ...patch };
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
    if (msg.includes('réservée aux administrateurs') || msg.includes('réservé aux administrateurs')) {
        return 'Action réservée aux administrateurs.';
    }
    if (msg.includes('dernier administrateur')) {
        return 'Impossible : ce compte est le dernier administrateur actif. Nommez un autre administrateur d\'abord.';
    }
    if (msg.includes('Utilisateur introuvable')) return 'Utilisateur introuvable.';
    if (error.code === '42P17') {
        return 'Erreur de configuration des droits dans la base (récursion RLS). Rejouez multi-user-migration.sql.';
    }
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
