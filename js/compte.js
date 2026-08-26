/* ==========================================================================
   COMPTE.JS — Mon compte : ce que je suis, et mon mot de passe.

   Quatre partis pris, dans l'ordre de leur importance :

   1. CETTE PAGE NE PARLE QUE DE MOI. Le paramètre `?u=` est retiré avant le
      moindre chargement. Changer le mot de passe de quelqu'un d'autre reste le
      rôle de l'écran des comptes, qui passe par la fonction serveur et affiche
      le nouveau mot de passe une seule fois. Deux chemins pour le même geste
      finiraient par ne plus dire la même chose.

   2. L'ANCIEN MOT DE PASSE EST EXIGÉ, ET VÉRIFIÉ ICI AUSSI. Supabase sait le
      contrôler côté serveur, mais seulement si l'option « Require current
      password when changing password » est cochée dans le tableau de bord. On
      ne fait pas dépendre la justesse d'un message d'un réglage distant : la
      vérification est faite par une tentative de connexion, et l'ancien mot de
      passe est tout de même transmis pour que le contrôle serveur s'applique
      lorsqu'il est actif.

   3. AUCUN DROIT PARTICULIER, AUCUNE DÉPENDANCE. Rien ici ne passe par la
      fonction admin-users ni par une clé privilégiée : c'est l'API
      d'authentification de l'utilisateur connecté, avec sa propre session. La
      page fonctionne donc même si la fonction serveur n'est pas déployée, et
      elle n'a besoin d'aucune migration.

   4. AUCUN COURRIEL. L'application n'en envoie pas, et cette page n'en envoie
      pas davantage. Un mot de passe oublié se règle avec l'administrateur.
   ========================================================================== */

import {
    requireAuth, myProfile, roleLabel, levelLabel, humanError, signIn, supabase,
    jobLabel, isContributor
} from './api.js';
import { renderNav } from './nav.js';
import { escapeHtml, toast, hideVeil } from './ui.js';

/**
 * Longueur minimale exigée par l'écran.
 *
 * Recopiée de ce que refuse déjà la création de compte côté serveur. Si le
 * tableau de bord Supabase est durci au-delà, c'est le serveur qui refusera et
 * son message est alors affiché tel quel : mieux vaut une exigence répétée
 * qu'un formulaire qui promet ce que la base refusera.
 */
const MIN_LENGTH = 8;

let session = null;

/* --------------------------------------------------------------------------
   Qui je suis

   En lecture seule. Ces lignes ne sont pas un formulaire déguisé : le niveau
   d'accès et le métier décident de ce que la base laisse voir, et ils
   n'appartiennent qu'à l'administrateur.
   -------------------------------------------------------------------------- */

function renderMe() {
    const me = myProfile() || {};
    const email = me.email || session?.user?.email || '';

    const rows = [
        ['Nom affiché', me.display_name || 'Sans nom'],
        ['Adresse de connexion', email],
        ['Ce que je suis ici', roleLabel(me)],
        ['Niveau d\'accès', levelLabel(me)],
        // Le métier, et non la seule prospection : sans cela un commercial
        // lirait « je ne saisis aucune activité » sur sa propre fiche, alors
        // qu'il saisit tous les jours.
        ['Métier', isContributor(me)
            ? `${jobLabel(me)} : je saisis mon activité et j'apparais dans les classements`
            : 'Aucun : je ne saisis aucune activité']
    ];
    if (me.is_demo) {
        rows.push(['Compte de démonstration',
            'Oui : mes chiffres sont exclus des classements de l\'équipe']);
    }

    document.getElementById('me-list').innerHTML = rows
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
        .join('');
}

/* --------------------------------------------------------------------------
   Messages du formulaire
   -------------------------------------------------------------------------- */

/**
 * Écrit sous le bouton. `.form-status` est rouge par défaut, ce qui est le bon
 * réglage dans la quasi-totalité des cas : le vert reste une exception locale
 * plutôt qu'une règle de plus dans la feuille de style commune.
 */
function say(msg, kind = 'error') {
    const el = document.getElementById('pw-status');
    el.textContent = msg;
    el.style.color = kind === 'ok' ? 'var(--success)' : 'var(--danger)';
}

/**
 * Traduit les refus propres au mot de passe, puis se replie sur le traducteur
 * commun. Les messages de Supabase sont en anglais et parlent de l'API : ils ne
 * disent pas à l'utilisateur ce qu'il doit faire.
 */
function passwordError(error) {
    const msg = (error && error.message) || String(error || '');
    const low = msg.toLowerCase();

    if (low.includes('current password') || low.includes('current_password')) {
        return 'Mot de passe actuel incorrect.';
    }
    if (low.includes('should be different') || error?.code === 'same_password') {
        return 'Le nouveau mot de passe doit être différent de l\'ancien.';
    }
    if (low.includes('at least') && low.includes('character')) {
        // Le serveur donne l'exigence réelle, qui peut dépasser la nôtre si le
        // tableau de bord a été durci : on garde son texte plutôt que d'annoncer
        // une règle périmée.
        return `Mot de passe refusé par Supabase : ${msg}`;
    }
    if (low.includes('weak') || low.includes('leaked') || low.includes('pwned')) {
        return 'Ce mot de passe figure dans des listes de mots de passe volés. Choisissez-en un autre.';
    }
    if (error?.status === 429 || low.includes('for security purposes') || low.includes('rate limit')) {
        return 'Trop de tentatives rapprochées. Attendez une minute, puis réessayez.';
    }
    return humanError(error);
}

