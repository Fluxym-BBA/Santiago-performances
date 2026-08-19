/* ==========================================================================
   CONFIG.JS — Les 2 seules valeurs à renseigner pour connecter l'application.
   À récupérer dans Supabase : Project Settings > API (ou Data API).
   La clé "anon public" est faite pour être publiée dans du code front :
   la protection des données repose sur la RLS, pas sur le secret de cette clé.
   NE JAMAIS mettre ici la clé "service_role".
   ========================================================================== */

window.APP_CONFIG = {
    SUPABASE_URL: 'https://VOTRE-REF-PROJET.supabase.co',
    SUPABASE_ANON_KEY: 'COLLER_ICI_LA_CLE_ANON_PUBLIC',

    // Titre affiché dans la barre de navigation
    APP_NAME: 'Cockpit BDR',
    APP_OWNER: 'Santiago'
};
