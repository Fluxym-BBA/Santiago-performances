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
├── admin.html               gestion des comptes (administrateurs)
├── team.html                vue d'équipe (administrateurs)
├── bdr-cockpit-schema.sql       schéma initial de la base
├── multi-user-migration.sql     migration 1 : plusieurs utilisateurs, RLS
├── roles-migration-v2.sql       migration 2 : rôles à deux axes
├── accounts-migration-v3.sql    migration 3 : suppression de compte sans dégât
├── seed-demo.sql                90 jours de données de démonstration
├── reset-demo.sql               remise à zéro du compte de démonstration
├── supabase/
│   └── functions/
│       └── admin-users/
│           └── index.ts     Edge Function : créer, réinitialiser, supprimer
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

### Deux axes, pas un rôle unique

Administrer et prospecter sont deux questions distinctes, donc deux colonnes
indépendantes dans `profiles` :

- **`is_admin`** : administre les comptes et consulte tout le monde
- **`is_bdr`** : saisit son activité et apparaît dans les classements

| | `is_bdr` vrai | `is_bdr` faux |
|---|---|---|
| **`is_admin` vrai** | Manager qui prospecte aussi : accès à tout | Administrateur pur : ni saisie, ni score, ni classement |
| **`is_admin` faux** | BDR : sa saisie et ses performances | Observateur : consulte l'équipe, n'administre rien |

Un administrateur pur n'a donc ni « Ma journée » ni « Mes performances » dans sa
navigation, sa page d'accueil est la vue d'équipe, et il est absent de tous les
classements. Avant, il y figurait avec un score de zéro, ce qui n'avait aucun
sens.

Ces deux colonnes ne sont **pas** dans `user_metadata` : cette partie du jeton
est modifiable par l'utilisateur lui-même, n'importe qui pourrait se déclarer
administrateur.

### Mise en service

1. Exécuter dans le SQL Editor de Supabase, dans cet ordre :
   `multi-user-migration.sql`, `roles-migration-v2.sql`,
   `accounts-migration-v3.sql`. Les trois sont rejouables sans risque et
   n'effacent aucune donnée. La seule ligne à personnaliser est la promotion de
   `bbartoli@fluxym.com` en administrateur, à la fin de la migration 2.
2. Créer les comptes dans Supabase → Authentication → Users → Add user →
   Create new user, avec **Auto Confirm User** coché. Le profil apparaît
   automatiquement dans la page Comptes.
3. Ajuster les noms affichés, les rôles et les comptes de démonstration depuis
   la page **Comptes** de l'application.

Depuis le lot 2, l'étape 2 se fait directement dans l'écran **Comptes** de
l'application, à condition d'avoir déployé l'Edge Function (voir ci-dessous).
La création manuelle dans Supabase reste possible et donne exactement le même
résultat : le profil naît dans les deux cas par le déclencheur
`handle_new_user`.

### Créer un compte depuis l'application : l'Edge Function `admin-users`

Créer un compte, changer un mot de passe ou supprimer un compte exige la clé
`service_role`. Cette clé donne **tous** les droits sur la base et contourne
toute la Row Level Security : elle ne doit jamais se trouver dans un dépôt
public, donc jamais dans ce code. Elle ne peut pas non plus être demandée à
l'utilisateur, puisqu'un administrateur du cockpit n'est pas administrateur de
Supabase.

La réponse est une fonction hébergée chez Supabase : le navigateur envoie une
intention et son propre jeton, la fonction vérifie que l'appelant est bien
administrateur, et **elle seule** utilise la clé. La clé ne quitte jamais
Supabase.

Déploiement, sans installer quoi que ce soit :

1. Supabase → **Edge Functions** → **Deploy a new function**
2. Nommer la fonction exactement `admin-users`
3. Coller le contenu de `supabase/functions/admin-users/index.ts`
4. **Deploy**

Aucun secret à renseigner : `SUPABASE_URL`, `SUPABASE_ANON_KEY` et
`SUPABASE_SERVICE_ROLE_KEY` sont injectés automatiquement dans toute Edge
Function. L'option *Verify JWT* peut rester activée, la fonction refait de
toute façon la vérification elle-même.

