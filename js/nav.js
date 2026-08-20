/* ==========================================================================
   NAV.JS — Barre de navigation injectée (jamais de menu écrit en dur).

   Elle porte aussi le sélecteur d'utilisateur consulté, réservé aux
   administrateurs. Le placer ici plutôt que dans une page a deux avantages :
   il est disponible partout sans duplication, et le changement de périmètre est
   visible en permanence, ce qui évite de corriger la journée de quelqu'un en
   croyant saisir la sienne.
   ========================================================================== */

import {
    signOut, isAdmin, myProfile, viewedUser, isViewingOther,
    setViewedUser, listProfiles
} from './api.js';

const PAGES = [
    { href: './index.html', label: '✍️ Saisie du jour', match: ['', 'index.html'] },
    { href: './dashboard.html', label: '📊 Performances', match: ['dashboard.html'] },
    { href: './team.html', label: '👥 Équipe', match: ['team.html'], admin: true },
    { href: './admin.html', label: '⚙️ Comptes', match: ['admin.html'], admin: true }
];

const initialsOf = p => {
    const src = (p?.display_name || p?.email || '?').trim();
    const parts = src.split(/[\s.@_-]+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
};

export function renderNav(session) {
    const nav = document.getElementById('main-nav');
    if (!nav) return;

    const here = location.pathname.split('/').pop();
    const me = myProfile() || { email: session?.user?.email || '' };
    const appName = window.APP_CONFIG?.APP_NAME || 'Cockpit BDR';
    const admin = isAdmin();

    nav.innerHTML = `
    <div class="nav-container">
        <a class="nav-logo" href="./index.html">
            <img class="nav-logo-img" src="./assets/fluxym_logo_2018_sansdescriptif_blanc.png"
                 alt="Fluxym" onerror="this.style.display='none'">
            <span class="nav-logo-text">${appName}</span>
        </a>
        <ul class="nav-links">
            ${PAGES.filter(p => !p.admin || admin).map(p => `
                <li><a class="nav-link${p.match.includes(here) ? ' nav-link--active' : ''}"
                       href="${p.href}">${p.label}</a></li>`).join('')}
        </ul>
        <div class="nav-user">
            ${admin ? '<div class="nav-scope" id="nav-scope"></div>' : ''}
            <div class="nav-avatar" title="${me.email || ''}">${initialsOf(me)}</div>
            <span class="nav-email">${me.display_name || me.email || ''}${
                admin ? '<b class="nav-role">Admin</b>' : ''}</span>
            <button class="nav-logout" type="button" id="btn-logout">Déconnexion</button>
        </div>
    </div>`;

    document.getElementById('btn-logout').addEventListener('click', () => signOut());
    if (admin) mountScope();
    renderScopeBanner();
}

/* --------------------------------------------------------------------------
   Sélecteur d'utilisateur consulté
   -------------------------------------------------------------------------- */

async function mountScope() {
    const host = document.getElementById('nav-scope');
    if (!host) return;

    let profiles = [];
    try {
        profiles = await listProfiles();
    } catch {
        host.remove();
        return;
    }
    if (profiles.length <= 1) { host.remove(); return; }

    const cur = viewedUser();
    host.innerHTML = `
        <label class="nav-scope-label" for="scope-select">Données de</label>
        <select class="nav-scope-select" id="scope-select">
            ${profiles.map(p => `
                <option value="${p.user_id}"${p.user_id === cur.user_id ? ' selected' : ''}>
                    ${p.display_name || p.email}${p.is_demo ? ' (démo)' : ''}${p.is_active ? '' : ' (inactif)'}
                </option>`).join('')}
        </select>`;

    host.querySelector('#scope-select').addEventListener('change', e => {
        const next = profiles.find(p => p.user_id === e.target.value);
        if (!next) return;
        setViewedUser(next);
        // Rechargement complet plutôt qu'un rafraîchissement partiel : la page de
        // saisie, le tableau de bord et leurs états de dates dépendent tous de
        // l'utilisateur, un rechargement garantit qu'aucun reste n'est affiché.
        location.reload();
    });
}

/**
 * Bandeau permanent quand on ne regarde pas ses propres données.
 * Il est volontairement voyant : sur la page de saisie, chaque bouton écrit
 * dans le compte de quelqu'un d'autre.
 */
export function renderScopeBanner() {
    document.getElementById('scope-banner')?.remove();
    if (!isViewingOther()) return;

    const v = viewedUser();
    const here = location.pathname.split('/').pop();
    const writing = here === '' || here === 'index.html';

    const el = document.createElement('div');
    el.id = 'scope-banner';
    el.className = `scope-banner${writing ? ' scope-banner--write' : ''}`;
    el.innerHTML = `
        <span class="scope-banner-icon">${writing ? '✏️' : '👁️'}</span>
        <span class="scope-banner-text">
            ${writing
                ? `Vous <b>saisissez pour ${v.display_name || v.email}</b>. Toute modification sera enregistrée sur son compte et signalée comme une correction.`
                : `Vous consultez les données de <b>${v.display_name || v.email}</b>.`}
        </span>
        <button type="button" class="scope-banner-btn" id="scope-back">Revenir à mes données</button>`;

    // Juste sous la barre de navigation, donc au-dessus du titre de la page :
    // impossible à manquer, et au même endroit sur toutes les pages.
    const nav = document.getElementById('main-nav');
    if (nav) nav.insertAdjacentElement('afterend', el);
    else document.body.insertBefore(el, document.body.firstChild);

    el.querySelector('#scope-back').addEventListener('click', () => {
        setViewedUser(myProfile());
        location.reload();
    });
}
