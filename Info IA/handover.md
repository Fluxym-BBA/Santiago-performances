# Cockpit BDR — Document de reprise (handover)

**Dernière mise à jour : 19/08/2026 (v2 du dashboard)**
**État de référence : branche `main`**

## 1. Ce qu'est le projet

Application de suivi quotidien de la productivité d'un BDR, pour Santiago.
Deux écrans : saisie du jour et analyse de performance. Un écran de connexion.

Objectif métier : disposer d'une mémoire fiable des actions de prospection
(appels, appels aboutis, RDV, e-mails, enrichissement CRM), pouvoir corriger un
jour passé, et comparer une journée à la veille, au record ou à la moyenne.

## 2. Périmètre technique et interdits

Site 100 % statique servi par GitHub Pages : HTML, CSS, JS vanilla. Aucun
build, aucun bundler, aucun framework, aucune dépendance npm. Toute proposition
d'introduire React, Vue, Tailwind, SCSS ou un pipeline de build est hors
périmètre et doit être validée explicitement par Bruno BARTOLI.

Deux exceptions assumées, déjà en place :
- `supabase-js` chargé en ESM depuis `cdn.jsdelivr.net` (indispensable pour
  parler à la base) ;
- rien d'autre. Les graphiques sont du SVG écrit à la main dans `js/ui.js`, et
  leurs info-bulles du HTML piloté par `js/tooltip.js`.

## 3. Dépôt et hébergement

| | |
|---|---|
| Dépôt | `Fluxym-BBA/Santiago-performances` (public) |
| Branche de référence | `main` |
| URL publique | `https://fluxym-bba.github.io/Santiago-performances/` |
| Hébergement | GitHub Pages, `Deploy from a branch` → `main` / `(root)` |
| Base de données | Supabase, région Europe, plan Free |

Politique d'indexation : `robots.txt` interdit l'exploration et les trois pages
portent `<meta name="robots" content="noindex, nofollow">`.

⚠️ Ne pas ajouter de fichier `CNAME` avant que l'enregistrement DNS
correspondant existe et résolve. Sur `rfe.fluxym.com`, l'ordre inverse a mis le
site hors ligne.

## 4. Design system

Repris à l'identique de `rfe.fluxym.com` : thème clair, police Inter, variables
CSS natives dans `:root`, pas de SCSS.

```
--navy #0B2046   --navy-light #132d5e
--cyan #00A7E1   --purple #6366f1
--success #10b981  --warning #f59e0b  --danger #ef4444
--gray-50 → --gray-900, --radius-sm → --radius-full, --shadow-sm → --shadow-navy
```

Icônes : emojis natifs, aucune librairie. Les héros sont sur fond navy avec
texte blanc, le corps de page sur `--gray-50`.

## 5. Architecture des fichiers

`js/config.js` est le seul fichier à modifier pour changer d'environnement.
`js/api.js` est la couche d'accès : client Supabase, auth, requêtes, helpers de
dates et **définition centrale des métriques** (constante `METRICS`).

Ajouter une nouvelle métrique se fait en 3 gestes :
1. `alter table public.daily_activity add column ... integer not null default 0;`
2. ajouter la colonne dans la vue `v_daily_kpi` (et sa pondération si besoin) ;
3. ajouter une entrée dans `METRICS` (`js/api.js`) avec son `group`
   (`crm`, `calls`, `emails`), sa couleur et sa clé d'objectif.
L'interface de saisie, les jauges, le dashboard, les graphiques et le tableau
se mettent à jour tout seuls.

## 6. Architecture du dashboard (v2)

Le dashboard ne connaît qu'un seul concept : **la période**. `state.a` et
`state.b` sont deux objets `{ from, to }`. Une journée est une période d'un jour.
Il n'y a volontairement aucun mode « jour » séparé d'un mode « mois ».

Les graphiques sont déclarés dans un **registre** (`const CHARTS = [...]`), une
entrée par carte :

```js
{
  key,            // identifiant technique
  title,          // titre affiché
  wide,           // occupe toute la largeur de la grille
  hint(ctx),      // phrase d'explication, reçoit le contexte
  legend(),       // [[couleur, libellé], ...] (optionnel)
  select,         // sélecteur intégré à la carte (optionnel)
  render(host, ctx)
}
```

`ctx` est produit par `ctxFor(chart, { big, scope })` et contient les lignes des
deux périodes, la granularité et le mode de lecture. Comme `render()` ne connaît
que son conteneur et son contexte, **le même code dessine la carte dans la
grille et dans la fenêtre d'agrandissement**. Ajouter un graphique = ajouter une
entrée au registre, rien d'autre. Ne jamais écrire un graphique en dur dans le
HTML.

