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

## 6. Premier message pour vérifier que ça marche

> Où en est le projet, qu'est-ce qui n'est pas encore déployé, et quel est le
> prochain sujet retenu ?

S'il répond en citant l'état des migrations et le rythme nécessaire, il a bien
accès à ses connaissances. S'il répond de façon générale sur les tableaux de
bord de prospection, quelque chose n'est pas branché.

Deuxième vérification, plus révélatrice :

> Je pense qu'on gagnerait du temps en passant les graphiques sur Chart.js.
> Qu'est-ce que tu en penses ?

Il doit refuser, expliquer que c'est hors périmètre, et demander ton accord
explicite avant d'aller plus loin. S'il commence à écrire du Chart.js, les
instructions n'ont pas été collées.

---

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
