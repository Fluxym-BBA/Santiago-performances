/* ==========================================================================
   ENTREPRISES.JS — le carnet d'entreprises, et son ménage.

   POURQUOI CET ÉCRAN EXISTE

   Depuis la v10, taper un nom inconnu dans une ligne du cycle de vente crée
   l'entreprise. C'est voulu : le carnet se constitue en travaillant, personne
   n'a à le remplir d'avance. Mais rien ne permettait de défaire une faute de
   frappe. « carefour » saisi le 26 août restait proposé à l'autocomplétion à
   côté de CARREFOUR, et supprimer la ligne d'activité n'y changeait rien
   puisque l'entreprise vit sa propre vie. Aucune politique DELETE n'existait
   sur la table : elle refusait toute suppression, sans message et sans recours.

   CINQ PARTIS PRIS

   1. TOUT LE MONDE PEUT SUPPRIMER, PAS SEULEMENT L'ADMINISTRATEUR. Celui qui
      se trompe est celui qui saisit, et il se trompe le soir, seul. Faire
      passer la correction par Bruno, c'est laisser le doublon vivre une
      semaine, donc laisser les statistiques par client se tromper.

   2. LE CRITÈRE EST « AUCUNE ACTION RATTACHÉE », JUGÉ PAR LA BASE. Et pas par
      cet écran : la RLS de sales_events ne montre à un membre que ses propres
      lignes, un décompte fait ici serait faux, et l'écran ferait supprimer le
      nom d'une entreprise travaillée par un collègue. C'est
      accounts_overview() puis delete_account() qui comptent, toutes personnes
      confondues.

   3. LE FONDS SALESFORCE EST RÉSERVÉ AU PROPRIÉTAIRE. Les 445 noms chargés le
      26 août n'ont, eux aussi, aucune action rattachée : la règle nue les
      aurait rendus tous effaçables, par n'importe quel compte connecté.

   4. LA FUSION EXISTE PARCE QUE LA SUPPRESSION NE SUFFIT PAS. Quand le doublon
      porte déjà des actions, la seule réponse honnête est de les déplacer.
      Réservée au propriétaire : elle touche aux déclarations d'autres
      personnes.

   5. RIEN N'EST TRONQUÉ EN SILENCE. La liste s'arrête à 200 lignes et dit
      combien elle en cache. Une liste qui coupe sans le dire fait croire qu'un
      nom n'existe pas, et fait recréer le doublon qu'on venait supprimer.

   CE QUE CET ÉCRAN N'EST PAS : un référentiel client. C'est le carnet
   d'adresses du Cockpit, fait pour écrire un nom vite et deux fois de la même
   façon. Salesforce reste le référentiel, et rien d'ici n'y remonte.
   ========================================================================== */

import {
    requireAuth, myProfile, canWriteAny, humanError,
    accountsOverview, deleteAccount, mergeAccounts,
    accountKey, formatDMY
} from './api.js';
import { renderNav } from './nav.js';
import { escapeHtml, toast, hideVeil, fmtInt } from './ui.js';

/**
 * Nombre maximal de lignes affichées d'un coup.
 *
 * 446 lignes tiennent techniquement dans la page, mais une liste qu'on ne peut
 * pas parcourir des yeux ne sert à rien : au delà de 200, c'est la recherche
 * qui doit travailler, pas la molette. L'écran annonce ce qu'il ne montre pas.
 */
const MAX_ROWS = 200;

let rows = [];        // tout le carnet, tel que la base le décrit
let owner = false;    // propriétaire : suppression du fonds, et fusion
let busy = false;     // une écriture est en cours, on n'en lance pas deux

/* --------------------------------------------------------------------------
   Lecture

   Après chaque suppression et chaque fusion, on recharge tout plutôt que de
   retoucher le tableau local. La fusion change le nombre d'actions de la
   cible, ses dates extrêmes et le nombre de personnes concernées : trois
   valeurs à recalculer de tête, donc trois occasions de se tromper. Une
   requête de plus sur un geste rare est un très bon échange.
   -------------------------------------------------------------------------- */

async function reload() {
    rows = await accountsOverview();
    paint();
}

