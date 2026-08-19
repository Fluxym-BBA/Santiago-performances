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
- rien d'autre. Les graphiques sont du SVG écrit à la main dans `js/ui.js`.

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

Règle de calcul à ne pas casser : **les taux ne se moyennent jamais**. Ils sont
recalculés à partir des volumes agrégés (`somme aboutis / somme appels`). Faire
la moyenne des taux quotidiens donnerait le même poids à un jour à 2 appels et à
un jour à 50.

Une seule requête réseau par rafraîchissement : `refresh()` charge la plage qui
couvre A, B et 13 mois d'historique (nécessaire au record absolu, à la série en
cours et à la recherche de la meilleure période). Tout le reste est calculé en
mémoire. Ne pas ajouter de requête par graphique.

## 7. Pièges connus

- **Dates** : toujours passer par `toISO()` / `fromISO()` de `api.js`. Un
  `new Date().toISOString()` décalerait la saisie du soir sur la veille.
- **Pondération du score** : définie dans la vue SQL *et* dans `WEIGHTS`
  (`js/saisie.js`). Les deux doivent rester identiques.
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
