# Santiago Performances — Cockpit BDR

Outil de suivi quotidien de la productivité d'un BDR (Business Development
Representative) : saisie des actions du jour, correction des jours passés,
comparaison de n'importe quelle journée à la veille, au record ou à la moyenne,
et graphiques de tendance.

## Nature technique

Site **100 % statique** : HTML, CSS et JavaScript vanilla, servi par GitHub
Pages. Aucun build, aucun bundler, aucun framework, aucune dépendance npm.
Les fichiers du dépôt sont exactement ceux servis au navigateur.

Seule exception à la règle « zéro dépendance » : la librairie officielle
`supabase-js`, chargée depuis un CDN en module ES. Les graphiques sont du SVG
généré à la main dans `js/ui.js`, il n'y a pas de librairie de charts.

Base de données : **Supabase** (PostgreSQL managé, région Europe).

## Arborescence

```
Santiago-performances/
├── index.html               saisie du jour (page d'entrée)
├── dashboard.html           analyse de performance
├── login.html               connexion e-mail / mot de passe
├── robots.txt               interdiction d'indexation
├── bdr-cockpit-schema.sql   schéma de la base (à exécuter dans Supabase)
├── css/
│   └── app.css              feuille unique, variables CSS dans :root
├── js/
│   ├── config.js            ⚠️ LES 2 VALEURS À RENSEIGNER
│   ├── api.js               client Supabase, auth, requêtes, dates, métriques
│   ├── ui.js                helpers d'affichage, toasts, graphiques SVG
│   ├── nav.js               barre de navigation injectée
│   ├── login.js             écran de connexion
│   ├── saisie.js            logique de la page de saisie
│   └── dashboard.js         logique du dashboard
└── assets/
    ├── favicon-Fluxym-V2.png
    ├── fluxym_logo_2018_sansdescriptif_blanc.png
    └── fluxym_logo_2018_sansdescriptif_noir.png
```

## Mise en service, dans cet ordre

1. **Base de données.** Dans Supabase → `SQL Editor`, exécuter
   `bdr-cockpit-schema.sql`. Il crée `daily_activity`, `daily_targets`, les vues
   `v_daily_kpi` et `v_best_day`, la fonction `bump_metric()`, les triggers
   `updated_at` et toutes les politiques RLS.

2. **Authentification (aucun e-mail requis).** Dans Supabase →
   `Authentication` :
   - `Sign In / Providers` → `Email` : **décocher « Confirm email »**, et
     désactiver `Allow new users to sign up`.
   - `Users` → `Add user` → `Create new user`, avec **Auto Confirm User**
     coché. Créer un compte pour Santiago et un pour l'administrateur.
   Aucun e-mail n'est jamais envoyé : ni confirmation, ni magic link. En cas de
   mot de passe perdu, l'administrateur le réinitialise depuis ce même écran.

3. **Configuration du front.** Ouvrir `js/config.js` et coller les deux valeurs
   trouvées dans Supabase → `Project Settings` → `API` :
   - `SUPABASE_URL` : l'URL du projet (`https://xxxx.supabase.co`)
   - `SUPABASE_ANON_KEY` : la clé **anon public**
   Ne jamais mettre la clé `service_role` dans ce fichier : elle contourne la
   RLS et donnerait un accès total à la base.

4. **Assets.** Copier dans `assets/` le favicon et les deux logos Fluxym
   (repris du dépôt `rfe.fluxym.com`). Sans eux, l'application fonctionne : les
   images se masquent d'elles-mêmes et seul le texte du logo reste affiché.

5. **Publication.** `Settings` → `Pages` → `Deploy from a branch` → `main` /
   `(root)`. L'URL sera `https://fluxym-bba.github.io/Santiago-performances/`.

## Sur la clé anon dans un dépôt public

C'est le fonctionnement normal de Supabase : la clé `anon` est une clé
publiable, prévue pour vivre dans du code front. Elle ne donne aucun droit par
elle-même. La seule barrière de sécurité est la **Row Level Security** : chaque
politique filtre sur `user_id = auth.uid()`, et le rôle `anon` (non connecté)
n'a aucun droit sur les tables. Sans session valide, l'API ne renvoie rien.

Conséquence directe : **ne jamais désactiver la RLS**, même « juste pour
tester ».

## Modèle de données

`daily_activity` contient **une seule ligne par utilisateur et par jour**,
garantie par la contrainte d'unicité `(user_id, activity_date)`. C'est ce qui
permet l'upsert sans doublon, la correction d'un jour passé et des requêtes de
période triviales.

| Carte de l'interface | Colonnes |
|---|---|
| Enrichissement du CRM | `companies_created`, `contacts_created` |
| Prospection → Appels | `calls_made`, `calls_connected`, `meetings_booked` |
| Prospection → E-mails | `emails_sent` |
| Note libre | `notes` |

Les taux (`connect_rate`, `meeting_rate`, `calls_per_meeting`) et le
`productivity_score` ne sont **pas stockés** : ils sont calculés par la vue
`v_daily_kpi`. Modifier une pondération se fait donc en une requête SQL, sans
migration de données.

Pondération actuelle du score, à ajuster avec l'intéressé :
`appel ×1`, `appel abouti ×3`, `RDV ×20`, `e-mail ×1`, `entreprise ×2`,
`contact ×2`. Elle est définie deux fois, volontairement : dans la vue SQL
(source de vérité) et dans `js/saisie.js` (constante `WEIGHTS`, pour
l'affichage instantané pendant la saisie). **Les deux doivent rester
synchronisées.**

## Comportements à connaître

- **Aucun bouton « valider ».** Les boutons `+`/`−` appellent la fonction SQL
  `bump_metric()`, qui incrémente de façon atomique et crée la ligne du jour si
  besoin : deux onglets ouverts ne peuvent pas s'écraser mutuellement. La
  frappe directe dans un champ déclenche un upsert après 600 ms d'inactivité.
- **Dates en heure locale**, jamais en UTC (`toISO()` dans `api.js`), pour
  éviter qu'une saisie en soirée ne soit attribuée à la veille.
- **Pas de saisie dans le futur** : les sélecteurs de date sont bornés à
  aujourd'hui.
- **Contrainte de cohérence** : la base refuse `calls_connected > calls_made`.
  L'interface affiche alors un message explicite et resynchronise la valeur.
- Un lien `?date=AAAA-MM-JJ` sur `index.html` ouvre directement la saisie d'un
  jour donné. C'est ce que fait le lien « modifier » du tableau d'historique.