Fonctions à connaître avant toute modification :

| Fonction | Rôle |
|---|---|
| `rowsFor(p)` | lignes d'une période, jours manquants complétés à zéro |
| `agg(rows)` | cumuls, jours actifs, taux **recalculés** depuis les volumes |
| `val(a, key, mode)` | valeur en cumul ou en moyenne par jour actif |
| `bucketize(rows, gran)` | regroupement par jour, semaine ISO ou mois |
| `effGran()` / `effMode()` | granularité et mode effectifs (gèrent le mode auto) |
| `toDate(a, bFrom, bTo)` | comparaison « à date » des présets |
| `bestEquivalentPeriod(len, avoid)` | meilleure fenêtre de même durée dans l'historique |
| `renderPanelPair(host, ctx, metrics)` | deux panneaux superposés à échelle partagée |
| `renderScorePanel(aA)` | encadré du score avec décomposition chiffrée |

Chaque entrée du registre expose `icon`, `title`, `sub(ctx)`, `legend(ctx)`,
`note(ctx)` et `render(host, ctx)`. `legend()` renvoie des items structurés
passés à `legendHtml()` (`{ color, label, shape }`, `{ pair: [cA, cB], label }`,
`{ periodStyle: 'a' | 'b' }`, `{ head }`). Ne pas écrire de légende à la main
dans le HTML ni en prose sous le titre : c'est le défaut corrigé en v3.

Les dates propres à une carte vivent dans `scopes` (Map clé → période). La carte
et sa vue agrandie partagent cet état, donc modifier les dates en grand se voit
en petit. Quand une carte a ses propres dates, sa référence devient
`previousPeriod(scope)`, ce que la légende affiche explicitement.

Règle de couleur à respecter : bleu = période analysée (`A_SHADES`), violet =
période de référence (`B_SHADES`). Le gris ne porte jamais de sens, il ne sert
qu'aux fonds et aux libellés secondaires.

Règle de calcul à ne pas casser : **les taux ne se moyennent jamais**. Ils sont
recalculés à partir des volumes agrégés (`somme aboutis / somme appels`). Faire
la moyenne des taux quotidiens donnerait le même poids à un jour à 2 appels et à
un jour à 50.

Une seule requête réseau par rafraîchissement : `refresh()` charge la plage qui
couvre A, B et 13 mois d'historique (nécessaire au record absolu, à la série en
cours et à la recherche de la meilleure période). Tout le reste est calculé en
mémoire. Ne pas ajouter de requête par graphique.

## 6 bis. Les info-bulles (v4)

Le `<title>` natif du SVG a été **entièrement retiré**. Ne pas le réintroduire :
le navigateur l'affiche après environ une seconde, dans le style du système, sur
une seule ligne, et il ne peut porter qu'une seule série. C'était le dernier point
de friction signalé à l'usage.

Le remplacement tient en deux morceaux.

`js/tooltip.js` — le moteur, sans connaissance du métier :

- un **seul** élément `.tip` pour toute la page, créé au premier affichage ;
- `showTip(model, event, key)` : le HTML n'est réécrit que si `key` change, donc
  déplacer la souris dans une même colonne ne coûte rien ;
- position en `position: fixed` déplacée par `transform`, calculée dans un
  `requestAnimationFrame`, avec bascule à gauche et recadrage aux bords ;
- `tipHtml(model)` rend un modèle déclaratif :
  `{ title, meta, sections: [{ head, accent: 'a'|'b', badge, rows: [{ color, shape, label, sub, value, em, muted }] }], deltas, foot }`.
  Une section sans ligne est ignorée, tout le texte est échappé ;
- fermetures de sécurité : défilement (en phase de **capture**, pour attraper le
  défilement interne de la fenêtre d'agrandissement), perte de focus, `Échap`,
  pression tactile hors graphique, nouveau rendu d'un graphique (`baseFrame`
  appelle `hideTip`).

`js/ui.js` — `installHover(f, { count, bandAt, build, onEnter, onLeave })` :

- crée un `<rect>` transparent par index, **en dernier** dans le SVG pour être
  au-dessus du tracé. Ce sont des éléments SVG, donc ils suivent la mise à
  l'échelle du `viewBox` : aucune conversion de coordonnées à écrire ;
