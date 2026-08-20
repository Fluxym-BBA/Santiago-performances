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
    const activeAdmins = profiles.filter(p => p.role === 'admin' && p.is_active).length;

    body.innerHTML = profiles.map(p => {
        const s = stats.get(p.user_id) || { days: 0, last: null };
        const isMe = p.user_id === me.user_id;
        // Le dernier administrateur actif est verrouillé côté écran aussi, pour
        // que le bouton ne promette pas une action que la base refusera.
        const lastAdmin = p.role === 'admin' && p.is_active && activeAdmins <= 1;

        return `
        <tr${isMe ? ' class="row-me"' : ''}>
            <td>
                <input class="cell-input" data-name="${p.user_id}"
                       value="${escapeHtml(p.display_name || '')}"
                       placeholder="Nom affiché" aria-label="Nom affiché">
            </td>
            <td class="td-muted">${escapeHtml(p.email || '')}${isMe ? ' <b class="tag">vous</b>' : ''}</td>
            <td>
                <select class="cell-input" data-role="${p.user_id}"${lastAdmin ? ' disabled' : ''}
                        title="${lastAdmin ? 'Dernier administrateur actif : rôle verrouillé' : ''}">
                    <option value="bdr"${p.role === 'bdr' ? ' selected' : ''}>BDR</option>
                    <option value="admin"${p.role === 'admin' ? ' selected' : ''}>Administrateur</option>
                </select>
            </td>
            <td>
                <button class="toggle${p.is_demo ? ' toggle--on' : ''}" type="button"
                        data-demo="${p.user_id}" aria-pressed="${p.is_demo}">
                    ${p.is_demo ? 'Démo' : 'Réel'}
                </button>
            </td>
            <td>
                <button class="toggle${p.is_active ? ' toggle--on' : ''}" type="button"
                        data-active="${p.user_id}" aria-pressed="${p.is_active}"
                        ${lastAdmin ? 'disabled title="Dernier administrateur actif"' : ''}>
                    ${p.is_active ? 'Actif' : 'Désactivé'}
                </button>
            </td>
            <td>${s.days ? `<b>${fmtInt(s.days)}</b>` : '<span class="td-muted">aucune</span>'}</td>
            <td class="td-muted">${s.last ? formatLong(s.last) : '—'}</td>
            <td>
                <button class="chip chip--sm chip--danger" type="button"
                        data-wipe="${p.user_id}">Effacer les données</button>
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

    body.querySelectorAll('[data-role]').forEach(sel => {
        sel.addEventListener('change', () => {
            const id = sel.dataset.role;
            apply(id, { role: sel.value },
                `${nameOf(id)} est désormais ${sel.value === 'admin' ? 'administrateur' : 'BDR'}`);
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
        const session = await requireAuth();
        renderNav(session);

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
