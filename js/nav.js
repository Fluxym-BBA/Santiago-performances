/* ==========================================================================
   NAV.JS — Barre de navigation et menu du compte.

   Trois règles tenues par ce fichier :

   1. RIEN N'EST JAMAIS TRONQUÉ. Aucun libellé ne se coupe, aucun mot ne passe
      à la ligne, aucun texte ne finit par des points de suspension. Ce qui ne
      tient pas dans la barre descend dans le menu de droite, et les libellés
      raccourcissent avant de se couper.

   2. LA BARRE NE MONTRE QUE CE QUI SERT À CETTE PERSONNE. Les sections sont
      construites depuis le profil : un administrateur pur n'a pas de page de
      saisie, un BDR n'a pas de vue d'équipe. Trois onglets au maximum, ce qui
      règle le problème de place à la source.

   3. LE RÔLE EST ÉCRIT EN CLAIR. Un utilisateur doit pouvoir répondre à
      « qu'est-ce que je suis ici ? » sans deviner.
   ========================================================================== */

import {
    signOut, isAdmin, isBdr, myProfile, viewedProfile, isViewingOther, roleLabel
} from './api.js';

/* --------------------------------------------------------------------------
   Sections

   `when` décide de la présence. `short` est utilisé sous 1024 px, `mini` sur
   la barre du bas en téléphone : le libellé rétrécit, il ne se coupe jamais.
   -------------------------------------------------------------------------- */

const SECTIONS = [
    {
        href: './index.html', match: ['', 'index.html'],
        label: 'Ma journée', short: 'Journée', mini: 'Journée', icon: '✍️',
        when: p => p.is_bdr
    },
    {
        href: './dashboard.html', match: ['dashboard.html'],
        label: 'Mes performances', short: 'Performances', mini: 'Perfs', icon: '📊',
        when: p => p.is_bdr
    },
    {
        href: './team.html', match: ['team.html'],
        label: 'Équipe', short: 'Équipe', mini: 'Équipe', icon: '👥',
        when: p => p.is_admin
    }
];

/** Entrées du menu de droite : le secondaire, jamais le principal. */
const MENU = [
    { href: './admin.html', label: 'Gérer les comptes', icon: '⚙️', when: p => p.is_admin },
    { href: './team.html', label: 'Vue d\'équipe', icon: '👥', when: p => p.is_admin, onlyCollapsed: true },
    { href: './dashboard.html', label: 'Mes performances', icon: '📊', when: p => p.is_bdr, onlyCollapsed: true },
    { href: './index.html', label: 'Ma journée', icon: '✍️', when: p => p.is_bdr, onlyCollapsed: true }
];

const here = () => location.pathname.split('/').pop();

/**
 * Initiales pour l'avatar. Deux lettres au maximum : au-delà, la pastille
 * grossit ou le texte déborde.
 */
