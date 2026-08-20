# Cockpit BDR — État des lieux

*Le seul fichier de ce dossier à tenir à jour souvent. `handover.md` décrit
l'architecture et ne bouge qu'avec elle ; celui-ci dit où on en est. Une ligne
suffit par entrée : s'il faut un paragraphe, ça va dans `handover.md`.*

**Dernière mise à jour : 20/08/2026**

---

## 1. Ce qui est en ligne

| Élément | État | À confirmer par Bruno |
|---|---|---|
| Site GitHub Pages | en ligne | — |
| `bdr-cockpit-schema.sql` | exécuté | — |
| `multi-user-migration.sql` (migration 1) | à confirmer | oui |
| `roles-migration-v2.sql` (migration 2) | à confirmer | oui |
| `accounts-migration-v3.sql` (migration 3) | **non exécutée** | livrée le 20/08 |
| Edge Function `admin-users` | **non déployée** | livrée le 20/08 |
| Code v6 lot 1 (rôles, nav, responsive) | à confirmer | oui |
| Code v6 lot 2 (comptes) | **non déployé** | livré le 20/08 |

## 2. Les comptes

| Compte | Rôle prévu | État |
|---|---|---|
| `bbartoli@fluxym.com` | administrateur, ne prospecte pas | existe |
| Santiago | BDR | à créer |
| `bbartoli+demo@fluxym.com` | BDR, marqué démonstration | à créer |

**Point d'attention non résolu :** les 90 jours de données de démonstration
produits par `seed-demo.sql` sont posés sur le compte de Bruno. Il faut
« Effacer les données » sur sa ligne dans l'écran Comptes, puis rejouer
`seed-demo.sql`, qui cible désormais le compte de démonstration. Tant que ce
n'est pas fait, le compte administrateur porte une activité fictive.

## 3. Prochain sujet retenu

**Le rythme nécessaire.** Afficher, à partir d'un objectif mensuel, le rythme
hebdomadaire qu'il implique et l'écart avec le rythme constaté : « pour 8 RDV ce
mois-ci il faut 2,3 par semaine, tu es à 1,8 ». C'est ce qui fait passer l'outil
de tableau de bord à outil de pilotage. Pas encore engagé.

## 4. Idées non engagées

1. Objectifs hebdomadaires et mensuels, en plus des objectifs journaliers.
2. Rappel de saisie en fin de journée si aucune action n'a été enregistrée.
3. Champ « secteur » ou « campagne » pour segmenter les performances.
4. Annotation d'un jour depuis le tableau de bord, sans passer par la saisie.
5. Prolonger la chaîne au-delà du RDV obtenu : honoré, no-show, opportunité,
   montant. C'est l'angle mort principal de l'outil, et le plus gros chantier.

## 5. Journal des livraisons

| Date | Version | Contenu |
|---|---|---|
| — | v1 | saisie, tableau de bord, connexion |
| 19/08/2026 | v2 | périodes libres, comparaison, granularité, export CSV |
| 19/08/2026 | correctif | bornes de plage inversées, tableau de bord à zéro |
| 19/08/2026 | v3 | agrandissement des graphiques, course cumulée |
| 19/08/2026 | v4 | info-bulles HTML à la place des `<title>` SVG |
| 20/08/2026 | v5 | multi-utilisateurs, RLS, vue d'équipe |
| 20/08/2026 | v6 lot 1 | rôles à deux axes, contexte par URL, nav, responsive |
| 20/08/2026 | v6 lot 2 | création de compte, mot de passe, suppression |