Secret facultatif, contre la faute de frappe : `ALLOWED_EMAIL_DOMAINS`, par
exemple `fluxym.com`. Renseigné, il interdit la création d'un compte sur un
autre domaine. Absent, aucune restriction.

Exécuter aussi `accounts-migration-v3.sql`, qui rend la **suppression** de
compte possible sans casse (voir plus bas).

#### L'ordre de vérification est tout l'enjeu du fichier

```
1. lire le jeton de l'appelant           → absent : 401
2. le faire valider par Supabase         → invalide : 401
3. lire son profil AVEC SES PROPRES DROITS
   et vérifier is_admin et is_active     → non admin : 403
4. seulement alors, instancier le client service_role
```

Le client privilégié est créé après la vérification, jamais avant. Il n'est
lu qu'à un seul endroit du fichier, la fonction `elevated()`, et l'étape 3 est
délibérément faite avec les droits de l'appelant plutôt qu'avec la clé : même
une règle RLS mal écrite ne pourrait pas ici élargir ce qu'il a le droit de
voir. Une inversion de deux lignes suffirait à transformer cette fonction en
porte ouverte sur la base : c'est la seule partie du projet où il n'y a aucune
marge d'erreur, et c'est pour cela qu'elle est vérifiée par le test `t7`.

#### Si la fonction n'est pas déployée

L'écran Comptes l'interroge au chargement. Sans réponse, il n'affiche pas un
formulaire inopérant : il affiche la marche à suivre manuelle dans Supabase, et
masque les boutons « Mot de passe » et « Supprimer » qui en dépendent. Un
bouton qui ne marche pas est pire qu'une explication.

### Le mot de passe provisoire

Il est tiré au sort **par le serveur**, jamais par le navigateur : un seul
générateur dans tout le projet, donc une seule qualité d'aléa à garantir. La
forme est `xxxx-xxxx-xxxx` sur un alphabet de 30 signes d'où sont retirés les
caractères que l'on confond (`0`/`O`, `1`/`l`/`I`), soit environ 59 bits
d'entropie et un mot de passe dictable au téléphone.

Il n'est **affiché qu'une fois**, juste après la création, et n'est stocké
nulle part en clair, ni dans l'application ni dans la base. Perdu, il faut en
générer un autre. Le bouton « Copier le message » prépare le texte complet à
envoyer, adresse de connexion incluse, parce que c'est le geste réel qui suit :
sans lui, l'administrateur recopie à la main et se trompe.

### Supprimer un compte, et pourquoi il faut rarement le faire

Deux pièges, tous deux invisibles jusqu'au jour où l'on supprime vraiment
quelqu'un, corrigés par `accounts-migration-v3.sql` :

- `daily_activity.created_by` et `updated_by` pointaient vers `auth.users`
  **sans** règle de cascade. Dès qu'un administrateur a corrigé la saisie de
  quelqu'un, son identifiant y est inscrit, et le supprimer échouait sur une
  violation de clé étrangère au message incompréhensible. Ces colonnes disent
  *qui* a saisi : `on delete set null` est le bon comportement, et surtout pas
  la cascade, qui détruirait la saisie d'un BDR parce qu'un administrateur
  parti a corrigé une virgule.
- Rien n'empêchait de supprimer le dernier administrateur. Un déclencheur
  `before delete` sur `profiles` le refuse désormais. Il est posé sur
  `profiles` et non sur `auth.users` pour attraper aussi une suppression
  lancée depuis le tableau de bord Supabase, qui ne passe pas par la fonction.

Côté écran, la suppression demande de **saisir l'adresse du compte**, affiche
le nombre de journées qui seront détruites (compté par la base, pas par le
navigateur) et propose « Désactivé » à la place. Pour un départ, la
désactivation est presque toujours la bonne réponse : l'accès est coupé et les
chiffres passés restent comparables. La suppression n'a de sens que pour un
compte créé par erreur.

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

### Consulter et corriger quelqu'un : le contexte est dans l'URL

Il n'y a **pas** de sélecteur d'utilisateur permanent. Le chemin est :

**Équipe → clic sur une personne → `dashboard.html?u=<identifiant>`**

