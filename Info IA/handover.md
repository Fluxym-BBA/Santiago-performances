# Cockpit BDR — Document de reprise (handover)

**Dernière mise à jour : 19/08/2026**
**État de référence : branche `main`, première livraison applicative**

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

## 6. Pièges connus

- **Dates** : toujours passer par `toISO()` / `fromISO()` de `api.js`. Un
  `new Date().toISOString()` décalerait la saisie du soir sur la veille.
- **Pondération du score** : définie dans la vue SQL *et* dans `WEIGHTS`
  (`js/saisie.js`). Les deux doivent rester identiques.
- **RLS** : ne jamais la désactiver. La clé `anon` est publique par nature, la
  RLS est la seule protection des données.
- **`maybeSingle()`** est utilisé partout où l'absence de ligne est normale
  (jour sans saisie, objectifs jamais définis). Ne pas le remplacer par
  `single()`, qui lèverait une erreur.
- **Plan Free Supabase** : un projet sans aucune requête pendant 7 jours est
  mis en pause. L'usage quotidien suffit à l'éviter.
- **Contrainte `calls_connected <= calls_made`** : voulue. Si Santiago la
  trouve gênante (rappels entrants comptés comme aboutis sans appel sortant),
  la supprimer explicitement plutôt que la contourner côté front.

## 7. Reste à faire (idées, non engagées)

1. Export CSV de l'historique.
2. Vue hebdomadaire et mensuelle agrégée (cumuls, objectifs de semaine).
3. Comparaison entre plusieurs BDR (le schéma est déjà multi-utilisateur : il
   suffirait d'ajouter un rôle manager et des politiques RLS de lecture).
4. Rappel de saisie en fin de journée si aucune action n'a été enregistrée.
5. Champ « secteur » ou « campagne » pour segmenter les performances.
