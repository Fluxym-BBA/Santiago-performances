# État du Cockpit BDR

Ce fichier dit ce qui est réellement déployé, et rien d'autre. Il est la source
de vérité au début de chaque tâche : ce qui n'y est pas écrit n'existe pas.

Dernière mise à jour : 20/08/2026, 17h00.

## 1. Ce qui est en ligne

| Élément | État | Vérifié |
| --- | --- | --- |
| Site GitHub Pages | en ligne, sert `main` | 20/08, `js/api.js` en ligne identique au dépôt |
| `sql/bdr-cockpit-schema.sql` | exécuté | 20/08, en base |
| `sql/multi-user-migration.sql` (migration 1) | exécutée | 20/08, `profiles`, RLS, `v_team_daily` présents |
| `sql/roles-migration-v2.sql` (migration 2) | exécutée | 20/08, appliquée par l'agent |
| `sql/accounts-migration-v3.sql` (migration 3) | exécutée | 20/08, clés étrangères en `SET NULL`, déclencheur posé |
| `sql/levels-migration-v4.sql` (migration 4) | exécutée | 20/08, quatre niveaux testés par usurpation d'identité |
| Edge Function `admin-users` | déployée, version 1, active | 20/08, création de compte utilisée pour de vrai |
| Code v6 lot 1 (rôles, nav, responsive) | en ligne | 20/08, commit `ad6ea69` |
| Code v6 lot 2 (écran Comptes) | en ligne | 20/08, `admin.html` répond, comptes créés depuis l'interface |
| Correctifs d'affichage (badge, page Comptes) | en ligne | 20/08, confirmé à l'écran par Bruno |
| Code v7 lot 1 (niveaux dans l'interface) | livré, à déployer | `js/api.js`, `js/nav.js`, `js/team.js` |

Les scripts SQL vivent dans `sql/` depuis le 20/08. Aucun n'est resté à la
racine. Les anciennes consignes qui parlent de la racine sont périmées.

## 2. Les comptes

| Compte | Niveau | Prospecte | Démo | Jours saisis |
| --- | --- | --- | --- | --- |
| `bbartoli@fluxym.com` | propriétaire | non | non | 0 |
| BBA Test 1 (`...+demo-santiago-performance@gmail.com`) | membre | oui | oui | 59 |
| BBA Test 2 (`...+demo2-...`) | membre | oui | oui | 55 |
| BBA Test 3 (`...+demo3-...`) | administrateur | oui | oui | 48 |
| BBA Test 4 (`...+demo4-...`) | membre | oui | oui | 0 |

Le compte de Santiago n'existe toujours pas. C'est le seul compte réel qui
manque, et le seul dont l'usage quotidien décidera de la valeur de l'outil.

BBA Test 3 est administrateur volontairement, pour observer ce que ce niveau
permet. Depuis la migration 4 il ne peut plus corriger les chiffres des autres,
mais il peut encore supprimer un compte de niveau inférieur.

## 3. Les données de démonstration

`sql/seed-demo-team.sql` remplit trois mois de jours ouvrés sur trois comptes de
démonstration, avec trois profils volontairement dissemblables : le régulier à
gros volume, l'irrégulier qui progresse, le manager qui prospecte à mi-temps.
Ce dernier obtient le plus de RDV par jour travaillé avec le score le plus bas
des trois, ce qui expose la limite du barème actuel plutôt que de la cacher.

Le jeu contient trois pièges de calcul délibérés : des jours saisis à zéro, des
jours entiers sans aucune ligne, et un profil qui ne travaille que quatre jours
par semaine. Toute moyenne qui diviserait par les jours du calendrier au lieu
des jours actifs deviendra visiblement fausse.

Les 65 jours fictifs qui étaient sur le compte propriétaire ont été supprimés le
20/08. Ce compte est vierge.

Attention : `sql/reset-demo.sql` ne vérifie pas que le compte visé est marqué
démonstration, contrairement à `sql/seed-demo-team.sql`. C'est le seul script du
dossier capable d'effacer de la donnée réelle sur une faute de frappe.

## 4. Chantier en cours

**Les niveaux d'accès.** La base est faite et testée : échelle propriétaire,
administrateur, responsable en lecture seule, membre, avec la règle du niveau
strictement inférieur. Le lot 1 côté interface est livré : le menu affiche le
niveau réel, un responsable peut ouvrir la vue d'équipe sans être administrateur,
et le garde-fou anti-boucle de `requireAuth` empêche la redirection infinie d'un
profil sans droit.

Reste le lot 2 : remplacer, dans l'écran Comptes, la case « Administrateur » par
un choix de niveau, et le rendre lisible dans la liste. Tant qu'il n'est pas
fait, attribuer le niveau « responsable » passe par une requête SQL. Les
fichiers concernés sont `admin.html` et `js/admin.js`.

Volontairement hors périmètre : la notion d'équipe. Un responsable voit tout le
monde, pas « son » équipe. Le périmètre par équipe suppose une table d'équipes
et la réécriture de toutes les règles d'accès.

## 5. Prochain sujet retenu

**Le rythme nécessaire.** Afficher, à partir d'un objectif mensuel, le rythme
hebdomadaire qu'il implique et l'écart avec le rythme constaté : « pour 8 RDV ce
mois-ci il faut 2,3 par semaine, tu es à 1,8 ». C'est ce qui fait passer l'outil
de tableau de bord à outil de pilotage. Pas encore engagé.

Réserve à garder en tête : ce sujet suppose des objectifs par période, alors que
`daily_targets` ne porte aujourd'hui que des objectifs journaliers. Il faudra
décider si l'objectif mensuel est dérivé du journalier ou saisi à part, ce qui
change le lot.

## 6. Idées non engagées

1. Objectifs hebdomadaires et mensuels, en plus des objectifs journaliers.
2. Rappel de saisie en fin de journée si aucune action n'a été enregistrée.
3. Champ « secteur » ou « campagne » pour segmenter les performances.
4. Annotation d'un jour depuis le tableau de bord, sans passer par la saisie.
5. Prolonger la chaîne au-delà du RDV obtenu : honoré, no-show, opportunité,
   montant. C'est l'angle mort principal de l'outil, et le plus gros chantier.

## 7. Journal des livraisons

| Date | Version | Contenu |
| --- | --- | --- |
| — | v1 | saisie, tableau de bord, connexion |
| 19/08/2026 | v2 | périodes libres, comparaison, granularité, export CSV |
| 19/08/2026 | correctif | bornes de plage inversées, tableau de bord à zéro |
| 19/08/2026 | v3 | agrandissement des graphiques, course cumulée |
| 19/08/2026 | v4 | info-bulles HTML à la place des `<title>` SVG |
| 20/08/2026 | v5 | multi-utilisateurs, RLS, vue d'équipe |
| 20/08/2026 | v6 lot 1 | rôles à deux axes, contexte par URL, nav, responsive |
| 20/08/2026 | v6 lot 2 | création de compte, mot de passe, suppression |
| 20/08/2026 | données | `sql/seed-demo-team.sql`, 3 mois sur 3 comptes de démo |
| 20/08/2026 | base | `sql/levels-migration-v4.sql`, quatre niveaux d'accès |
| 20/08/2026 | correctif | badge de rôle illisible, intitulé de la page Comptes |
| 20/08/2026 | v7 lot 1 | niveaux dans l'interface, état vide de la vue d'équipe |

## 8. Ce qui n'est pas vérifié

L'agent n'ouvre pas de navigateur connecté : tout ce qui concerne le rendu et
les parcours utilisateur est validé par Bruno, pas par lui. Les règles d'accès,
en revanche, sont testées en base par usurpation d'identité dans des
transactions annulées, ce qui est plus sûr qu'un test à l'écran.

Le plan Supabase est le plan Free. La politique de sauvegarde n'a pas été
vérifiée : ne pas promettre de retour arrière après une migration.

| Écran des comptes, niveaux | ✅ En ligne | Liste déroulante à quatre niveaux, verrouillage aligné sur admin_set_level | 20/08 |
| Création de compte, niveau | ✅ En ligne | Choix du niveau au lieu de la case administrateur ; « responsable » appliqué en second appel | 20/08 |
| Reste à faire, rôles lot 3 | ⏳ À faire | L'Edge Function ignore le niveau du demandeur : un administrateur pourrait créer son égal en l'appelant directement | 20/08 |
