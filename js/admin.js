/* ==========================================================================
   ADMIN.JS — Gestion des comptes.

   Aucune règle de sécurité n'est appliquée ici. Cet écran ne fait qu'appeler
   des fonctions de la base et une fonction hébergée chez Supabase, qui
   vérifient elles-mêmes le rôle de l'appelant. Masquer un bouton dans un
   navigateur ne protège rien : la barrière est dans PostgreSQL et dans
   l'Edge Function.

   Ce que fait cet écran, en revanche, c'est ne jamais promettre une action
   qui sera refusée. Un bouton désactivé dit pourquoi il l'est, et la création
   de compte n'apparaît que si la fonction qui la réalise répond vraiment.

   Le pouvoir est une échelle à quatre barreaux, et non deux cases : membre,
   responsable, administrateur, propriétaire. La règle est unique et recopiée
   ici telle qu'elle est écrite dans la base, pour que l'écran refuse ce que la
   base refuserait : on n'agit que sur un compte de niveau strictement
   inférieur au sien, et on n'attribue jamais un niveau supérieur ou égal au
   sien. Son propre compte est la seule exception à la première moitié.
   ========================================================================== */

import {
    requireAuth, myProfile, listProfiles, adminSetLevel,
    adminWipeActivity, fetchTeamRange, humanError, todayISO, addDaysISO, formatLong,
    adminFnStatus, adminAuthInfo, adminCreateAccount, adminSetPassword,
    adminDeleteAccount, adminDeletePreview,
    LEVELS, rankOfLevel, levelLabel, canManageAccounts, myRank
} from './api.js';
import { renderNav } from './nav.js';
import { escapeHtml, fmtInt, toast, hideVeil } from './ui.js';

/* Ce que chaque niveau autorise, en une ligne. L'échelle elle-même vit dans
   api.js : ici on ne fait que l'expliquer à l'écran, au moment du choix. */
const LEVEL_HINT = {
    owner:   'tout, y compris corriger les chiffres des autres',
    admin:   'voit toute l\'équipe et gère les comptes, mais ne corrige pas les chiffres d\'autrui',
    manager: 'voit toute l\'équipe en lecture, ne gère aucun compte',
    member:  'ne voit que ses propres chiffres'
};

const labelOf = key => (LEVELS.find(l => l.key === key) || {}).label || key;

let profiles = [];
let stats = new Map();    // user_id -> { days, last }
let auth = new Map();     // user_id -> { last_sign_in_at, created_at, ... }
let fn = { ok: false };   // état de l'Edge Function

/* --------------------------------------------------------------------------
   Chargement
   -------------------------------------------------------------------------- */

async function load() {
    profiles = await listProfiles();

    // Volume de saisie par compte, sur une fenêtre large : sert à savoir si un
    // compte est réellement utilisé avant de le désactiver ou de le supprimer.
    stats = new Map();
    try {
        // Aucun filtre : sur cet écran on veut voir ce qui existe, y compris
        // l'historique d'un compte qu'on vient de retirer des BDR. Le masquer
        // conduirait à supprimer un compte en croyant qu'il est vide.
        const rows = await fetchTeamRange(addDaysISO(todayISO(), -730), todayISO(),
            { includeDemo: true, includeInactive: true, onlyBdr: false });
        rows.forEach(r => {
            const s = stats.get(r.user_id) || { days: 0, last: null };
            if (Number(r.total_actions) > 0) {
                s.days++;
                if (!s.last || r.activity_date > s.last) s.last = r.activity_date;
            }
            stats.set(r.user_id, s);
        });
    } catch {
        // Pas bloquant : le tableau reste utilisable sans les statistiques.
    }

    // Dernière connexion : elle vit dans auth.users, hors d'atteinte de la clé
    // publique. Seule la fonction peut la lire. Son absence n'empêche rien.
    auth = new Map();
    if (fn.ok) {
        try { auth = await adminAuthInfo(); } catch { /* colonne laissée vide */ }
    }
}

/* --------------------------------------------------------------------------
   Petits formats
   -------------------------------------------------------------------------- */

