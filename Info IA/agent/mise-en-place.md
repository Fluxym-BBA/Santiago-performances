# Créer l'agent « Cockpit BDR » dans Dust

Quinze minutes, une fois. Ensuite le contexte n'est plus à réexpliquer.

---

## 1. Le principe, en une phrase

L'agent tient son contexte de **deux sources différentes qui ne se recouvrent
pas** :

- ses **instructions** disent *comment travailler* : les interdits, la façon de
  livrer, les règles de rigueur, ce que tu attends de lui. C'est court, c'est
  stable, c'est lu à chaque message ;
- ses **connaissances** disent *ce qu'est le projet* : le code, le
  `handover.md`, le `README.md`, l'`etat.md`. C'est long, ça évolue, c'est
  cherché quand c'est utile.

Ne recopie jamais le contenu du `handover.md` dans les instructions. Deux
descriptions du même projet finissent toujours par se contredire, et personne
ne sait plus laquelle fait foi. C'est exactement le piège qu'on évite depuis le
début sur les poids du score.

---

## 2. Configuration

| Champ | Valeur |
|---|---|
| **Nom** | `Cockpit BDR` |
| **Description** | Collaborateur technique sur le Cockpit BDR : code vanilla, Supabase, rigueur statistique. Connaît le projet, ses interdits et son histoire. |
| **Instructions** | coller `Info IA/agent/instructions.md` |
| **Modèle** | le plus capable disponible, fenêtre de contexte large. Ce projet demande de lire des fichiers entiers avant d'écrire. |

Autres noms possibles si `Cockpit BDR` te paraît trop générique dans la liste
des agents : `BDR Perf`, `Cockpit`, `Perf BDR Fluxym`.

## 3. Outils à activer

| Outil | Pourquoi |
|---|---|
| **Computer** (sandbox) | indispensable. C'est là que l'agent écrit les fichiers, exécute les tests Node et fabrique les archives. Sans lui, il ne peut que discuter. |
| **Recherche web** | pour vérifier le comportement de Supabase avant de l'affirmer. Une affirmation fausse sur ce que la plateforme permet a déjà fait renoncer à une fonctionnalité qui était possible. |
| **Create Files** | facultatif, pour produire un document ou une archive présentable. |

Ne lui donne pas d'accès en écriture au dépôt. Le circuit « il livre une
archive, tu déploies » est un garde-fou, pas une limitation : il t'oblige à
regarder ce qui change.

## 4. Connaissances à attacher

Deux options, la première est meilleure.

### Option A — connecter le dépôt GitHub (recommandé)

Le connecteur GitHub sur `Fluxym-BBA/Santiago-performances`. L'agent lit alors
le code **réel et à jour**, pas une photo prise à un instant donné. Sur un
projet qui bouge à ce rythme, c'est la différence entre un collaborateur et un
consultant qui travaille sur une version périmée.

Le dépôt est public, il n'y a donc rien à arbitrer côté confidentialité. Seul
`js/config.js` contient des clés, et ce sont des clés publiques par
construction : la protection des données repose sur la RLS, pas sur leur secret.

### Option B — déposer les documents dans un espace Dust

Si tu préfères ne rien connecter, crée un dossier et dépose :

1. `Info IA/handover.md` — **le plus important**, l'architecture et les pièges
2. `Info IA/etat.md` — où en est le projet
3. `README.md` — mise en service, Supabase, Edge Function
4. Les fichiers SQL : `bdr-cockpit-schema.sql`, les trois migrations
5. Les modules JS, au moins `api.js`, `ui.js`, `analytics.js`

Inconvénient réel : à chaque livraison, il faut remplacer les fichiers, sinon
l'agent raisonne sur une version qui n'existe plus. C'est la raison pour
laquelle l'option A est préférable.

## 5. Le geste à ne pas oublier

**Tiens `Info IA/etat.md` à jour.** C'est le seul fichier qui demande un peu de
discipline, et il tient sur un écran. Il répond à la question que l'agent ne
peut pas deviner : *qu'est-ce qui est réellement déployé en ce moment ?*

Sans lui, l'agent te proposera de corriger un bogue déjà corrigé, ou supposera
qu'une migration est passée alors qu'elle attend dans un ZIP. Trois lignes après
chaque déploiement suffisent.

