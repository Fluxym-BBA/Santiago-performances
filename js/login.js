/* ==========================================================================
   LOGIN.JS — Connexion e-mail / mot de passe.
   Pas d'inscription, pas d'e-mail envoyé : les comptes sont créés à la main
   dans Supabase (Authentication → Users → Add user → Auto Confirm User).
   ========================================================================== */

import { signIn, getSession, CONFIG_OK, humanError } from './api.js';
import { $, hideVeil } from './ui.js';

const form = $('#login-form');
const errorBox = $('#login-error');
const submit = $('#login-submit');

function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add('login-error--visible');
}

function nextPage() {
    const next = new URLSearchParams(location.search).get('next');
    // On n'accepte qu'une cible locale, jamais une URL absolue.
    if (next && /^[a-z0-9._-]+\.html(\?[^#]*)?$/i.test(next)) return `./${next}`;
    return './index.html';
}

(async function init() {
    hideVeil();

    if (!CONFIG_OK) {
        showError("js/config.js n'est pas renseigné : collez l'URL du projet Supabase et la clé anon public.");
        submit.disabled = true;
        return;
    }

    // Déjà connecté : on court-circuite l'écran de login.
    if (await getSession()) { location.replace(nextPage()); return; }

    form.addEventListener('submit', async e => {
        e.preventDefault();
        errorBox.classList.remove('login-error--visible');
        submit.disabled = true;
        submit.textContent = 'Connexion…';

        const { error } = await signIn($('#email').value, $('#password').value);

        if (error) {
            showError(humanError(error));
            submit.disabled = false;
            submit.textContent = 'Se connecter';
            $('#password').select();
            return;
        }
        location.replace(nextPage());
    });
})();