/** Horodatage en clair, avec l'ancienneté qui est l'information utile. */
function whenLabel(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    if (isNaN(d)) return null;
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    const date = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' });
    if (days <= 0) return { date, ago: "aujourd'hui", stale: false };
    if (days === 1) return { date, ago: 'hier', stale: false };
    if (days < 30) return { date, ago: `il y a ${days} j`, stale: days > 14 };
    const months = Math.round(days / 30);
    return { date, ago: `il y a ${months} mois`, stale: true };
}

function nameOf(id) {
    const p = profiles.find(x => x.user_id === id);
    return p ? (p.display_name || p.email || 'ce compte') : 'ce compte';
}

/* --------------------------------------------------------------------------
   Rendu du tableau

   Six colonnes, pas onze. Les réglages qui répondent à la même question sont
   regroupés dans une seule cellule : le niveau d'accès et « Prospecte » sont
   deux facettes du rôle, « Démo » et « Actif » deux facettes du statut. Un
   tableau qu'on lit sans faire défiler vaut mieux qu'un tableau exhaustif.

   Le niveau est une liste déroulante et non quatre boutons : quatre boutons
   par ligne doubleraient la largeur de la colonne, et un libellé coupé est
   proscrit dans ce projet. La liste montre les quatre barreaux de l'échelle,
   ceux qui sont hors de portée étant présents mais non choisissables : le
   niveau réel du compte reste ainsi lisible même quand on ne peut pas y
   toucher.
   -------------------------------------------------------------------------- */

/** Les options du sélecteur de niveau pour un compte donné. */
function levelOptions(p, myRankNow) {
    return LEVELS.map(l => {
        const current = l.key === p.access_level;
        // La base refuse d'attribuer un niveau supérieur ou égal au sien. On ne
        // le propose donc pas, mais on garde l'option quand elle décrit l'état
        // réel du compte, sinon le sélecteur afficherait un niveau faux.
        const off = !current && l.rank >= myRankNow;
        return `<option value="${l.key}"${current ? ' selected' : ''}`
             + `${off ? ' disabled' : ''}>${l.label}</option>`;
    }).join('');
}