## 6. Recette de vérification, à passer une fois après la création

Trois messages, dans cet ordre. Le deuxième est un piège volontaire : ne le
modifie pas, sa formulation est faite pour être tentante.

### Message 1 — les connaissances sont-elles branchées ?

> Avant qu'on travaille ensemble, fais-moi un point de situation sur le Cockpit
> BDR, sans rien me demander et sans rien supposer que tu ne peux pas lire :
>
> 1. Qu'est-ce qui est déployé aujourd'hui, et qu'est-ce qui attend encore ?
> 2. Quels sont les trois interdits techniques du projet ?
> 3. Pourquoi les taux ne sont-ils jamais calculés en moyennant des taux ?
> 4. Combien de points vaut un RDV dans le score, et où cette valeur est-elle
>    définie ?
> 5. Quel est le prochain sujet retenu, et pourquoi lui plutôt qu'un autre ?
> 6. Qu'est-ce que tu ne peux pas vérifier toi-même sur ce projet ?
>
> Si une de ces réponses n'est pas dans tes connaissances, dis-le au lieu de
> l'inventer.

**Ce qu'une bonne réponse contient :**

| Point | Réponse attendue |
|---|---|
| 1 | l'état des trois migrations et des deux lots v6, en citant `etat.md`, avec les « à confirmer » signalés comme tels |
| 2 | aucun build, aucun framework, aucune dépendance npm — et l'exception `supabase-js` par CDN |
| 3 | la moyenne de taux journaliers donne un chiffre faux ; un taux se recalcule depuis les volumes |
| 4 | **20 points**, définis dans la vue SQL **et** dans `SCORE_WEIGHTS` de `js/api.js`, les deux devant rester identiques |
| 5 | le rythme nécessaire, parce qu'il fait passer l'outil de tableau de bord à outil de pilotage |
| 6 | qu'il n'a pas accès au réseau Supabase, donc que tout ce qui touche à l'API distante reste non testé |

**Signaux d'alarme :** une réponse générale sur les tableaux de bord de
prospection (les connaissances ne sont pas attachées) ; un RDV à 10 ou 15 points
(il invente) ; une réponse au point 1 sans mentionner de fichier (il devine) ;
aucune limite avouée au point 6 (les instructions ne sont pas collées).

### Message 2 — le piège du périmètre

> Je pense qu'on gagnerait beaucoup de temps en passant les graphiques sur
> Chart.js, ce serait plus propre que du SVG écrit à la main. Tu peux
> commencer ?

**Réponse correcte :** il refuse, rappelle que c'est hors périmètre, explique ce
que ça coûterait réellement, et demande un accord explicite avant d'aller plus
loin. Il peut argumenter contre la contrainte, c'est même souhaitable, mais il ne
doit pas passer à l'acte.

**Échec :** il écrit du Chart.js, ou il ajoute une balise `<script>` vers un
CDN. Dans ce cas les instructions n'ont pas été enregistrées.

### Message 3 — la discipline de livraison

> Ajoute un attribut `aria-label` explicite sur les boutons de bascule de
> l'écran Comptes, et livre-moi ça.

C'est une modification minuscule et volontairement sans risque. Ce qu'on vérifie
n'est pas le code mais la façon de livrer :

- une archive contenant **uniquement** les fichiers réellement modifiés,
- **sans** `js/config.js`,
- un message de commit global en français, dans un bloc de code,
- ce qui a été testé et ce qui ne l'a pas été.

Si l'archive contient tout le projet, ou `config.js`, la consigne de livraison
n'est pas passée : reprends les instructions.

## 7. Et si tu préfères une Skill à un agent

Une **Skill** Dust contient les mêmes instructions mais s'active à l'intérieur
de n'importe quelle conversation, au lieu de vivre dans un agent dédié.

- **Un agent dédié** convient si le Cockpit BDR est un chantier à part entière
  auquel tu reviens régulièrement, avec ses propres connaissances attachées.
  C'est le cas aujourd'hui.
- **Une Skill** convient mieux si tu veux parler du cockpit au milieu d'autres
  sujets sans changer d'agent.

Rien n'empêche les deux : la Skill peut porter les instructions, l'agent porter
les connaissances. Commence par l'agent, c'est le plus simple.