- les bandes se chevauchent d'une demi-largeur et la dernière déclarée gagne,
  ce qui donne exactement le point le plus proche du curseur ;
- `onEnter(i)` déplace les décorations créées une fois pour toutes (trait de
  repère vertical, une pastille par série, un losange par ligne de référence,
  surbrillance du groupe de barres). Rien n'est créé ni détruit au survol.

Découpage des zones selon le graphique :

| Graphique | Zone de survol |
|---|---|
| `lineChart` | une colonne pleine hauteur par point |
| `barChart` | le groupe de barres entier, pas la barre |
| `compareChart` | la ligne entière, sur toute la largeur |
| `funnel` | l'étape (HTML, pas SVG) |

Les modèles sont construits **dans le registre `CHARTS` de `dashboard.js`**, seul
endroit qui connaît les deux périodes à la fois. C'est ce qui permet à la bulle du
panneau A de contenir les valeurs de B. Pour `renderPanelPair`, un unique `tip`
est passé aux deux appels de `barChart`.

Helpers d'écart, dans `dashboard.js` :

- `dl(a, b, dec)` : flèche, valeur absolue, pourcentage. `dec = true` pour les
  moyennes, sinon un écart de 0,2 s'afficherait « +0 » ;
- `ppl(a, b)` : écart entre deux taux, en **points** de pourcentage. Ne jamais
  faire un pourcentage d'un pourcentage ;
- `bucketTitle(b, gran)` : date longue pour un jour, `label · plage` sinon.

Si un graphique est ajouté au registre, lui donner un `tip` et un `hover` (la
phrase « Au survol » de la note dépliable). Sans `tip`, aucune bande n'est créée :
pas de surcoût, mais pas d'info-bulle non plus.

## 6 ter. Le multi-utilisateurs (v5)

### Le choix d'architecture, et pourquoi il ne faut pas le défaire

Une seule base, une seule table, isolation par RLS. La demande initiale parlait
de « une base par utilisateur » : c'est la mauvaise réponse. Vingt-deux projets
Supabase, vingt-deux jeux de clés, vingt-deux migrations à rejouer, et aucune
requête inter-utilisateurs possible, donc pas de vue d'équipe. La RLS est le
mécanisme prévu par PostgreSQL pour exactement ce besoin.

### Les trois pièges du multi-tenant, tous désamorcés

1. **Le rôle dans le jeton.** Ne JAMAIS mettre le rôle dans `user_metadata` :
   le client peut le modifier lui-même avec `auth.updateUser()`, donc n'importe
   qui se promeut administrateur. `app_metadata` serait sûr mais exige la clé
   `service_role`. D'où la table `profiles` plus la fonction `is_admin()`.
2. **La récursion RLS.** Une règle sur `profiles` qui interroge `profiles`
   provoque l'erreur 42P17. `is_admin()` est donc en `SECURITY DEFINER`, avec
   `search_path` figé pour qu'un schéma pirate ne puisse pas détourner la
   résolution des noms.
3. **Les vues qui contournent la RLS.** Une vue s'exécute par défaut avec les
   droits de son propriétaire, donc elle expose tout à tout le monde.
   `with (security_invoker = true)` est obligatoire sur `v_daily_kpi`,
   `v_best_day` et `v_team_daily`. C'était déjà le cas, ne pas le retirer.

### Restriction des colonnes modifiables

La règle RLS `profiles_update_own_name` autorise un utilisateur à modifier SA
ligne, et c'est le `GRANT UPDATE (display_name)` qui décide quelles colonnes.
Une policy ne sait pas restreindre par colonne : sans ce GRANT limité, un BDR
pourrait se promouvoir administrateur. Le rôle, l'activation et le marqueur de
démonstration passent obligatoirement par `admin_update_profile()`, qui vérifie
les droits et **protège le dernier administrateur actif** : sans ce garde-fou,
une fausse manoeuvre rendrait l'administration définitivement inaccessible.

### Le piège côté front, celui qui a demandé le plus d'attention

Tant que chacun ne voyait que ses lignes, les requêtes pouvaient se passer de
filtre : la RLS faisait le tri. Dès qu'un administrateur voit tout le monde, la
**même requête renvoie l'activité de tous les utilisateurs mélangée**. Chaque
lecture porte donc désormais un `.eq('user_id', target())` explicite.

La RLS reste la barrière de sécurité, le filtre n'est que la sélection du
périmètre. Les deux sont nécessaires et ne servent pas à la même chose. Si une
requête est ajoutée un jour dans `api.js`, elle doit porter ce filtre, sinon un
administrateur verra des données agrégées de toute l'équipe en croyant regarder
une seule personne. Le fichier de test dédié vérifie ce point sur toutes les
lectures et écritures.