function render() {
    const body = document.getElementById('admin-body');
    const me = myProfile();
    const myRankNow = myRank();
    const activeOwners = profiles.filter(p => p.access_level === 'owner' && p.is_active).length;

    body.innerHTML = profiles.map(p => {
        const s2 = stats.get(p.user_id) || { days: 0, last: null };
        const a = auth.get(p.user_id) || null;
        const isMe = p.user_id === me.user_id;

        // rankOfLevel et non levelRank : ici on compare des niveaux entre eux,
        // comme le fait la base. levelRank renverrait zéro pour un compte
        // désactivé et laisserait croire qu'un administrateur mis de côté est
        // redevenu modifiable par tout le monde.
        const pRank = rankOfLevel(p.access_level);

        // La règle unique, côté cible. Son propre compte échappe à la
        // comparaison, exactement comme dans admin_set_level. Le premier terme
        // est une ceinture de sécurité : sous le niveau administrateur, la base
        // refuse tout, et l'écran ne doit pas proposer ce qu'elle refusera,
        // même si main() interdit déjà la page.
        const locked = myRankNow < 3 || (!isMe && pRank >= myRankNow);

        // Le dernier propriétaire actif ne peut être ni rétrogradé, ni
        // désactivé, ni supprimé : la base le refuse, l'écran ne le propose pas.
        const lastOwner = p.access_level === 'owner' && p.is_active && activeOwners <= 1;

        const note = locked
            ? `Niveau ${levelLabel(p).toLowerCase()}, égal ou supérieur au vôtre : `
              + `la base refuse toute modification de ce compte`
            : lastOwner
                ? 'Dernier propriétaire actif : nommez un autre propriétaire avant de '
                  + 'changer son niveau ou de le désactiver'
                : '';
        const lockAttr = locked ? ` disabled title="${note}"` : '';
        const frozen = locked || lastOwner;
        const frozenAttr = frozen ? ` disabled title="${note}"` : '';
        const seen = a ? whenLabel(a.last_sign_in_at) : null;
        const who = escapeHtml(p.display_name || p.email || 'ce compte');

        return `
        <tr${isMe ? ' class="row-me"' : ''}>
            <td data-th="Compte">
                <div class="acct">
                    <input class="cell-input" data-name="${p.user_id}"
                           value="${escapeHtml(p.display_name || '')}"
                           placeholder="Nom affiché" aria-label="Nom affiché"${lockAttr}>
                    <span class="acct-mail">${escapeHtml(p.email || '')}${
                        isMe ? ' <b class="badge">vous</b>' : ''}</span>
                </div>
            </td>

            <td data-th="Rôle">
                <div class="tog-stack">
                    <select class="chart-select level-select" data-level="${p.user_id}"
                            aria-label="Niveau d'accès de ${who}"${frozenAttr}>
                        ${levelOptions(p, myRankNow)}
                    </select>
                    <button class="toggle${p.is_bdr ? ' toggle--on' : ''}" type="button"
                            data-bdr="${p.user_id}" aria-pressed="${p.is_bdr}"${lockAttr}>
                        ${p.is_bdr ? 'Prospecte' : 'Ne prospecte pas'}
                    </button>
                </div>
                ${note ? `<span class="cell-note">${note}</span>` : ''}
            </td>

            <td data-th="Statut">
                <div class="tog-stack">
                    <button class="toggle${p.is_active ? ' toggle--on' : ''}" type="button"
                            data-active="${p.user_id}" aria-pressed="${p.is_active}"${frozenAttr}>
                        ${p.is_active ? 'Actif' : 'Désactivé'}
                    </button>
                    <button class="toggle${p.is_demo ? ' toggle--on toggle--warn' : ''}" type="button"
                            data-demo="${p.user_id}" aria-pressed="${p.is_demo}"${lockAttr}>
                        ${p.is_demo ? 'Démonstration' : 'Compte réel'}
                    </button>
                </div>
            </td>

            <td data-th="Connexion">
                ${!a ? '<span class="td-muted">—</span>'
                  : !seen ? '<span class="tag tag--never">jamais connecté</span>'
                  : `<div class="stack-2">
                        <b>${seen.date}</b>
                        <span class="td-muted${seen.stale ? ' is-stale' : ''}">${seen.ago}</span>
                     </div>`}
            </td>

            <td data-th="Saisie">
                ${!s2.days ? `<span class="td-muted">${p.is_bdr ? 'aucune' : 'sans objet'}</span>`
                  : `<div class="stack-2">
                        <b>${fmtInt(s2.days)} jour${s2.days > 1 ? 's' : ''}</b>
                        <span class="td-muted">dernière le ${formatLong(s2.last).replace(/^\w+\s/, '')}</span>
                     </div>`}
            </td>

            <td data-th="Actions">
                <div class="act-row">
                    ${fn.ok ? `<button class="chip chip--sm" type="button"
                            data-pass="${p.user_id}"${lockAttr}>Mot de passe</button>` : ''}
                    ${s2.days ? `<button class="chip chip--sm chip--warn" type="button"
                            data-wipe="${p.user_id}"${lockAttr}>Effacer données</button>` : ''}
                    ${fn.ok && !isMe ? `<button class="chip chip--sm chip--danger" type="button"
                            data-del="${p.user_id}"${lockAttr}>Supprimer</button>` : ''}
                    ${!fn.ok && !s2.days ? '<span class="td-muted">—</span>' : ''}
                </div>
            </td>
        </tr>`;
    }).join('');

    wireRows();
}

/* --------------------------------------------------------------------------
   Modifications de profil
   -------------------------------------------------------------------------- */

async function apply(userId, patch, message) {
    try {
        const updated = await adminSetLevel(userId, patch);
        const i = profiles.findIndex(p => p.user_id === userId);
        if (i >= 0 && updated) profiles[i] = updated;
        toast(message, 'success');
        render();
    } catch (e) {
        toast(humanError(e), 'error');
        render();   // remet l'affichage en accord avec l'état réel
    }
}

