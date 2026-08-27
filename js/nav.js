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
    signOut, isAdmin, myProfile, viewedProfile, isViewingOther, roleLabel,
    levelLabel, canReadAll, canManageAccounts, canWriteAny, canWriteViewed,
    isContributor, amContributor, jobLabel, linkFor
} from './api.js';

/* --------------------------------------------------------------------------
   QUATRIÈME RÈGLE, AJOUTÉE EN v19 : CONSULTER QUELQU'UN, C'EST VOIR SON ÉCRAN.

   Jusqu'ici la barre restait celle du lecteur. Un propriétaire sans métier n'a
   que l'onglet Équipe : en ouvrant la fiche de Santiago, il voyait ses
   performances et n'avait aucun chemin vers sa saisie, alors que c'est
   justement là que tout se passe. Pire, les rares onglets présents perdaient
   le « ?u= » et le ramenaient chez lui sans prévenir.

   Les onglets sont donc maintenant CEUX DE LA PERSONNE REGARDÉE, et tous les
   liens qui restent dans son contexte le conservent. Le seul reliquat du
   lecteur est le menu de droite : il porte son identité, ses réglages et sa
   déconnexion, et il n'y a aucune raison de les lui retirer.
   -------------------------------------------------------------------------- */

/**
 * Échappement minimal pour tout ce qui vient d'un profil.
 *
 * Le nom d'affichage est modifiable par son propriétaire depuis la page du
 * compte, et il était jusqu'ici injecté tel quel dans la barre de contexte.
 * Un nom contenant du balisage s'exécutait donc dans la page de son manager.
 * Trois lignes ici plutôt qu'un import depuis ui.js : nav.js est chargé sur
 * toutes les pages, y compris celles qui n'ont pas besoin du reste.
 */
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/* --------------------------------------------------------------------------
   Sections

   `when` décide de la présence. `short` est utilisé sous 1024 px, `mini` sur
   la barre du bas en téléphone : le libellé rétrécit, il ne se coupe jamais.
   -------------------------------------------------------------------------- */

const SECTIONS = [
    {
        href: './index.html', match: ['', 'index.html'],
        label: 'Ma journée', labelOther: 'Sa journée',
        short: 'Journée', mini: 'Journée', icon: '✍️',
        // isContributor et non is_bdr : sans quoi un commercial n'aurait aucune
        // page de saisie, donc aucun usage de l'outil.
        when: p => isContributor(p)
    },
    {
        href: './dashboard.html', match: ['dashboard.html'],
        label: 'Mes performances', labelOther: 'Ses performances',
        short: 'Performances', mini: 'Perfs', icon: '📊',
        when: p => isContributor(p)
    },
    {
        href: './team.html', match: ['team.html'],
        label: 'Équipe', short: 'Équipe', mini: 'Équipe', icon: '👥',
        // Voir l'équipe, ce n'est plus administrer : un responsable en lecture
        // seule a cet onglet, et n'a pas celui des comptes.
        when: p => canReadAll(p)
    }
];

