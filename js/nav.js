/* ==========================================================================
   NAV.JS — Barre de navigation et menu du compte.

   Trois règles tenues par ce fichier :

   1. RIEN N'EST JAMAIS TRONQUÉ. Aucun libellé ne se coupe, aucun mot ne passe
      à la ligne, aucun texte ne finit par des points de suspension. Ce qui ne
      tient pas dans la barre descend dans le menu de droite, et les libellés
      raccourcissent avant de se couper.

   2. LA BARRE NE MONTRE QUE CE QUI SERT À CETTE PERSONNE. Les sections sont
      construites depuis le profil : un administrateur pur n'a pas de page de
      saisie, un BDR n'a pas de vue d'équipe. C'est ce qui règle le problème de
      place à la source : personne ne voit les quatre onglets sans les utiliser
      tous les quatre.

   3. LE RÔLE EST ÉCRIT EN CLAIR. Un utilisateur doit pouvoir répondre à
      « qu'est-ce que je suis ici ? » sans deviner.

   4. LA PLACE SE REPREND SUR LES LIBELLÉS, JAMAIS SUR LE NOMBRE D'ONGLETS.
      Depuis la v24 la barre peut compter quatre onglets. Quatre libellés longs
      ne tiennent pas sur un écran de 1024 px : dans ce cas seulement, et entre
      1024 et 1180 px seulement, css/nav.css bascule les libellés courts. Voir
      poseFeuilleNav() plus bas, et le calcul de largeurs en tête de nav.css.
   ========================================================================== */

import {
    signOut, isAdmin, myProfile, viewedProfile, isViewingOther, roleLabel,
    levelLabel, canReadAll, canManageAccounts, canWriteAny, canWriteViewed,
    isContributor, amContributor, jobLabel, linkFor, listProfiles, homePageFor
} from './api.js';

/* --------------------------------------------------------------------------
   La feuille de la barre

   css/nav.css contient les deux règles qui font tenir un quatrième onglet sur
   un écran étroit. Elle est posée ici plutôt que déclarée dans les huit pages :
   la barre appartient à ce fichier, sa feuille le suit, et une page nouvelle
   n'aura rien à penser.

   L'adresse est calculée depuis celle du module et non écrite en dur : nav.js
   vit dans js/, la feuille dans css/, et cela reste vrai quel que soit le
   dossier depuis lequel la page est servie.

   Chargement asynchrone, donc : sur le tout premier affichage, la barre peut
   apparaître une fraction de seconde avec ses libellés longs avant que la
   feuille arrive. Le voile de chargement couvre ce moment sur toutes les pages
   du projet. Si un jour il disparaissait, il faudrait remettre les <link> dans
   les pages.
   -------------------------------------------------------------------------- */