function initialsOf(p) {
    const src = (p?.display_name || p?.email || '?').trim();
    const parts = src.split(/[\s.@_-]+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

/**
 * Nom court pour la barre : prénom, puis initiale du nom.
 * « Bruno Bartoli » devient « Bruno B. », qui tient toujours. C'est ce qui
 * remplace le « Bbartoli... » tronqué de la version précédente : on raccourcit
 * intentionnellement plutôt que de laisser le navigateur couper.
 */
function shortNameOf(p) {
    const full = (p?.display_name || '').trim();
    if (!full) return (p?.email || '').split('@')[0];
    const parts = full.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 14);
    return `${parts[0]} ${parts[1][0].toUpperCase()}.`;
}

/* --------------------------------------------------------------------------
   Rendu
   -------------------------------------------------------------------------- */

export function renderNav() {
    const nav = document.getElementById('main-nav');
    if (!nav) return;

    const me = myProfile() || {};
    const cur = here();
    const appName = window.APP_CONFIG?.APP_NAME || 'Cockpit BDR';

    const sections = SECTIONS.filter(s => s.when(me));
    const menu = MENU.filter(m => m.when(me));

    nav.className = 'topbar';
    nav.innerHTML = `
    <div class="topbar-inner">

        <a class="brand" href="${sections[0]?.href || './team.html'}">
            <img class="brand-logo" src="./assets/fluxym_logo_2018_sansdescriptif_blanc.png"
                 alt="Fluxym" onerror="this.style.display='none'">
            <span class="brand-name">${appName}</span>
        </a>

        <nav class="tabs" aria-label="Navigation principale">
            ${sections.map(s => `
                <a class="tab${s.match.includes(cur) ? ' tab--on' : ''}" href="${s.href}"
                   ${s.match.includes(cur) ? 'aria-current="page"' : ''}>
                    <span class="tab-icon" aria-hidden="true">${s.icon}</span>
                    <span class="tab-full">${s.label}</span>
                    <span class="tab-short">${s.short}</span>
                </a>`).join('')}
        </nav>

        <div class="account">
            <button class="account-btn" id="account-btn" type="button"
                    aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu">
                <span class="avatar">${initialsOf(me)}</span>
                <span class="account-text">
                    <span class="account-name">${shortNameOf(me)}</span>
                    <span class="account-role">${roleLabel(me)}</span>
                </span>
                <span class="account-chevron" aria-hidden="true">▾</span>
            </button>

            <div class="menu" id="account-menu" role="menu" hidden>
                <div class="menu-head">
                    <span class="avatar avatar--lg">${initialsOf(me)}</span>
                    <div class="menu-head-text">
                        <b>${me.display_name || 'Sans nom'}</b>
                        <span>${me.email || ''}</span>
                        <span class="menu-badges">
                            ${me.is_admin ? '<b class="badge badge--admin">Administrateur</b>' : ''}
                            ${me.is_bdr ? '<b class="badge badge--bdr">BDR</b>' : ''}
                            ${!me.is_admin && !me.is_bdr ? '<b class="badge">Observateur</b>' : ''}
                            ${me.is_demo ? '<b class="badge badge--demo">Compte de démonstration</b>' : ''}
                        </span>
                    </div>
                </div>

                ${menu.length ? `<div class="menu-group">
                    ${menu.map(m => `
                        <a class="menu-item${m.onlyCollapsed ? ' menu-item--collapsed-only' : ''}"
                           href="${m.href}" role="menuitem">
                            <span aria-hidden="true">${m.icon}</span>${m.label}
                        </a>`).join('')}
                </div>` : ''}

                <div class="menu-group">
                    <button class="menu-item" type="button" role="menuitem" id="menu-help">
                        <span aria-hidden="true">🎯</span>Comment le score est calculé
                    </button>
                </div>

                <div class="menu-group">
                    <button class="menu-item menu-item--danger" type="button" role="menuitem" id="menu-logout">
                        <span aria-hidden="true">↩</span>Se déconnecter
                    </button>
                </div>
            </div>
        </div>
    </div>

    <nav class="tabbar" aria-label="Navigation principale (téléphone)">
        ${sections.map(s => `
            <a class="tabbar-item${s.match.includes(cur) ? ' tabbar-item--on' : ''}" href="${s.href}">
                <span aria-hidden="true">${s.icon}</span>
                <span>${s.mini}</span>
            </a>`).join('')}
        <button class="tabbar-item" type="button" id="tabbar-more">
            <span aria-hidden="true">☰</span><span>Plus</span>
        </button>
    </nav>`;

    wireMenu();
    renderContextBar();

    // La barre du bas recouvre le pied de page : on réserve la place une fois
    // pour toutes plutôt que d'ajouter une marge dans chaque feuille de page.
    document.body.classList.toggle('has-tabbar', sections.length > 0);
}

/* --------------------------------------------------------------------------
   Menu déroulant
   -------------------------------------------------------------------------- */

function wireMenu() {
    const btn = document.getElementById('account-btn');
    const menu = document.getElementById('account-menu');
    const more = document.getElementById('tabbar-more');
    if (!btn || !menu) return;

    const open = () => {
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', onKey);
    };
    const close = () => {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', onKey);
    };
    const outside = e => { if (!menu.contains(e.target) && !btn.contains(e.target) && e.target !== more) close(); };
    const onKey = e => {
        if (e.key === 'Escape') { close(); btn.focus(); }
        // Tabulation : le premier élément du menu prend le relais, le menu ne
        // doit pas rester ouvert derrière le focus.
        if (e.key === 'Tab' && !menu.contains(document.activeElement)) close();
    };
    const toggle = () => (menu.hidden ? open() : close());

    btn.addEventListener('click', toggle);
    if (more) more.addEventListener('click', toggle);

    document.getElementById('menu-logout')?.addEventListener('click', () => signOut());
    document.getElementById('menu-help')?.addEventListener('click', () => {
        close();
        // Le détail du score vit sur les pages qui l'affichent ; ailleurs on y
        // renvoie plutôt que de dupliquer l'explication.
        const panel = document.getElementById('score-panel') || document.getElementById('score-explain');
        if (panel) {
            panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
            panel.classList.add('flash');
            setTimeout(() => panel.classList.remove('flash'), 1600);
        } else {
            location.href = isBdr() ? './dashboard.html#score' : './team.html#score';
        }
    });
}

/* --------------------------------------------------------------------------
   Barre de contexte

   Affichée uniquement quand on regarde le compte de quelqu'un d'autre. Le
   contexte vient de l'URL et non d'un état caché : il n'y a donc aucun moyen
   de « rester » par accident dans le compte d'un tiers, et fermer la barre
   revient simplement à revenir à la page d'équipe.
   -------------------------------------------------------------------------- */

export function renderContextBar() {
    document.getElementById('context-bar')?.remove();
    if (!isViewingOther()) return;

    const v = viewedProfile();
    const writing = ['', 'index.html'].includes(here());
    const name = v.display_name || v.email || 'cet utilisateur';

    const el = document.createElement('div');
    el.id = 'context-bar';
    el.className = `ctxbar${writing ? ' ctxbar--write' : ''}`;
    el.innerHTML = `
        <span class="ctxbar-icon" aria-hidden="true">${writing ? '✏️' : '👁️'}</span>
        <span class="ctxbar-text">
            ${writing
                ? `Vous <b>corrigez la saisie de ${name}</b>. Chaque modification sera enregistrée sur son compte et signalée comme une correction.`
                : `Vous consultez les performances de <b>${name}</b>, en lecture seule.`}
        </span>
        <a class="ctxbar-btn" href="./team.html">Retour à l'équipe</a>`;

    const nav = document.getElementById('main-nav');
    if (nav) nav.insertAdjacentElement('afterend', el);
    else document.body.insertBefore(el, document.body.firstChild);
}