/* --------------------------------------------------------------------------
   Ce que contient le carnet
   -------------------------------------------------------------------------- */

function paintStats() {
    const total = rows.length;
    const used = rows.filter(r => r.n_events > 0).length;
    const mine = rows.filter(r => r.created_by).length;
    const del = rows.filter(r => !r.block_reason).length;

    const tuiles = [
        ['Entreprises au carnet', total, 'dont ' + fmtInt(total - mine) + ' venues de Salesforce'],
        ['Portent des actions', used, used ? 'elles ne peuvent pas être supprimées' : 'aucune pour l\'instant'],
        ['Créées depuis l\'outil', mine, 'saisies dans une ligne du cycle de vente'],
        ['Je peux les supprimer', del, owner ? 'propriétaire : le fonds Salesforce compris' : 'hors fonds Salesforce']
    ];

    document.getElementById('acc-stats').innerHTML = tuiles.map(([t, n, sub]) => `
        <div class="acc-stat">
            <div class="acc-stat-num">${fmtInt(n)}</div>
            <div class="acc-stat-lab">${escapeHtml(t)}</div>
            <div class="acc-stat-sub">${escapeHtml(sub)}</div>
        </div>`).join('');
}

/* --------------------------------------------------------------------------
   La liste
   -------------------------------------------------------------------------- */

/** Phrase d'usage : ce que ce nom a servi à déclarer, et par combien de gens. */
function usageText(r) {
    if (!r.n_events) return 'Aucune action rattachée';
    const n = Number(r.n_events);
    const gens = Number(r.n_users);
    const bouts = [`${fmtInt(n)} action${n > 1 ? 's' : ''} du cycle de vente`];
    if (gens > 1) bouts.push(`${gens} personnes`);
    if (r.first_event && r.last_event) {
        bouts.push(r.first_event === r.last_event
            ? `le ${formatDMY(r.last_event)}`
            : `du ${formatDMY(r.first_event)} au ${formatDMY(r.last_event)}`);
    }
    return bouts.join(' · ');
}

/** Phrase d'origine : d'où ce nom vient, et de qui. */
function originText(r) {
    if (!r.created_by) return 'Importée de Salesforce';
    const qui = r.mine ? 'moi' : (r.nom_createur || 'quelqu\'un');
    const quand = r.created_at ? formatDMY(String(r.created_at).slice(0, 10)) : '';
    return `Créée par ${qui}${quand ? ' le ' + quand : ''}`;
}

function rowHtml(r) {
    const bloque = !!r.block_reason;
    return `
    <li class="acc-row${bloque ? ' acc-row--locked' : ''}">
        <div class="acc-main">
            <div class="acc-name">${escapeHtml(r.name)}</div>
            <div class="acc-meta">${escapeHtml(usageText(r))}</div>
            <div class="acc-meta acc-meta--dim">${escapeHtml(originText(r))}</div>
        </div>
        <div class="acc-acts">
            ${owner && r.n_events > 0 ? `
                <button class="acc-btn acc-btn--merge" type="button" data-merge="${r.id}">
                    Fusionner
                </button>` : ''}
            ${bloque ? `
                <button class="acc-btn acc-btn--why" type="button" data-why="${r.id}">
                    Pourquoi ?
                </button>` : `
                <button class="acc-btn acc-btn--del" type="button" data-del="${r.id}">
                    Supprimer
                </button>`}
        </div>
    </li>`;
}

/** Lignes retenues par la recherche, le filtre et le tri en cours. */
function selection() {
    const q = accountKey(document.getElementById('acc-q').value);
    const f = document.getElementById('acc-filter').value;
    const s = document.getElementById('acc-sort').value;

    let out = rows;
    // « contient » et non « commence par » : on cherche ici un nom qu'on ne
    // sait plus écrire, souvent par son milieu.
    if (q) out = out.filter(r => accountKey(r.name).includes(q));
    if (f === 'mine') out = out.filter(r => r.created_by);
    if (f === 'free') out = out.filter(r => !r.n_events);
    if (f === 'used') out = out.filter(r => r.n_events > 0);
    if (f === 'del')  out = out.filter(r => !r.block_reason);

    out = out.slice();
    if (s === 'name')   out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    if (s === 'events') out.sort((a, b) => Number(b.n_events) - Number(a.n_events)
                                       || a.name.localeCompare(b.name, 'fr'));
    if (s === 'recent') out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))
                                       || a.name.localeCompare(b.name, 'fr'));
    return out;
}