/** Entrées du menu de droite : le secondaire, jamais le principal. */
const MENU = [
    // La seule entrée que tout le monde possède, et la première : c'est ici que
    // l'on change son propre mot de passe. Elle n'est pas dans la barre du haut
    // parce qu'on ne s'y rend que deux fois par an, et que la règle des trois
    // onglets vaut plus que la visibilité d'un réglage.
    { href: './compte.html', label: 'Mon compte', icon: '🔑', when: () => true },
    // Le carnet d'entreprises : ouvert à tous ceux qui y écrivent, et non aux
    // seuls administrateurs. Celui qui se trompe en tapant un nom est celui qui
    // saisit, le soir, seul : faire passer la correction par un administrateur
    // laisserait le doublon vivre une semaine.
    //
    // Absente pour un BDR pur, en revanche : les cinq compteurs qui nomment une
    // entreprise sont ceux du commercial, un BDR ne crée jamais rien dans ce
    // carnet et n'a donc rien à y nettoyer. La page reste accessible par son
    // adresse, elle ne met personne dehors, elle ne s'affiche simplement pas là
    // où elle ne sert pas.
    { href: './entreprises.html', label: 'Carnet d\'entreprises', icon: '🏢',
      when: p => !!p?.is_sales || canReadAll(p) },
    { href: './admin.html', label: 'Gérer les comptes', icon: '⚙️', when: p => canManageAccounts(p) },
    // Réservée au propriétaire, et non aux administrateurs : le barème est
    // global et rétroactif, il ne se règle pas à plusieurs mains. La page
    // refuserait de toute façon le formulaire, et la base l'écriture.
    { href: './bareme.html', label: 'Barème du score', icon: '⚖️', when: p => canWriteAny(p) },
    // Les trois dernières entrées doublent les onglets sur petit écran :
    // « miroir » les fait suivre la personne regardée, comme les onglets.
    // Volontairement NON miroir, à la différence des deux suivantes : sur petit
    // écran, c'est le seul chemin de retour vers l'équipe quand on consulte
    // quelqu'un qui, lui, n'a pas cet onglet. Le perdre enfermerait le lecteur
    // dans la fiche qu'il regarde.
    { href: './team.html', label: 'Vue d\'équipe', icon: '👥', when: p => canReadAll(p),
      onlyCollapsed: true },
    { href: './dashboard.html', label: 'Mes performances', labelOther: 'Ses performances',
      icon: '📊', when: p => isContributor(p), onlyCollapsed: true, miroir: true },
    { href: './index.html', label: 'Ma journée', labelOther: 'Sa journée',
      icon: '✍️', when: p => isContributor(p), onlyCollapsed: true, miroir: true }
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

    /* Les onglets décrivent la personne REGARDÉE, le menu décrit le lecteur.
       Conséquence assumée : en consultant un membre, l'onglet Équipe disparaît,
       puisque lui ne l'a pas. Le retour se fait par le bouton de la barre de
       contexte, qui est là pour ça et qui, lui, ne bouge jamais. */
    const autre = isViewingOther();
    const vu = viewedProfile() || me;
    const profilNav = autre ? vu : me;
    const lien = href => (autre ? linkFor(href, vu.user_id) : href);
    const nom = s => (autre && s.labelOther ? s.labelOther : s.label);

    const sections = SECTIONS.filter(s => s.when(profilNav));
    const menu = MENU.filter(m => m.when(m.miroir ? profilNav : me));

    nav.className = 'topbar';
    nav.innerHTML = `
    <div class="topbar-inner">

        <a class="brand" href="${lien(sections[0]?.href || './team.html')}">
            <img class="brand-logo" src="./assets/fluxym_logo_2018_sansdescriptif_blanc.png"
                 alt="Fluxym" onerror="this.style.display='none'">
            <span class="brand-name">${appName}</span>
        </a>

        <nav class="tabs" aria-label="Navigation principale">
            ${sections.map(s => `
                <a class="tab${s.match.includes(cur) ? ' tab--on' : ''}" href="${lien(s.href)}"
                   ${s.match.includes(cur) ? 'aria-current="page"' : ''}>
                    <span class="tab-icon" aria-hidden="true">${s.icon}</span>
                    <span class="tab-full">${nom(s)}</span>
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
                            ${canReadAll(me) ? `<b class="badge badge--admin">${levelLabel(me)}</b>` : ''}
                            ${jobLabel(me) ? `<b class="badge badge--bdr">${jobLabel(me)}</b>` : ''}
                            ${!me.is_admin && !isContributor(me) ? '<b class="badge">Observateur</b>' : ''}
                            ${me.is_demo ? '<b class="badge badge--demo">Compte de démonstration</b>' : ''}
                        </span>
                    </div>
                </div>

                ${menu.length ? `<div class="menu-group">
                    ${menu.map(m => `
                        <a class="menu-item${m.onlyCollapsed ? ' menu-item--collapsed-only' : ''}"
                           href="${m.miroir ? lien(m.href) : m.href}" role="menuitem">
                            <span aria-hidden="true">${m.icon}</span>${m.miroir ? nom(m) : m.label}
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
            <a class="tabbar-item${s.match.includes(cur) ? ' tabbar-item--on' : ''}" href="${lien(s.href)}">
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
            location.href = amContributor() ? './dashboard.html#score' : './team.html#score';
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
    const name = esc(v.display_name || v.email || 'cet utilisateur');

    /* v19 : le ton de la barre suit le DROIT D'ÉCRIRE, plus la page affichée.
       Depuis que l'écran de saisie s'ouvre à l'identique pour tout le monde,
       « vous corrigez » affiché à un manager qui ne peut rien enregistrer
       serait une promesse que la base ne tiendra pas. Seul le propriétaire
       écrit chez les autres. */
    const ecrit = canWriteViewed();

    const el = document.createElement('div');
    el.id = 'context-bar';
    el.className = `ctxbar${ecrit ? ' ctxbar--write' : ''}`;
    el.innerHTML = `
        <span class="ctxbar-icon" aria-hidden="true">${ecrit ? '✏️' : '👁️'}</span>
        <span class="ctxbar-text">
            ${ecrit
                ? `Vous êtes dans le compte de <b>${name}</b> et vous voyez son écran. Tout ce que vous enregistrerez ici partira sur son compte, signalé comme une correction.`
                : `Vous voyez l'écran de <b>${name}</b>, en lecture seule.`}
        </span>
        <a class="ctxbar-btn" href="./team.html">Retour à l'équipe</a>`;

    const nav = document.getElementById('main-nav');
    if (nav) nav.insertAdjacentElement('afterend', el);
    else document.body.insertBefore(el, document.body.firstChild);
}
