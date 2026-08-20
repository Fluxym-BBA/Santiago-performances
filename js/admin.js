/* ==========================================================================
   ADMIN.JS — Gestion des comptes.

   Aucune règle de sécurité n'est appliquée ici : cet écran ne fait qu'appeler
   des fonctions de la base, qui vérifient elles-mêmes le rôle de l'appelant et
   protègent le dernier administrateur. Masquer un bouton dans un navigateur ne
   protège rien, la barrière est dans PostgreSQL.
   ========================================================================== */

import {
    requireAuth, isAdmin, myProfile, listProfiles, adminUpdateProfile,
    adminWipeActivity, fetchTeamRange, humanError, todayISO, addDaysISO, formatLong
} from './api.js';
import { renderNav } from './nav.js';
import { escapeHtml, fmtInt, toast, hideVeil } from './ui.js';

let profiles = [];
let stats = new Map();   // user_id -> { days, last }

/* --------------------------------------------------------------------------
   Chargement
   -------------------------------------------------------------------------- */

async function load() {
    profiles = await listProfiles();

    // Volume de saisie par compte, sur une fenêtre large : sert à savoir si un
    // compte est réellement utilisé avant de le désactiver.
    stats = new Map();
    try {
        const rows = await fetchTeamRange(addDaysISO(todayISO(), -730), todayISO(),
            { includeDemo: true, includeInactive: true });
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
}

/* --------------------------------------------------------------------------
   Rendu
   -------------------------------------------------------------------------- */

function render() {
    const body = document.getElementById('admin-body');
    const me = myProfile();
    const activeAdmins = profiles.filter(p => p.is_admin && p.is_active).length;

    body.innerHTML = profiles.map(p => {
        const s2 = stats.get(p.user_id) || { days: 0, last: null };
        const isMe = p.user_id === me.user_id;
        // Le dernier administrateur actif est verrouillé côté écran aussi, pour
        // que le bouton ne promette pas une action que la base refusera.
        const lastAdmin = p.is_admin && p.is_active && activeAdmins <= 1;
        const lockNote = lastAdmin
            ? 'Seul administrateur actif : nommez quelqu\'un d\'autre pour pouvoir changer ce réglage'
            : '';

        return `
        <tr${isMe ? ' class="row-me"' : ''}>
            <td data-th="Nom">
                <input class="cell-input" data-name="${p.user_id}"
                       value="${escapeHtml(p.display_name || '')}"
                       placeholder="Nom affiché" aria-label="Nom affiché">
            </td>
            <td data-th="E-mail" class="td-muted td-mail">${escapeHtml(p.email || '')}${
                isMe ? ' <b class="badge">vous</b>' : ''}</td>
            <td data-th="Administrateur">
                <button class="toggle${p.is_admin ? ' toggle--on' : ''}" type="button"
                        data-admin="${p.user_id}" aria-pressed="${p.is_admin}"
                        ${lastAdmin ? `disabled title="${lockNote}"` : ''}>
                    ${p.is_admin ? 'Administrateur' : 'Non'}
                </button>
                ${lastAdmin ? `<span class="cell-note">${lockNote}</span>` : ''}
            </td>
            <td data-th="Prospecte">
                <button class="toggle${p.is_bdr ? ' toggle--on' : ''}" type="button"
                        data-bdr="${p.user_id}" aria-pressed="${p.is_bdr}">
                    ${p.is_bdr ? 'BDR' : 'Ne saisit pas'}
                </button>
            </td>
            <td data-th="Démo">
                <button class="toggle${p.is_demo ? ' toggle--on toggle--warn' : ''}" type="button"
                        data-demo="${p.user_id}" aria-pressed="${p.is_demo}">
                    ${p.is_demo ? 'Démo' : 'Réel'}
                </button>
            </td>
            <td data-th="Actif">
                <button class="toggle${p.is_active ? ' toggle--on' : ''}" type="button"
                        data-active="${p.user_id}" aria-pressed="${p.is_active}"
                        ${lastAdmin ? `disabled title="${lockNote}"` : ''}>
                    ${p.is_active ? 'Actif' : 'Désactivé'}
                </button>
            </td>
            <td data-th="Jours saisis">${
                !p.is_bdr ? '<span class="td-muted">sans objet</span>'
                : s2.days ? `<b>${fmtInt(s2.days)}</b>` : '<span class="td-muted">aucune</span>'}</td>
            <td data-th="Dernière saisie" class="td-muted">${
                !p.is_bdr ? '—' : s2.last ? formatLong(s2.last) : '—'}</td>
            <td data-th="Données">
                ${p.is_bdr ? `<button class="chip chip--sm chip--danger" type="button"
                        data-wipe="${p.user_id}">Effacer</button>` : '<span class="td-muted">—</span>'}
            </td>
        </tr>`;
    }).join('');

    wireRows();
}

function nameOf(id) {
    const p = profiles.find(x => x.user_id === id);
    return p ? (p.display_name || p.email || 'ce compte') : 'ce compte';
}

async function apply(userId, patch, message) {
    try {
        const updated = await adminUpdateProfile(userId, patch);
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

    body.querySelectorAll('[data-admin]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.admin;
            const p = profiles.find(x => x.user_id === id);
            apply(id, { is_admin: !p.is_admin },
                !p.is_admin
                    ? `${nameOf(id)} est désormais administrateur`
                    : `${nameOf(id)} n'est plus administrateur`);
        });
    });

    // Les deux axes sont indépendants : administrer et prospecter sont deux
    // questions distinctes, et c'est tout l'intérêt du modèle.
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
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

(async function main() {
    try {
        const session = await requireAuth({ needs: 'admin' });
        renderNav();

        if (!isAdmin()) {
            document.querySelector('.page-main').innerHTML = `
                <div class="page-container"><div class="chart-card">
                    <h3 class="chart-title">Page réservée aux administrateurs</h3>
                    <p class="chart-sub">Votre compte n'a pas accès à la gestion des comptes.
                       Retournez à <a href="./dashboard.html">vos performances</a>.</p>
                </div></div>`;
            hideVeil();
            return;
        }

        document.getElementById('btn-reload').addEventListener('click', async () => {
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