function paintList() {
    const liste = selection();
    const montrees = liste.slice(0, MAX_ROWS);
    const cachees = liste.length - montrees.length;

    document.getElementById('acc-list').innerHTML = montrees.length
        ? montrees.map(rowHtml).join('')
        : `<li class="acc-empty">Aucune entreprise ne correspond. Essayez moins de lettres,
             ou repassez le filtre sur « toutes les entreprises ».</li>`;

    const compte = document.getElementById('acc-count');
    compte.textContent = liste.length === rows.length
        ? `${fmtInt(rows.length)} entreprise${rows.length > 1 ? 's' : ''} au carnet.`
        : `${fmtInt(liste.length)} entreprise${liste.length > 1 ? 's' : ''} sur ${fmtInt(rows.length)}.`;

    const more = document.getElementById('acc-more');
    more.hidden = cachees <= 0;
    more.textContent = cachees > 0
        ? `${fmtInt(cachees)} autre${cachees > 1 ? 's' : ''} entreprise${cachees > 1 ? 's' : ''} `
          + `correspond${cachees > 1 ? 'ent' : ''} mais n'${cachees > 1 ? 'apparaissent' : 'apparaît'} `
          + 'pas ici : précisez votre recherche.'
        : '';
}

/** Les noms proposés aux deux champs de la fusion. */
function paintDatalist() {
    if (!owner) return;
    document.getElementById('acc-datalist').innerHTML =
        rows.map(r => `<option value="${escapeHtml(r.name)}"></option>`).join('');
}

function paint() {
    paintStats();
    paintList();
    paintDatalist();
}

/* --------------------------------------------------------------------------
   Suppression

   La confirmation cite le nom et dit ce que la suppression ne fait pas :
   « n'enlève aucun chiffre à personne ». C'est la crainte qui retient la main
   devant un bouton rouge, et elle est infondée ici, puisque le nom ne sert à
   aucune ligne.
   -------------------------------------------------------------------------- */

async function onDelete(id) {
    const r = rows.find(x => x.id === id);
    if (!r || busy) return;

    const ok = confirm(
        `Supprimer « ${r.name} » du carnet ?\n\n`
        + 'Aucune action du cycle de vente n\'y est rattachée : cette suppression '
        + 'n\'enlève aucun chiffre, à personne. Le nom réapparaîtra tout seul '
        + 'si quelqu\'un le retape un jour.');
    if (!ok) return;

    busy = true;
    try {
        const nom = await deleteAccount(id);
        toast(`« ${nom} » a été retirée du carnet.`, 'success');
        await reload();
    } catch (e) {
        // Le refus le plus probable : un collègue a rattaché une action à ce
        // nom entre l'affichage de la liste et le clic. La base le dit, et sa
        // phrase est déjà écrite pour être lue.
        toast(humanError(e), 'error', 9000);
        await reload();
    } finally {
        busy = false;
    }
}

function onWhy(id) {
    const r = rows.find(x => x.id === id);
    if (r) toast(r.block_reason, 'info', 10000);
}

/* --------------------------------------------------------------------------
   Fusion
   -------------------------------------------------------------------------- */

/** Retrouve une entreprise d'après ce qui a été tapé dans un champ. */
function findByName(valeur) {
    const k = accountKey(valeur);
    if (!k) return null;
    return rows.find(r => accountKey(r.name) === k) || null;
}

function pickForMerge(id) {
    const r = rows.find(x => x.id === id);
    if (!r) return;
    const champ = document.getElementById('acc-src');
    champ.value = r.name;
    document.getElementById('acc-merge-block').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('acc-dst').focus();
    refreshMergeNotes();
}