### État du périmètre consulté

`viewedUser()` est l'utilisateur regardé, `myProfile()` celui connecté. Ils
diffèrent quand un administrateur consulte quelqu'un d'autre.

- persistance en `sessionStorage`, jamais `localStorage` : le périmètre ne doit
  pas survivre à la fermeture du navigateur ;
- restauration **ignorée pour un non-administrateur** : un compte rétrogradé ne
  conserve pas son accès ;
- `bump()` envoie `p_user_id: null` quand on saisit pour soi, et la base retombe
  sur `auth.uid()`. Elle refuse une cible différente si l'appelant n'est pas
  administrateur.

### analytics.js

Les calculs d'agrégat, de paquets et de granularité sont sortis de
`dashboard.js` le jour où la vue d'équipe en a eu besoin. Dupliquer un calcul de
taux ou de jours actifs aurait garanti que les deux pages finissent par afficher
des chiffres différents pour la même chose. Règle du module : aucun DOM, aucun
état, aucun réseau. Tout entre par les arguments.

### Couleurs de la vue d'équipe

Sur `team.html` une couleur désigne une **personne**, pas une période, et elle
est tenue du classement aux graphiques. Le bleu et le violet reprennent leur
rôle habituel dans le duel, qui est bien une comparaison de deux ensembles.
Au-delà de `MAX_SERIES` (8), seules les premières du classement sont tracées.

### Ce qui reste hors de portée du front

Créer un compte, réinitialiser un mot de passe, supprimer un compte
d'authentification : tout cela exige `service_role`, donc Supabase ou une Edge
Function. Une Edge Function imposerait un déploiement par CLI, ce qui casserait
la règle « aucun build ». L'écran Comptes explique donc la marche à suivre dans
Supabase en quatre étapes plutôt que de promettre un bouton qui échouerait.

## 6 quater. Rôles à deux axes, contexte par URL, responsive (v6)

### Le modèle de rôles

`role` texte a disparu, remplacé par `is_admin` et `is_bdr`, deux booléens
indépendants. Motif : un seul axe forçait un administrateur à être traité comme
un commercial, avec une page de saisie qui n'avait pas de sens et un score de
zéro dans les classements.

`is_admin()` a gardé exactement son nom et sa signature, elle lit simplement la
nouvelle colonne. C'est ce qui a permis de ne toucher **aucune** règle RLS : tout
l'intérêt d'être passé par une fonction plutôt que d'écrire `role = 'admin'`
dans chaque policy. Ne pas revenir en arrière là-dessus.

`normalize()` dans `api.js` accepte encore l'ancienne colonne `role` en repli.
Cela rend l'ordre de déploiement indifférent, l'application fonctionnant avant
comme après la migration. Ce repli peut être retiré une fois la migration passée
partout, mais il ne coûte rien.

Conséquences en cascade, à ne pas oublier si un écran est ajouté :
- `fetchTeamRange` filtre `is_bdr = true` par défaut ;
- `team.js` exclut les non-commerciaux de la liste des personnes suivies ;
- `requireAuth({ needs })` redirige vers `homePageFor()` ;
- la navigation est construite depuis le profil, pas écrite en dur.

### Le contexte est dans l'URL, plus jamais dans la session

`sessionStorage` et `setViewedUser()` ont disparu. Le contexte vient du
paramètre `?u=<identifiant>`, résolu une seule fois par `loadProfile()`.

C'était un vrai défaut de conception : un état caché décidait dans quel compte
on écrivait, et le bandeau n'était qu'un pansement. Avec l'URL, la page est
rechargeable et partageable, il n'y a rien à « remettre à zéro », et un
non-administrateur qui bricole le paramètre est redirigé.

Exception à connaître dans `requireAuth` : `needs: 'bdr'` est satisfait si
l'appelant est administrateur **et** en train de consulter quelqu'un. Sans cette
exception, un administrateur pur ne pourrait pas ouvrir `dashboard.html?u=...`,
alors que c'est précisément le chemin prévu depuis la vue d'équipe.

`linkFor(page, userId, extra)` construit les liens : il omet le paramètre quand
la cible est soi-même, ce qui évite des URL inutilement bavardes.

L'écriture pour autrui demande une confirmation nommée, une fois par session de
travail (`allowWrite()` dans `saisie.js`). Redemander à chaque bouton rendrait
la correction d'une journée insupportable, ne rien demander ramènerait le risque
de l'ancien sélecteur.

