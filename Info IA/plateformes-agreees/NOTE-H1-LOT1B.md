# Chantier H1 — lot 1B : poids économique et rattachement capitalistique

**Relevé du 22/08/2026** · auteur : RFE_WebSite · patch associé : `patches/patch-H1-LOT1B.json`

⚠️ **Ce patch doit être fusionné après `patch-H1-LOT1A.json`** : il corrige la fiche YOOZ PDP livrée au lot 1A. Dans l'ordre inverse, le lot 1A écraserait le poids économique de Yooz.

## La découverte du lot : Itesoft et Yooz sont sur le même palier

Trois faits, tous établis au registre :

1. **Même adresse.** ITESOFT est domiciliée au Séquoia, chemin Parc d'Andron, 30470 Aimargues. YOOZ PDP est domiciliée au Séquoia, Parc d'Andron, à Aimargues. La holding CDML aussi. Ces adresses figurent déjà dans la liste DGFiP du référentiel.
2. **Même homme.** Didier Charpentier préside le conseil d'administration d'ITESOFT depuis le 28/12/2016 et préside la holding **CDML** (SIREN 435005756, capital 9,13 M€, fonds propres 20,3 M€) depuis le 23/01/2019.
3. **CDML contrôle Yooz.** CDML est président de YOOZ (SIREN 808386148) depuis le 22/09/2016, et YOOZ est président de l'entité agréée YOOZ PDP. Laurent Charpentier est directeur général de YOOZ depuis le 24/02/2023.

Ce qui **n'est pas** établi : la chaîne capitalistique de CDML vers ITESOFT. Retirée de la cote en juin 2024, Itesoft ne rend pas son actionnariat opposable, et CDML ne figure pas parmi ses dirigeants.

La règle 29 interdisait de publier une liaison de groupe sans pièce. Mais perdre ces trois faits aurait été pire. D'où un **type de liaison nouveau — `controle_personnel_commun`** — qui expose ce qui est établi sans affirmer ce qui ne l'est pas. C'est la **règle 33**.

**Lecture commerciale.** Deux agréments, deux segments : Itesoft sur le grand compte, Yooz sur la TPE-PME, pilotés depuis le même site par le même homme. Face à un client, la bonne question n'est pas laquelle des deux plateformes on affronte, mais **par quelle porte cette sphère entre**. C'est exactement le raisonnement de la règle 26, appliqué cette fois à un contrôle familial et non à un fonds.

## Yooz : le poids économique était invisible

Le lot 1A avait établi que YOOZ PDP est une coquille sans comptes. La lecture sur la société opérationnelle change complètement le tableau :

| YOOZ (SIREN 808386148) | 2023 | 2024 |
|---|---|---|
| Chiffre d'affaires | 36,9 M€ | **47,3 M€** (+28,2 %) |
| dont export | — | 7,01 M€ (14,8 %) |
| EBITDA | −244 k€ | **+2,08 M€** |
| Résultat net | −79,1 k€ | **+2,53 M€** |
| Effectif | — | **328** |

**La plus forte croissance du lot, doublée d'un retournement de rentabilité** — et un effectif de 328 salariés là où la tranche INSEE publiée annonce 200 à 249. Un référentiel qui n'aurait lu que l'entité agréée aurait classé Yooz parmi les acteurs négligeables. C'est la démonstration de la règle 30.

## Deux angles morts comptables → règle 34

Les deux fintechs les plus notoires du lot ne déposent plus :

| | Dernier exercice déposé | Exercices manquants | Ce qui est connu |
|---|---|---|---|
| **AGICAP** | 2019 | **6** | résultat net −426 k€ ; CA non restitué |
| **SPENDESK** | 2020 | **5** | CA 8,21 M€, résultat **−18,1 M€**, trésorerie 31,8 M€, 166 salariés |

L'écart entre la notoriété de ces sociétés et leur transparence comptable est le plus marqué du référentiel. Conséquence directe de la règle 11d : **tout chiffre récent qui circule sur elles est une estimation d'agrégateur, jamais un compte.** Les chiffres ci-dessus sont publiés avec leur exercice et le nombre d'exercices manquants — jamais comme données courantes.

À noter sur Spendesk, un signal de gouvernance : la présidence du conseil est assurée depuis le 05/02/2025 par **POINT79 MANAGEMENT LIMITED**, personne morale de droit étranger, le fondateur Rodolphe Ardant ayant cédé la présidence en octobre 2024.

## Deux sociétés en compression de marge

**TENOR** croît sans convertir : 6,21 → 7,66 M€ de 2022 à 2025, mais la croissance tombe de +11,6 % à **+2,1 %**, et le résultat net de 454 k€ à **117 k€** — la marge nette passe de 7,3 % à **1,5 %**. L'EBITDA reste stable à 870 k€ : c'est l'amortissement qui absorbe la performance, ce qui plaide pour un cycle d'investissement. Particularité de ce dossier, **34,9 % du chiffre d'affaires à l'export** : la part la plus élevée du lot, et un acteur qui ne dépend pas du seul mandat français.

**SYMTRAX SA** (Nîmes) croît régulièrement — 3,42 → 4,19 M€ — mais son EBITDA s'écrase de 108 k€ à **15,8 k€**, soit 0,4 % du chiffre d'affaires, pour un résultat net de **9,7 k€**. Deux causes lisibles : les salaires passent de 72,2 % à 74,9 % du chiffre d'affaires, et le délai de paiement clients s'allonge de 64,9 à 99,1 jours. Deux faits à documenter : **l'export tombe à zéro en 2025** alors qu'il pesait 1,51 M€ en 2023, et la **gouvernance a été entièrement renouvelée en juin 2026** — trois départs du conseil le 11/06, une nouvelle directrice générale le 18/06 — à quelques mois de l'échéance.

## Une régularité de structure → règle 35

Sur les onze sociétés des lots 1A et 1B, **six ont pour président une personne morale** : CEGID GROUP pour CEGID, CDML pour YOOZ, GSPI pour TENOR, deux holdings de fondateurs pour FLOWIE, YOOZ pour YOOZ PDP, POINT79 MANAGEMENT LIMITED à la présidence du conseil de SPENDESK.

Le champ `dirigeants` seul est donc trompeur dans cette cohorte. Il faut systématiquement remonter d'un cran — et c'est précisément en remontant d'un cran qu'on a trouvé la liaison Itesoft-Yooz.

## Non trouvé

- Chaîne capitalistique de CDML vers ITESOFT — la pièce qui transformerait `controle_personnel_commun` en groupe établi.
- Actionnariat d'AGICAP, de SPENDESK et de TENOR ; périmètre de la holding **GSPI** (SIREN 518807532).
- Explication de la disparition de l'export chez SYMTRAX.
- Comptes d'AGICAP postérieurs à 2019 et de SPENDESK postérieurs à 2020 : inexistants.
- Comptes de CDML postérieurs à 2016.

## État du chantier H1

Onze plateformes traitées sur les deux lots. **54 plateformes à SIREN** restent sans bloc économique, dont **20** sur cible ETI ou grands comptes.

Lot 1C envisagé : ARTEVA, DARVA, TX2 CONCEPT, SEPTEO, PENNYLANE, et les holdings identifiées mais non traitées — **GSPI**, **CEGID GROUP**, **UP TO TECH**.
