/* ==========================================================================
   LOGIN.JS — Connexion e-mail / mot de passe.
   Pas d'inscription, pas d'e-mail envoyé : les comptes sont créés à la main
   dans Supabase (Authentication → Users → Add user → Auto Confirm User).
   ========================================================================== */

import {
    signIn, getSession, CONFIG_OK, humanError, loadProfile,
    myProfile, homePageFor
} from './api.js';
import { $, hideVeil } from './ui.js';

const form = $('#login-form');
const errorBox = $('#login-error');
const submit = $('#login-submit');

function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add('login-error--visible');
}

/**
 * Où envoyer la personne après sa connexion.
 *
 * La page demandée l'emporte, si elle est locale. Sinon, la destination dépend
 * du profil : un administrateur qui ne prospecte pas n'a rien à faire sur la
 * page de saisie, son point d'entrée est la vue d'équipe. Avant, tout le monde
 * atterrissait sur « Ma journée », y compris ceux pour qui elle n'a aucun sens.
 */
async function nextPage(session) {
    const next = new URLSearchParams(location.search).get('next');
    // On n'accepte qu'une cible locale, jamais une URL absolue.
    if (next && /^[a-z0-9._-]+\.html(\?[^#]*)?$/i.test(next)) return `./${next}`;

    try {
        await loadProfile(session);
        return homePageFor(myProfile());
    } catch {
        return './index.html';
    }
}

(async function init() {
    hideVeil();

    if (!CONFIG_OK) {
        showError("js/config.js n'est pas renseigné : collez l'URL du projet Supabase et la clé anon public.");
        submit.disabled = true;
        return;
    }

    // Déjà connecté : on court-circuite l'écran de login.
    const existing = await getSession();
    if (existing) { location.replace(await nextPage(existing)); return; }

    form.addEventListener('submit', async e => {
        e.preventDefault();
        errorBox.classList.remove('login-error--visible');
        submit.disabled = true;
        submit.textContent = 'Connexion…';

        const { data, error } = await signIn($('#email').value, $('#password').value);

        if (error) {
            showError(humanError(error));
            submit.disabled = false;
            submit.textContent = 'Se connecter';
            $('#password').select();
            return;
        }
        location.replace(await nextPage(data?.session || await getSession()));
    });
})();