function wireRows() {
    const body = document.getElementById('admin-body');

    // Nom : enregistré à la sortie du champ ou sur Entrée, pas à chaque frappe.
    body.querySelectorAll('[data-name]').forEach(input => {
        const save = () => {
            const id = input.dataset.name;
            const p = profiles.find(x => x.user_id === id);
            const v = input.value.trim();
            if (!v || v === p.display_name) { input.value = p.display_name || ''; return; }
            apply(id, { display_name: v }, `Nom mis à jour : ${v}`);
        };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    });

    // Niveau d'accès. Une liste déroulante n'a pas d'état intermédiaire : la
    // valeur choisie est envoyée telle quelle, et la base tranche. En cas de
    // refus, apply() rappelle render(), ce qui remet le sélecteur sur le niveau
    // réel du compte au lieu de laisser à l'écran un choix qui n'a pas eu lieu.
    body.querySelectorAll('[data-level]').forEach(sel => {
        sel.addEventListener('change', () => {
            const id = sel.dataset.level;
            const p = profiles.find(x => x.user_id === id);
            const level = sel.value;
            if (!p || !level || level === p.access_level) return;

            const label = labelOf(level);
            const hint = LEVEL_HINT[level] || '';
            const down = rankOfLevel(level) < rankOfLevel(p.access_level);
            const isMe = id === myProfile().user_id;

            // Une baisse de niveau retire des accès à quelqu'un qui s'en sert
            // peut-être aujourd'hui. Sur son propre compte, elle peut en outre
            // fermer la porte derrière soi : les deux méritent d'être dits
            // avant, pas découverts après.
            let ask = '';
            if (isMe) {
                ask = `ATTENTION : c'est votre propre compte.\n\n`
                    + `Passer au niveau « ${label} » (${hint}).\n\n`
                    + `Vous ne pourrez pas revenir en arrière vous-même : `
                    + `seul un compte de niveau supérieur pourra vous le rendre.`;
            } else if (down) {
                ask = `Ramener ${nameOf(id)} au niveau « ${label} » ?\n\n`
                    + `Ce niveau ${hint}.`;
            }
            if (ask && !confirm(ask)) { sel.value = p.access_level; return; }

            apply(id, { access_level: level },
                `${nameOf(id)} passe au niveau ${label.toLowerCase()}`);
        });
    });

    // Les deux axes restent indépendants : le niveau dit ce que le compte a le
    // droit de voir et de faire, « Prospecte » dit s'il saisit son activité.
    // Un responsable peut prospecter, un administrateur peut ne pas prospecter.
    body.querySelectorAll('[data-bdr]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.bdr;
            const p = profiles.find(x => x.user_id === id);
            if (p.is_bdr && (stats.get(id)?.days || 0) > 0 && !confirm(
                `${nameOf(id)} a déjà saisi ${stats.get(id).days} journée(s).\n\n`
                + `En le retirant des BDR, ses données restent en base mais il `
                + `disparaît des classements et perd l'accès à la saisie.\n\nContinuer ?`)) return;
            apply(id, { is_bdr: !p.is_bdr },
                !p.is_bdr
                    ? `${nameOf(id)} saisit désormais son activité`
                    : `${nameOf(id)} ne saisit plus d'activité et sort des classements`);
        });
    });

    body.querySelectorAll('[data-demo]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.demo;
            const p = profiles.find(x => x.user_id === id);
            apply(id, { is_demo: !p.is_demo },
                !p.is_demo
                    ? `${nameOf(id)} est marqué compte de démonstration : ses chiffres sortent des classements`
                    : `${nameOf(id)} redevient un compte réel`);
        });
    });

    body.querySelectorAll('[data-active]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.active;
            const p = profiles.find(x => x.user_id === id);
            if (p.is_active && !confirm(
                `Désactiver ${nameOf(id)} ?\n\nLa personne ne pourra plus se connecter. `
                + `Son historique est conservé et pourra être réactivé à tout moment.`)) return;
            apply(id, { is_active: !p.is_active },
                p.is_active ? `${nameOf(id)} est désactivé` : `${nameOf(id)} est réactivé`);
        });
    });

    body.querySelectorAll('[data-wipe]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.wipe;
            const s = stats.get(id) || { days: 0 };
            if (!confirm(
                `Effacer TOUTES les données d'activité de ${nameOf(id)} ?\n\n`
                + `${s.days} journée(s) saisie(s) seront supprimées définitivement. `
                + `Le compte lui-même est conservé.\n\nCette action est irréversible.`)) return;
            // Deuxième confirmation pour un compte réel : sur un compte de
            // démonstration l'effacement est banal, sur un vrai BDR il détruit
            // des semaines de saisie.
            const p = profiles.find(x => x.user_id === id);
            if (!p.is_demo && !confirm(
                `${nameOf(id)} n'est pas un compte de démonstration.\n\n`
                + `Confirmez une seconde fois l'effacement définitif.`)) return;
            try {
                const n = await adminWipeActivity(id);
                toast(`${fmtInt(n)} journée(s) effacée(s) pour ${nameOf(id)}`, 'success');
                await load();
                render();
            } catch (e) {
                toast(humanError(e), 'error');
            }
        });
    });

    // Nouveau mot de passe. Le mot de passe est tiré par le serveur, jamais
    // ici : un seul générateur dans tout le projet, donc une seule qualité
    // d'aléa à garantir.
    body.querySelectorAll('[data-pass]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.pass;
            const isMe = id === myProfile().user_id;
            if (!confirm(
                `Générer un nouveau mot de passe pour ${nameOf(id)} ?\n\n`
                + `L'ancien cessera immédiatement de fonctionner.`
                + (isMe ? `\n\nATTENTION : c'est votre propre compte. Notez bien le nouveau `
                        + `mot de passe, il vous servira à la prochaine connexion.` : ''))) return;
            btn.disabled = true;
            const before = btn.textContent;
            btn.textContent = 'Génération…';
            try {
                const r = await adminSetPassword(id, null);
                showCredentials({
                    title: `Nouveau mot de passe pour ${nameOf(id)}`,
                    email: r.email, password: r.password
                });
                toast('Mot de passe remplacé', 'success');
            } catch (e) {
                toast(humanError(e), 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = before;
            }
        });
    });

    // Suppression définitive. Le décompte affiché vient de la base, pas de la
    // mémoire de l'écran : sur une action irréversible, on ne devine pas.
    body.querySelectorAll('[data-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.del;
            const p = profiles.find(x => x.user_id === id);

            let prev = null;
            try { prev = await adminDeletePreview(id); } catch { /* on continue sans */ }
            const days = prev ? Number(prev.days_recorded) || 0 : (stats.get(id)?.days || 0);

            if (prev?.is_last_admin) {
                toast('Impossible : ce compte est le dernier administrateur actif', 'error');
                return;
            }

            // Le bon réflexe pour un départ est la désactivation. On le dit ici,
            // au moment exact où la mauvaise décision est sur le point d'être prise.
            let msg = `Supprimer définitivement ${nameOf(id)} ?\n\n`;
            if (days) {
                msg += `${days} journée(s) de saisie seront détruites`;
                if (prev?.first_day) msg += ` (du ${prev.first_day} au ${prev.last_day})`;
                msg += `.\n\nSi c'est un départ, préférez « Désactivé » : l'accès est coupé `
                     + `et les chiffres passés restent comparables.\n\n`;
            } else {
                msg += `Ce compte n'a aucune saisie.\n\n`;
            }
            msg += `Cette action est irréversible.`;
            if (!confirm(msg)) return;

            // Deuxième confirmation par la frappe de l'adresse : sur une
            // destruction totale, un clic distrait ne doit pas suffire.
            const expect = (p.email || '').trim();
            if (expect) {
                const typed = prompt(
                    `Pour confirmer, saisissez l'adresse du compte à supprimer :\n\n${expect}`);
                if (typed === null) return;
                if (typed.trim().toLowerCase() !== expect.toLowerCase()) {
                    toast('Adresse non conforme, suppression annulée', 'error');
                    return;
                }
            }

            btn.disabled = true;
            btn.textContent = 'Suppression…';
            try {
                const r = await adminDeleteAccount(id);
                toast(`${r.display_name || r.email || 'Le compte'} supprimé`
                    + (r.days_removed ? ` avec ${fmtInt(r.days_removed)} journée(s)` : ''), 'success');
                await load();
                render();
            } catch (e) {
                toast(humanError(e), 'error');
                btn.disabled = false;
                btn.textContent = 'Supprimer';
            }
        });
    });
}

