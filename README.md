# Santiago Performances — Cockpit BDR

Outil de suivi quotidien de la productivité d'un BDR (Business Development
Representative) : saisie des actions du jour, correction des jours passés,
comparaison libre de deux périodes (d'une journée à plusieurs mois), et
graphiques de tendance agrandissables.

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
│   ├── tooltip.js           moteur d'info-bulles (survol des graphiques)
│   ├── analytics.js         calculs partagés (agrégats, paquets, taux)
│   ├── team.js              vue d'équipe (administrateurs)
│   ├── admin.js             gestion des comptes (administrateurs)
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

## Le dashboard : un seul modèle, la période

Tout le dashboard repose sur une seule abstraction : **une période A (analysée)
face à une période B (référence)**. Une journée n'est qu'une période d'un jour,
donc « aujourd'hui vs hier » et « août vs juillet » empruntent le même chemin de
code. Il n'existe pas de mode « jour » distinct d'un mode « mois ».

Trois zones de pilotage, séparées visuellement :

1. **Période analysée** : deux dates libres, plus des raccourcis (aujourd'hui,
   7 j, 30 j, cette semaine, ce mois, ce trimestre).
2. **Comparée à** : deux dates libres, plus trois raccourcis : période
   précédente équivalente, même période un an avant, et **meilleure période
   équivalente** (recherche de la fenêtre de même durée la plus performante de
   l'historique, ce qui généralise le « record » à n'importe quelle durée).
3. **Lecture des données** : granularité des graphiques (auto, jour, semaine,
   mois) et mode de comparaison (cumul ou moyenne par jour actif).

Trois règles de calcul importantes :

- **Comparaison « à date »** : les présets sur une période en cours tronquent la
  référence à la même durée. Comparer le 1-19 août à un mois de juillet complet
  ferait croire à un effondrement de l'activité ; le préset compare donc le
  1-19 août au 1-19 juillet.
- **Bascule automatique en moyenne** : si les deux périodes n'ont pas la même
  longueur, le mode passe de lui-même en « moyenne par jour actif » et un
  bandeau l'annonce, jusqu'à ce que l'utilisateur choisisse explicitement.
- **Moyennes par jour ACTIF**, jamais par jour calendaire : un week-end ou un
  jour de formation ne doit pas diluer la performance.

Chaque carte porte **ses propres dates**, réglables directement dans la grille
(bouton 📅) comme en vue agrandie (bouton ⛶) : les deux partagent le même état.
Dès qu'une carte quitte la période globale, elle est bordée de violet et sa
référence devient la période précédente équivalente, ce qui est écrit dans sa
légende. Un bouton ramène à la période globale.

## Plusieurs utilisateurs

### Une seule base, jamais une base par personne

L'isolation est assurée par la **Row Level Security** de PostgreSQL : une seule
table, et chaque ligne n'est visible que de son propriétaire. La règle est posée
dans la base, pas dans le navigateur, donc elle tient même si quelqu'un
interroge l'API directement avec la clé publique.

Une base par utilisateur voudrait dire autant de projets Supabase, autant de
jeux de clés, autant de migrations à rejouer à chaque évolution, et surtout
aucune requête possible entre deux personnes, donc aucune vue d'équipe.

### Deux rôles

| | BDR | Administrateur |
|---|---|---|
| Ses propres données | lecture et écriture | lecture et écriture |
| Données des autres | **rien du tout** | lecture, et correction |
| Vue d'équipe | non | oui |
| Gestion des comptes | non | oui |
| Sélecteur d'utilisateur dans la barre de navigation | non | oui |

Le rôle est stocké dans la table `profiles`. Il n'est **pas** dans
`user_metadata` : cette partie du jeton est modifiable par l'utilisateur
lui-même, n'importe qui pourrait se déclarer administrateur.

### Mise en service

1. Exécuter `multi-user-migration.sql` dans le SQL Editor de Supabase. Le script
   est rejouable sans risque et n'efface aucune donnée. Il se termine par la
   promotion de `bbartoli@fluxym.com` en administrateur : adapter l'adresse si
   besoin, c'est la seule ligne à personnaliser.
2. Créer les comptes dans Supabase → Authentication → Users → Add user →
   Create new user, avec **Auto Confirm User** coché. Le profil apparaît
   automatiquement dans la page Comptes.
3. Ajuster les noms affichés, les rôles et les comptes de démonstration depuis
   la page **Comptes** de l'application.

La création d'un compte ne peut pas se faire depuis l'application : elle exige
la clé `service_role`, qui donne tous les droits et contourne toute la sécurité.
Elle n'a rien à faire dans un dépôt public. Tout le reste se gère dans l'écran
Comptes.

### Le compte de démonstration

C'est un compte comme un autre, marqué `is_demo`, alimenté par `seed-demo.sql`.
Ses chiffres sont **exclus par défaut** de la vue d'équipe et de ses classements,
ce qui permet de montrer l'outil avec 90 jours d'historique crédible sans
polluer les statistiques réelles et sans jamais toucher aux données d'un vrai
BDR.

L'adresse peut être un alias : `bbartoli+demo@fluxym.com` arrive dans la boîte
de `bbartoli@fluxym.com` tout en étant un compte distinct pour Supabase. Comme
aucun e-mail n'est envoyé par l'application, l'adresse n'a même pas besoin
d'exister, mais un alias reste préférable si la récupération de mot de passe est
activée un jour.

### Corriger la saisie de quelqu'un

Un administrateur choisit la personne dans le sélecteur de la barre de
navigation, puis saisit normalement. Deux garde-fous :

- un **bandeau permanent** en haut de page, orange sur la page de saisie, rappelle
  dans quel compte on écrit ;
- la journée modifiée porte la mention **corrigé** dans le tableau
  d'historique, parce que la base enregistre l'auteur de chaque écriture dans
  `updated_by`. Une correction ne peut donc pas passer pour une saisie du
  titulaire.

### Ce que la vue d'équipe ajoute

Classement sur la période, indicateurs cumulés, quatre graphiques où **une
couleur désigne une personne** et non une période, un duel de deux BDR face à
face qui reprend le code bleu et violet, et un export CSV. Au-delà de huit
personnes, seules les huit premières sont tracées : le classement reste complet,
mais huit courbes est la limite de lisibilité.

## Le survol des graphiques

Règle appliquée partout : **on ne survole pas une série, on survole un moment.**

Concrètement, une bande invisible couvre toute la hauteur du graphique au-dessus
de chaque position en abscisse. Passer la souris n'importe où dans la colonne
d'un jour, à n'importe quelle hauteur, suffit : pas besoin de viser un point de
trois pixels. Une courbe de tendance ou une ligne de référence répond donc au
même endroit que la courbe principale.

Ce que contient chaque info-bulle, systématiquement :

1. le **moment pointé**, écrit en clair (date longue pour un jour, plage de dates
   pour une semaine ou un mois) ;
2. les valeurs sur la **période analysée**, liseré bleu, badge A ;
3. les **mêmes valeurs sur la période de référence**, liseré violet, badge B ;
4. les **écarts**, en valeur absolue et en pourcentage, ou en points de
   pourcentage quand il s'agit de taux ;
5. une phrase d'interprétation quand elle apporte quelque chose (poste dominant
   du score, avance ou retard sur la référence, volume trop faible pour que le
   taux soit fiable).