/* --------------------------------------------------------------------------
   Changement de mot de passe
   -------------------------------------------------------------------------- */

async function changePassword(e) {
    e.preventDefault();

    const form = document.getElementById('pw-form');
    const btn = document.getElementById('pw-submit');
    const fCurrent = document.getElementById('pw-current');
    const fNew = document.getElementById('pw-new');
    const fConfirm = document.getElementById('pw-confirm');

    const current = fCurrent.value;
    const next = fNew.value;
    const again = fConfirm.value;
    const email = myProfile()?.email || session?.user?.email || '';

    // Contrôles locaux d'abord : inutile de solliciter le réseau pour une faute
    // de frappe, et le message est plus précis que celui du serveur.
    if (next.length < MIN_LENGTH) {
        say(`Le nouveau mot de passe fait ${next.length} caractère${next.length > 1 ? 's' : ''} : il en faut ${MIN_LENGTH} au minimum.`);
        fNew.focus();
        return;
    }
    if (next !== again) {
        say('Le nouveau mot de passe et sa confirmation ne sont pas identiques.');
        fConfirm.select();
        return;
    }
    if (next === current) {
        say('Le nouveau mot de passe est identique à l\'ancien : rien à changer.');
        fNew.select();
        return;
    }
    if (!email) {
        say('Adresse de connexion introuvable. Rechargez la page et reconnectez-vous.');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Changement…';
    say('');

    try {
        // Étape 1 : l'ancien mot de passe est-il le bon ? Une tentative de
        // connexion est la seule façon de le savoir depuis le navigateur. Elle
        // renouvelle la session en place, ce qui est sans effet visible : c'est
        // le même utilisateur, avec un jeton neuf.
        const { error: authError } = await signIn(email, current);
        if (authError) {
            // Distinction volontaire : un refus d'identifiants désigne l'ancien
            // mot de passe, une panne de réseau ne doit surtout pas être
            // annoncée comme telle sous peine d'envoyer l'utilisateur chercher
            // un mot de passe qui était bon.
            const invalid = (authError.message || '').includes('Invalid login credentials');
            say(invalid ? 'Mot de passe actuel incorrect.' : passwordError(authError));
            if (invalid) fCurrent.select();
            return;
        }

        // Étape 2 : le changement. `current_password` est transmis en plus de
        // notre propre contrôle, sans quoi l'appel serait refusé sur un projet
        // où l'option correspondante est active.
        const { error } = await supabase.auth.updateUser({
            password: next,
            current_password: current
        });
        if (error) { say(passwordError(error)); return; }

        form.reset();
        document.getElementById('pw-show').checked = false;
        applyVisibility(false);
        updateHint();
        say('Mot de passe changé. C\'est celui-là qu\'il faudra saisir à la prochaine connexion.', 'ok');
        toast('Mot de passe changé', 'success');
    } catch (err) {
        say(passwordError(err));
    } finally {
        btn.disabled = false;
        btn.textContent = 'Changer mon mot de passe';
    }
}

/* --------------------------------------------------------------------------
   Confort de saisie

   Un mot de passe tapé à l'aveugle sur un téléphone est une faute de frappe qui
   attend son heure : l'affichage en clair est proposé, jamais imposé.
   -------------------------------------------------------------------------- */

function applyVisibility(visible) {
    ['pw-current', 'pw-new', 'pw-confirm'].forEach(id => {
        document.getElementById(id).type = visible ? 'text' : 'password';
    });
}

function updateHint() {
    const n = document.getElementById('pw-new').value.length;
    const el = document.getElementById('pw-hint');
    const missing = MIN_LENGTH - n;
    el.textContent = n === 0
        ? `${MIN_LENGTH} caractères au minimum.`
        : missing > 0
            ? `Encore ${missing} caractère${missing > 1 ? 's' : ''}.`
            : 'Longueur suffisante.';
    el.style.color = n === 0 || missing > 0 ? '' : 'var(--success)';
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */

(async function init() {
    // Un `?u=` traîné depuis la vue d'équipe n'a aucun sens ici, et laisserait
    // croire qu'on agit sur le compte d'un autre. On le retire avant de charger
    // le moindre profil.
    if (new URLSearchParams(location.search).has('u')) {
        location.replace('./compte.html');
        return;
    }

    // Aucune aptitude exigée : tout compte actif a un mot de passe à changer,
    // y compris un observateur qui ne prospecte pas.
    session = await requireAuth({});
    renderNav();
    renderMe();

    document.getElementById('pw-form').addEventListener('submit', changePassword);
    document.getElementById('pw-new').addEventListener('input', updateHint);
    document.getElementById('pw-show').addEventListener('change', e => applyVisibility(e.target.checked));

    hideVeil();
})();