/* --------------------------------------------------------------------------
   Identifiants à transmettre

   Le mot de passe n'existe en clair qu'ici, et pour quelques secondes. Il n'est
   ni journalisé, ni stocké, ni relisible. Le bouton de copie prépare donc un
   message prêt à envoyer, parce que c'est le geste réel qui suit : sans lui,
   l'administrateur recopie à la main et se trompe.
   -------------------------------------------------------------------------- */

let lastCred = null;

function showCredentials({ title, email, password }) {
    lastCred = { email, password };
    const loginUrl = new URL('./login.html', location.href).toString();

    document.getElementById('cred-title').textContent = title;
    document.getElementById('cred-email').textContent = email;
    document.getElementById('cred-pass').textContent = password;
    document.getElementById('cred-url').textContent = loginUrl;

    const card = document.getElementById('cred-card');
    card.hidden = false;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function credMessage() {
    if (!lastCred) return '';
    const loginUrl = new URL('./login.html', location.href).toString();
    return [
        `Voici ton accès au Cockpit BDR.`,
        ``,
        `Adresse : ${loginUrl}`,
        `Identifiant : ${lastCred.email}`,
        `Mot de passe provisoire : ${lastCred.password}`,
        ``,
        `Ce mot de passe est provisoire : change-le après ta première connexion.`
    ].join('\n');
}

async function copyCred() {
    const txt = credMessage();
    try {
        await navigator.clipboard.writeText(txt);
        toast('Message copié, prêt à envoyer', 'success');
    } catch {
        // Le presse-papiers est refusé hors contexte sécurisé ou sans geste
        // utilisateur reconnu. Une sélection manuelle reste possible.
        const ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand && document.execCommand('copy');
        ta.remove();
        toast(ok ? 'Message copié' : 'Copie refusée par le navigateur, sélectionnez le texte',
            ok ? 'success' : 'error');
    }
}

/* --------------------------------------------------------------------------
   Formulaire de création
   -------------------------------------------------------------------------- */

/** Dit en une phrase ce que le compte pourra faire : le niveau et la case
    « Prospecte » se combinent, et la combinaison n'est pas devinable. */
function roleSentence() {
    const level = document.getElementById('f-level').value || 'member';
    const bdr = document.getElementById('f-bdr').checked;
    const demo = document.getElementById('f-demo').checked;

    const voit = level === 'member'
        ? 'Ne voit que ses propres chiffres.'
        : level === 'manager'
            ? 'Voit toute l\'équipe et ses classements, en lecture seule : aucun compte à gérer, aucune saisie d\'autrui à corriger.'
            : level === 'admin'
                ? 'Voit toute l\'équipe et gère les comptes. Ne peut pas corriger les chiffres de quelqu\'un d\'autre : seul le propriétaire le peut.'
                : 'Tout, y compris corriger les chiffres des autres.';

    const fait = bdr
        ? ' Saisit son activité, a ses performances et apparaît dans les classements.'
        : ' Ne saisit rien : ni page de saisie, ni score, absent des classements.';

    let s = voit + fait;
    if (demo) s += ' Compte de démonstration : ses chiffres restent hors des classements réels.';
    return s;
}

function wireForm() {
    const block = document.getElementById('new-block');
    const form = document.getElementById('new-form');
    const btnNew = document.getElementById('btn-new');
    const note = document.getElementById('f-role-note');
    const level = document.getElementById('f-level');

    block.hidden = false;

    // Le sélecteur est peuplé ici et non dans le HTML : l'échelle des niveaux
    // n'a qu'une seule source de vérité, api.js, et la liste s'arrête à ce que
    // l'on a le droit d'attribuer. On ne fabrique pas son égal.
    const rank = myRank();
    level.innerHTML = LEVELS.filter(l => l.rank < rank)
        .map(l => `<option value="${l.key}"${l.key === 'member' ? ' selected' : ''}>`
                + `${l.label}</option>`).join('');

    const refreshNote = () => { note.textContent = roleSentence(); };
    ['f-level', 'f-bdr', 'f-demo'].forEach(id =>
        document.getElementById(id).addEventListener('change', refreshNote));
    refreshNote();

    const open = () => {
        form.hidden = false;
        btnNew.hidden = true;
        document.getElementById('f-email').focus();
    };
    const close = () => {
        form.hidden = true;
        btnNew.hidden = false;
        form.reset();
        refreshNote();
        document.getElementById('f-status').textContent = '';
    };

    btnNew.addEventListener('click', open);
    document.getElementById('f-cancel').addEventListener('click', close);

    form.addEventListener('submit', async ev => {
        ev.preventDefault();
        const submit = document.getElementById('f-submit');
        const status = document.getElementById('f-status');
        const email = document.getElementById('f-email').value.trim();
        const pass = document.getElementById('f-pass').value;

        if (pass && pass.length < 8) {
            status.textContent = 'Le mot de passe doit faire au moins 8 caractères.';
            return;
        }

        submit.disabled = true;
        status.textContent = 'Création du compte…';
        // La fonction de création ne connaît que l'ancienne case
        // « administrateur ». Les niveaux « membre » et « administrateur » sont
        // donc obtenus directement, et « responsable », qui n'a pas
        // d'équivalent, est appliqué juste après par la base. Deux appels au
        // lieu d'un, mais aucune modification de la fonction hébergée : elle
        // sera reprise plus tard, avec un seul appel.
        const wanted = document.getElementById('f-level').value || 'member';
        try {
            const r = await adminCreateAccount({
                email,
                display_name: document.getElementById('f-name').value.trim(),
                is_admin: wanted === 'admin' || wanted === 'owner',
                is_bdr: document.getElementById('f-bdr').checked,
                is_demo: document.getElementById('f-demo').checked,
                password: pass || null
            });

            // Le compte existe : à partir d'ici on n'échoue plus sans afficher
            // le mot de passe, qui n'est lisible qu'une fois.
            if (wanted === 'manager' && r.user_id) {
                try {
                    await adminSetLevel(r.user_id, { access_level: 'manager' });
                } catch (e) {
                    toast(`Compte créé, mais le niveau responsable n'a pas pu être `
                        + `appliqué : ${humanError(e)}. Réglez-le dans le tableau.`, 'error');
                }
            }
            close();
            showCredentials({
                title: `Compte créé pour ${r.email}`,
                email: r.email, password: r.password
            });
            await load();
            render();
            toast('Compte créé', 'success');
        } catch (e) {
            status.textContent = humanError(e);
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('cred-copy').addEventListener('click', copyCred);
    document.getElementById('cred-close').addEventListener('click', () => {
        document.getElementById('cred-card').hidden = true;
        document.getElementById('cred-pass').textContent = '';
        lastCred = null;
    });
}

/** La fonction ne répond pas : on explique la voie manuelle, sans mentir. */
function showManual(fnState) {
    const block = document.getElementById('manual-block');
    block.hidden = false;
    if (fnState.reason === 'refus') {
        document.getElementById('manual-title').textContent =
            'La création depuis cette page a été refusée';
        document.getElementById('manual-why').textContent =
            'La fonction admin-users existe bien mais a refusé la demande : '
            + (fnState.message || 'raison inconnue')
            + '. En attendant, la création manuelle fonctionne parfaitement.';
        document.getElementById('manual-note').textContent =
            'Si le message parle de variables d\'environnement, vérifiez que la fonction '
            + 'a bien accès à SUPABASE_SERVICE_ROLE_KEY dans ses secrets.';
    }
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

(async function main() {
    try {
        await requireAuth({ needs: 'admin' });
        renderNav();

        if (!canManageAccounts()) {
            document.querySelector('.page-main').innerHTML = `
                <div class="page-container"><div class="chart-card">
                    <h3 class="chart-title">Page réservée aux administrateurs</h3>
                    <p class="chart-sub">Votre niveau d'accès ne permet pas de gérer les comptes.
                       Retournez à <a href="./dashboard.html">vos performances</a>.</p>
                </div></div>`;
            hideVeil();
            return;
        }

        // L'état de la fonction est connu AVANT le premier rendu : il décide de
        // l'affichage du formulaire, de la colonne « Connexion » et des boutons
        // de mot de passe et de suppression.
        fn = await adminFnStatus();
        if (fn.ok) wireForm(); else showManual(fn);

        document.getElementById('btn-reload').addEventListener('click', async () => {
            fn = await adminFnStatus({ force: true });
            await load();
            render();
            toast('Comptes rechargés');
        });

        await load();
        render();
        hideVeil();
    } catch (e) {
        if (String(e.message || e).includes('Non authentifié')) return;
        toast(humanError(e), 'error');
        hideVeil();
    }
})();