/** Dit sous chaque champ ce que la base sait du nom tapé. */
function refreshMergeNotes() {
    const src = findByName(document.getElementById('acc-src').value);
    const dst = findByName(document.getElementById('acc-dst').value);
    const noteS = document.getElementById('acc-src-note');
    const noteD = document.getElementById('acc-dst-note');

    noteS.textContent = src
        ? `${usageText(src)}. Ces actions passeront chez l'autre entreprise.`
        : 'Ses actions seront réattribuées.';
    noteD.textContent = dst
        ? `${usageText(dst)}. Elle récupérera tout.`
        : 'Elle récupère tout.';
}

async function onMerge() {
    if (busy) return;
    const statut = document.getElementById('acc-merge-status');
    const src = findByName(document.getElementById('acc-src').value);
    const dst = findByName(document.getElementById('acc-dst').value);

    // On refuse ici ce que la base refuserait de toute façon, mais avec une
    // phrase qui dit quoi corriger plutôt qu'un code d'erreur.
    if (!src || !dst) {
        statut.textContent = 'Choisissez deux entreprises existantes, en vous aidant de la liste '
                           + 'proposée par le champ.';
        statut.style.color = 'var(--danger)';
        return;
    }
    if (src.id === dst.id) {
        statut.textContent = 'Ce sont les deux fois la même entreprise.';
        statut.style.color = 'var(--danger)';
        return;
    }

    const n = Number(src.n_events);
    const ok = confirm(
        `Fusionner « ${src.name} » dans « ${dst.name} » ?\n\n`
        + (n
            ? `Les ${n} action${n > 1 ? 's' : ''} déclarée${n > 1 ? 's' : ''} sur `
              + `« ${src.name} » ${n > 1 ? 'seront' : 'sera'} désormais `
              + `attribuée${n > 1 ? 's' : ''} à « ${dst.name} ».\n`
            : `« ${src.name} » ne porte aucune action : elle va simplement disparaître.\n`)
        + `« ${src.name} » sera retirée du carnet.\n\n`
        + 'Aucun score, aucun classement n\'est modifié. L\'opération est définitive.');
    if (!ok) return;

    busy = true;
    statut.textContent = 'Fusion en cours…';
    statut.style.color = '';
    try {
        const deplacees = await mergeAccounts(src.id, dst.id);
        statut.textContent = deplacees
            ? `${deplacees} action${deplacees > 1 ? 's' : ''} déplacée${deplacees > 1 ? 's' : ''} `
              + `vers « ${dst.name} ».`
            : `« ${src.name} » a été retirée du carnet.`;
        statut.style.color = 'var(--success)';
        document.getElementById('acc-src').value = '';
        document.getElementById('acc-dst').value = '';
        refreshMergeNotes();
        toast('Fusion faite.', 'success');
        await reload();
    } catch (e) {
        statut.textContent = humanError(e);
        statut.style.color = 'var(--danger)';
    } finally {
        busy = false;
    }
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

(async function init() {
    // Aucune aptitude exigée : la page se contente de la session. Un BDR n'a
    // rien à y faire, et la navigation ne lui montre pas l'entrée, mais rien
    // ne justifie de le mettre dehors s'il arrive ici par un signet.
    await requireAuth({});
    renderNav();

    owner = canWriteAny(myProfile());
    document.getElementById('acc-merge-block').hidden = !owner;

    document.getElementById('acc-q').addEventListener('input', paintList);
    document.getElementById('acc-filter').addEventListener('change', paintList);
    document.getElementById('acc-sort').addEventListener('change', paintList);

    document.getElementById('acc-list').addEventListener('click', ev => {
        const d = ev.target.closest('[data-del]');
        if (d) { onDelete(d.dataset.del); return; }
        const w = ev.target.closest('[data-why]');
        if (w) { onWhy(w.dataset.why); return; }
        const m = ev.target.closest('[data-merge]');
        if (m) pickForMerge(m.dataset.merge);
    });

    if (owner) {
        document.getElementById('acc-merge-go').addEventListener('click', onMerge);
        document.getElementById('acc-src').addEventListener('input', refreshMergeNotes);
        document.getElementById('acc-dst').addEventListener('input', refreshMergeNotes);
    }

    try {
        await reload();
    } catch (e) {
        document.getElementById('acc-list').innerHTML =
            `<li class="acc-empty">${escapeHtml(humanError(e))}</li>`;
        document.getElementById('acc-count').textContent = '';
    }

    hideVeil();
})();