function poseFeuilleNav() {
    if (typeof document === 'undefined') return;
    if (document.querySelector('link[data-nav-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('../css/nav.css', import.meta.url).href;
    l.dataset.navCss = '1';
    (document.head || document.documentElement).appendChild(l);
}

poseFeuilleNav();

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
        // v24 : le calendrier était dans le menu de droite, il est ici. Un
        // écran de relecture que l'on ouvre en fin de semaine n'a rien à faire
        // derrière un bouton d'avatar, à côté du mot de passe et de la
        // déconnexion : ce n'est pas un réglage, c'est une lecture, et il se
        // place naturellement entre ce que l'on saisit et ce que cela donne.
        //
        // C'est ce quatrième onglet qui rend css/nav.css nécessaire.
        href: './calendrier.html', match: ['calendrier.html'],
        label: 'Mon calendrier', labelOther: 'Son calendrier',
        // « Agenda » et non « Calendrier » sur la barre du bas : cinq éléments
        // à se partager 320 px, il reste 56 px de texte par élément.
        short: 'Calendrier', mini: 'Agenda', icon: '🗓️',
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
    // Le calendrier n'est plus ici : il est passé dans la barre du haut en v24.
    // Il reste en bas de ce menu, avec les autres doublons d'onglets, pour le
    // téléphone en portrait.
    //
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
    // Miroir : en consultation, l'entrée mène au calendrier de la personne
    // regardée. Un écran de relecture qui change de personne en silence ferait
    // lire les chiffres d'un autre sans le dire.
    { href: './calendrier.html', label: 'Mon calendrier', labelOther: 'Son calendrier',
      icon: '🗓️', when: p => isContributor(p), onlyCollapsed: true, miroir: true },
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
    /* « Voir comme » : quand on consulte quelqu'un, le menu décrit AUSSI ce que
       cette personne a le droit d'ouvrir. Sans cela, le propriétaire verrait
       « Barème du score » et « Gérer les comptes » dans la peau d'un simple
       administrateur, alors que l'administrateur ne les a pas : ce ne serait pas
       voir ce qu'il voit. Seule « Mon compte » reste celle du lecteur, puisqu'elle
       ouvre SON mot de passe. */
    const menu = MENU.filter(m => m.when(
        (m.miroir || (autre && m.href !== './compte.html')) ? profilNav : me));

    /* Quatre onglets ou plus : les libellés passeront en version courte entre
       1024 et 1180 px. Le seuil est dans css/nav.css, la décision est ici,
       parce que seul ce fichier sait combien d'onglets cette personne voit. */
    nav.className = `topbar${sections.length >= 4 ? ' topbar--dense' : ''}`;
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

                ${canWriteAny(me) ? `<div class="menu-group menu-viewas">
                    <label class="menu-viewas-label" for="viewas-select">👁️ Voir comme…</label>
                    <select id="viewas-select" class="menu-viewas-select">
                        <option value="">${autre ? 'Revenir à mon compte' : 'Choisir un compte'}</option>
                    </select>
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

    wireViewAs(btn);
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
   Voir comme

   Réservé au propriétaire. La liste des comptes est lue au PREMIER dépliage du
   menu et non au chargement de chaque page : neuf pages sur dix n'ouvrent jamais
   ce menu, et lire la table des profils à chacune serait payer le réseau pour
   rien.

   La destination est la page d'accueil naturelle de la personne choisie
   (homePageFor) : pour un administrateur pur, c'est la vue d'équipe, qui est
   précisément ce qu'il voit en se connectant. Le contexte voyage dans l'URL
   (?u=), comme pour toute consultation : rien n'est caché, la page est
   rechargeable et il suffit de revenir sans paramètre pour être chez soi.
   -------------------------------------------------------------------------- */

function wireViewAs(btn) {
    const sel = document.getElementById('viewas-select');
    if (!sel || !btn) return;
    let loaded = false;

    const fill = async () => {
        if (loaded) return;
        loaded = true;
        try {
            const me = myProfile();
            const vu = viewedProfile();
            const list = (await listProfiles())
                .filter(p => p.is_active && p.user_id !== me.user_id)
                // Les plus hauts niveaux d'abord : le cas d'usage est de se
                // mettre à la place d'un administrateur, pas d'un membre.
                .sort((a, b) => (levelRankOf(b) - levelRankOf(a))
                    || String(a.display_name || a.email).localeCompare(String(b.display_name || b.email), 'fr'));
            list.forEach(p => {
                const o = document.createElement('option');
                o.value = p.user_id;
                const job = jobLabel(p);
                o.textContent = `${p.display_name || p.email} · ${levelLabel(p)}${job ? ' · ' + job : ''}`;
                o.dataset.page = homePageFor(p);
                if (vu && p.user_id === vu.user_id && vu.user_id !== me.user_id) o.selected = true;
                sel.appendChild(o);
            });
        } catch (e) {
            loaded = false;
            console.warn('Liste des comptes indisponible pour « Voir comme » :', e);
        }
    };

    btn.addEventListener('click', fill);
    document.getElementById('tabbar-more')?.addEventListener('click', fill);

    sel.addEventListener('change', () => {
        const id = sel.value;
        if (!id) {
            // Retour à son propre compte : même page d'accueil que la mienne.
            location.href = homePageFor(myProfile());
            return;
        }
        const page = sel.selectedOptions[0]?.dataset.page || './team.html';
        location.href = linkFor(page, id);
    });
}

const levelRankOf = p => ({ owner: 4, admin: 3, manager: 2, member: 1 }[p.access_level] || 1);

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

    /* Un compte qui ne prospecte pas (un administrateur pur, un responsable) n'a
       pas de journée à corriger : « voir son écran » veut dire voir l'outil tel
       qu'il le voit, onglets, droits et indicateurs. Le message le dit, et le
       bouton quitte ce mode au lieu de renvoyer à une équipe qu'on regarde déjà. */
    const commeObservateur = !isContributor(v);

    const el = document.createElement('div');
    el.id = 'context-bar';
    el.className = `ctxbar${ecrit && !commeObservateur ? ' ctxbar--write' : ''}`;
    el.innerHTML = `
        <span class="ctxbar-icon" aria-hidden="true">${commeObservateur ? '👁️' : ecrit ? '✏️' : '👁️'}</span>
        <span class="ctxbar-text">
            ${commeObservateur
                ? `Vous voyez l'application <b>comme ${name}</b> (${esc(roleLabel(v))}) : ses onglets, ses droits, ses indicateurs. Lecture seule.`
                : ecrit
                ? `Vous êtes dans le compte de <b>${name}</b> et vous voyez son écran. Tout ce que vous enregistrerez ici partira sur son compte, signalé comme une correction.`
                : `Vous voyez l'écran de <b>${name}</b>, en lecture seule.`}
        </span>
        ${commeObservateur
            ? `<a class="ctxbar-btn" href="${homePageFor(myProfile())}">Quitter ce mode</a>`
            : `<a class="ctxbar-btn" href="./team.html">Retour à l'équipe</a>`}`;

    const nav = document.getElementById('main-nav');
    if (nav) nav.insertAdjacentElement('afterend', el);
    else document.body.insertBefore(el, document.body.firstChild);
}
