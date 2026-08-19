/* ==========================================================================
   NAV.JS — Barre de navigation injectée (jamais de menu écrit en dur).
   ========================================================================== */

import { signOut } from './api.js';

const PAGES = [
    { href: './index.html', label: '✍️ Saisie du jour', match: ['', 'index.html'] },
    { href: './dashboard.html', label: '📊 Performances', match: ['dashboard.html'] }
];

export function renderNav(session) {
    const nav = document.getElementById('main-nav');
    if (!nav) return;

    const here = location.pathname.split('/').pop();
    const email = session?.user?.email || '';
    const initials = (email.split('@')[0] || '?').slice(0, 2).toUpperCase();
    const appName = window.APP_CONFIG?.APP_NAME || 'Cockpit BDR';
    const owner = window.APP_CONFIG?.APP_OWNER || '';

    nav.innerHTML = `
    <div class="nav-container">
        <a class="nav-logo" href="./index.html">
            <img class="nav-logo-img" src="./assets/fluxym_logo_2018_sansdescriptif_blanc.png"
                 alt="Fluxym" onerror="this.style.display='none'">
            <span class="nav-logo-text">${appName}${owner ? ` <span>· ${owner}</span>` : ''}</span>
        </a>
        <ul class="nav-links">
            ${PAGES.map(p => `
                <li><a class="nav-link${p.match.includes(here) ? ' nav-link--active' : ''}"
                       href="${p.href}">${p.label}</a></li>`).join('')}
        </ul>
        <div class="nav-user">
            <div class="nav-avatar" title="${email}">${initials}</div>
            <span class="nav-email">${email}</span>
            <button class="nav-logout" type="button" id="btn-logout">Déconnexion</button>
        </div>
    </div>`;

    document.getElementById('btn-logout').addEventListener('click', () => signOut());
}