### La barre de navigation

Trois paliers dans `css/app.css`, un seul jeu d'éléments dans `nav.js`. La règle
non négociable : **rien n'est jamais tronqué**. Concrètement, `white-space:
nowrap` sur tous les libellés, aucun `text-overflow: ellipsis` dans le fichier,
des libellés déclinés en trois longueurs (`label`, `short`, `mini`), et un nom
raccourci volontairement en « Prénom N. » par `shortNameOf()`.

Si une section est ajoutée, vérifier que trois onglets tiennent encore à 1024
pixels. Au-delà de trois, la barre doit passer en mode réduit plus tôt, pas
comprimer.

### Le responsive du contenu

Quatre points, tous dans `ui.js` et `css/app.css` :

1. `baseFrame` cale la largeur du repère SVG sur celle du conteneur
   (`availWidth`). Avant, le repère était figé à 760 : sur 375 pixels, tout
   était divisé par deux, textes compris. Ne jamais revenir à une largeur fixe.
2. La hauteur est bornée à 62 % de la hauteur de fenêtre, sauf `clampHeight:
   false`, utilisé par `compareChart` dont la hauteur est une somme de lignes :
   la rogner couperait la dernière ligne.
3. Les marges sont resserrées sur petit écran **uniquement si la marge gauche
   sert à un axe numérique** (`pad.l < 60`). Une marge large porte des libellés
   de texte, la réduire les tronquerait.
4. `onResize` ne réagit qu'aux variations réelles, plus de 40 pixels de large ou
   un changement d'orientation. Sur mobile, le défilement fait varier la hauteur
   de la fenêtre à cause de la barre d'adresse : redessiner à chaque pixel
   rendrait la page inutilisable.

Les tableaux deviennent des cartes sous 760 pixels grâce à l'attribut `data-th`
porté par chaque cellule. **Toute nouvelle colonne doit porter son `data-th`**,
sinon elle apparaîtra sans étiquette sur téléphone.

## 7. Pièges connus

- **Dates** : toujours passer par `toISO()` / `fromISO()` de `api.js`. Un
  `new Date().toISOString()` décalerait la saisie du soir sur la veille.
- **Pondération du score** : définie dans la vue SQL *et* dans `SCORE_WEIGHTS`
  (`js/api.js`). Ces deux-là doivent rester identiques. Ne jamais recopier les
  poids ailleurs : la saisie, le dashboard et les textes explicatifs lisent tous
  `SCORE_WEIGHTS`.
- **RLS** : ne jamais la désactiver. La clé `anon` est publique par nature, la
  RLS est la seule protection des données.
- **Bornes de plage** : la plage chargée par `refresh()` doit être le **minimum**
  des débuts et le **maximum** des fins des deux périodes. Utiliser `minISO` et
  `maxISO`, jamais un `reduce` écrit à la main : une inversion produit une plage
  vide, donc un dashboard entièrement à zéro alors que la base est pleine et que
  le record absolu, chargé par une requête séparée, s'affiche correctement.
  C'est exactement le symptôme du bug corrigé le 19/08/2026.
- **`maybeSingle()`** est utilisé partout où l'absence de ligne est normale
  (jour sans saisie, objectifs jamais définis). Ne pas le remplacer par
  `single()`, qui lèverait une erreur.
- **Plan Free Supabase** : un projet sans aucune requête pendant 7 jours est
  mis en pause. L'usage quotidien suffit à l'éviter.
- **Contrainte `calls_connected <= calls_made`** : voulue. Si Santiago la
  trouve gênante (rappels entrants comptés comme aboutis sans appel sortant),
  la supprimer explicitement plutôt que la contourner côté front.

## 8. Reste à faire (idées, non engagées)

1. Objectifs hebdomadaires et mensuels, en plus des objectifs journaliers.
2. Comparaison entre plusieurs BDR (le schéma est déjà multi-utilisateur : il
   suffirait d'ajouter un rôle manager et des politiques RLS de lecture).
3. Rappel de saisie en fin de journée si aucune action n'a été enregistrée.
4. Champ « secteur » ou « campagne » pour segmenter les performances.
5. Annotation d'un jour depuis le dashboard, sans passer par la page de saisie.

Fait en v2 : périodes libres, comparaison de périodes, granularité
jour/semaine/mois, agrandissement des graphiques avec dates locales, course
cumulée entre deux périodes, export CSV.