Le détail par graphique est rappelé dans la note dépliable de chaque carte,
section « Au survol ».

Deux conséquences utiles :

- sur les paires de panneaux (activité téléphonique, e-mails et CRM), survoler
  une barre du panneau du haut affiche **déjà** les valeurs du panneau du bas.
  Il n'y a plus à descendre la souris pour comparer deux chiffres ;
- sur le score, la bulle donne la **décomposition en points** action par action,
  donc pourquoi la journée vaut ce qu'elle vaut, et pas seulement combien.

Côté technique, `js/tooltip.js` crée **un seul** élément HTML pour toute la page
et le réutilise : le contenu n'est réécrit que lorsque le moment pointé change,
et le déplacement passe par `transform`, qui ne déclenche pas de recalcul de mise
en page. L'affichage est immédiat, sans délai d'apparition. Les `<title>` natifs
du SVG, que le navigateur affichait après environ une seconde dans son propre
style et sur une seule ligne, ont tous été supprimés.

## Code couleur, valable dans toute l'application

Deux familles, jamais du gris pour porter du sens :

- **Période analysée : camaïeu de bleu Fluxym** (`#00A7E1`, `#0369a1`, `#0B2046`)
- **Période de référence : camaïeu de violet** (`#8b5cf6`, `#6d28d9`, `#4c1d95`)

L'intensité distingue les métriques à l'intérieur d'une même famille. Les
graphiques qui comparent plusieurs séries sur deux périodes utilisent des
**panneaux superposés à échelle verticale partagée** plutôt qu'une grille unique
surchargée : une barre deux fois plus haute vaut réellement deux fois plus.

Chaque carte porte une légende structurée (pastille + libellé portant les vraies
dates) et une note dépliable « Comment lire ce graphique » qui explique la
méthode de calcul. Aucune information n'est laissée à une phrase en gris.

## Le score de productivité

La formule est affichée en clair sur la page Performances, dans un encadré bleu
foncé placé juste sous les indicateurs, avec la **décomposition chiffrée de la
période analysée** (« 312 appels × 1 + 98 aboutis × 3 + … = 1 234 points »).
Elle est également rappelée sur la page de saisie, sous le score du jour.

Poids actuels : appel ×1, appel abouti ×3, **rendez-vous ×20**, e-mail ×1,
entreprise ×2, contact ×2.

Ils sont définis à **deux endroits qui doivent rester synchronisés** : la vue SQL
`v_daily_kpi` (source de vérité côté base) et la constante `SCORE_WEIGHTS` de
`js/api.js` (source unique côté application, utilisée par la saisie, le
dashboard et les explications affichées).

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