On obtient sa fiche complète, mêmes périodes et mêmes graphiques, **en lecture
seule**. Pour corriger une journée, il faut cliquer « corriger » dans son
historique, ce qui ouvre `index.html?u=<identifiant>&date=<jour>` et demande une
confirmation nommée avant la première écriture.

Faire porter le contexte par l'URL plutôt que par la session est un choix de
sécurité autant que d'ergonomie : la page est rechargeable et partageable, on ne
peut pas « rester » par inadvertance dans le compte d'un tiers, et un simple
retour en arrière suffit à sortir. Un non-administrateur qui bricole le
paramètre est renvoyé chez lui, et la base refuserait de toute façon de livrer
les données.

Trois garde-fous en plus :

- l'en-tête de la page **prend le nom de la personne consultée**, et le titre de
  l'onglet aussi ;
- un bandeau permanent, **orange** en mode correction, rappelle dans quel compte
  on écrit ;
- la journée modifiée porte la mention **corrigé** dans l'historique, parce que
  la base enregistre l'auteur de chaque écriture dans `updated_by`. Une
  correction ne peut pas passer pour une saisie du titulaire.

### Ce que la vue d'équipe ajoute

Classement sur la période, indicateurs cumulés, quatre graphiques où **une
couleur désigne une personne** et non une période, un duel de deux BDR face à
face qui reprend le code bleu et violet, et un export CSV. Au-delà de huit
personnes, seules les huit premières sont tracées : le classement reste complet,
mais huit courbes est la limite de lisibilité.

## L'interface sur téléphone et sur ordinateur

### La barre de navigation

Trois paliers, un seul jeu d'éléments, et une règle tenue partout : **aucun
texte n'est jamais tronqué**. Les libellés raccourcissent par palier, ce qui ne
tient pas descend dans le menu du compte, et rien ne finit par des points de
suspension.

| Largeur | Disposition |
|---|---|
| À partir de 1024 px | Logo, onglets avec libellé complet, menu du compte à droite |
| 640 à 1023 px, dont le **téléphone en paysage** | Une seule barre, libellés courts, pas de barre en bas |
| Sous 640 px | Logo et avatar en haut, barre d'onglets fixée en bas, au pouce |

Le palier du milieu existe pour le mode paysage : il n'y reste qu'environ 350
pixels de hauteur utile, une barre en haut **et** une barre en bas en
mangeraient un tiers.

La navigation n'affiche que ce qui sert au profil connecté, soit deux ou trois
onglets au maximum. C'est ce qui règle le problème de place à la source, plutôt
que de comprimer sept éléments sur une ligne.

Le **menu du compte**, à droite, porte le nom complet, le rôle écrit en clair,
les sections secondaires et la déconnexion. Le nom affiché dans la barre est
volontairement raccourci en « Prénom N. », qui tient toujours, au lieu d'être
coupé par le navigateur.

### Le reste de l'interface

Refaire la barre ne suffit pas, ce sont les tableaux et les boutons qui décident
si l'outil est utilisable au téléphone :

- **Les tableaux deviennent des cartes** sous 760 px. Onze à treize colonnes ne
  se lisent pas sur un téléphone, et le défilement horizontal n'est pas une
  réponse : on ne compare rien quand il faut faire glisser. Chaque ligne devient
  une carte, et l'intitulé de colonne redevient une étiquette en regard de sa
  valeur.
- **Les graphiques se dimensionnent sur la place disponible.** Le repère était
  figé à 760 unités de large : sur un téléphone de 375 pixels, tout était mis à
  l'échelle 0,49 et un texte de 11 pixels s'affichait à 5. Désormais une unité
  vaut un pixel, les tailles de texte sont respectées, le nombre d'étiquettes en
  abscisse s'ajuste, et la hauteur est bornée par celle de la fenêtre.
- **Les boutons de saisie passent à 48 pixels**, la taille recommandée pour être
  touchés sans viser. C'est l'écran le plus utilisé du projet, et probablement au
  téléphone en fin de journée.
- **Les info-bulles s'ancrent en bas de l'écran** au doigt, au lieu de suivre le
  toucher : une bulle qui suit le doigt est cachée par le doigt.
- Une rotation d'écran ou un redimensionnement **redessine les graphiques**, sans
  relancer aucune requête.

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
