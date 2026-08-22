# Plan de travail — Référentiel des plateformes agréées

**Emplacement dans le dépôt :** `Info IA/plateformes-agreees/`
**Dernière mise à jour :** 21/08/2026 (soir — Tradeshift, conversion du pilote Generix, révision du barème)
**Fichier cible unique :** `data/plateformes-agreees.json`
**Définition des champs :** `data/pa-taxonomie.json`
**Finalité du référentiel :** analyse 360 des entreprises porteuses des plateformes agréées — voir `cartographie-360-modele.md`

---

## Règle d'or de la parallélisation

Aucune conversation parallèle n'écrit jamais dans `data/plateformes-agreees.json`.
Chaque conversation produit **un fichier de patch** dans `Info IA/plateformes-agreees/patches/`.
La fusion est faite en une seule fois, par `merge-plateformes.html`, dans le navigateur.

Cela garantit qu'aucun travail parallèle n'écrase celui d'un autre.

```
conversation A ──> patches/patch-A.json ──┐
conversation B ──> patches/patch-B.json ──┼──> merge-plateformes.html ──> data/plateformes-agreees.json
conversation E3 ─> patches/patch-E3.json ─┘
```

---

## État au 19/08/2026

| | Valeur |
|---|---|
| Entrées au référentiel | **163** (147 immatriculées + 16 candidates) |
| Plateformes qualifiées marché | **28** (17 %) |
| Fiches complètes à 100 % | **0** |
| Identité juridique fiable | 53 |
| Identité à vérifier | 22 |
| Sans identité | 88 (dont ~44 entités étrangères — chiffre à recompter, cf. chantier F) |

Le code est terminé et en production. **Tout ce qui reste est de la donnée.**

---

## Les 6 chantiers, dans l'ordre de rentabilité

| # | Chantier | Périmètre | Nature | Brief | Statut |
|---|---|---|---|---|---|
| **A** | `siteWeb` + `contact` depuis le XLSX officiel DGFiP | 147 | automatique, 1 passe | `BRIEF-A-sites-et-contacts.md` | à lancer |
| **B** | SIREN manquants et douteux | 51 | semi-automatique | `BRIEF-B-identites-siren.md` | à lancer |
| **C** | `dirigeants` sur les SIREN connus | 75+ | automatique | `BRIEF-C-dirigeants.md` | à lancer |
| **D** | `reseaux` / points d'accès Peppol | 163 | automatique | `BRIEF-D-peppol.md` | à lancer |
| **E** | Qualification marché | 135, en 15 lots | manuel assisté | `BRIEF-E-qualification-marche.md` | à lancer |
| **F** | Identité des entités étrangères | ~44, en 6 lots | manuel assisté | `BRIEF-F-entites-etrangeres.md` | à lancer, **déclassé** |
| **G** | **Analyse 360 des entreprises** | 163, une société par patch | manuel assisté | `BRIEF-G-analyse-360.md` | **chantier principal** |

**A, B, C et D sont indépendants entre eux et peuvent tourner simultanément.**
**A est le prérequis absolu de G** : sans URL, aucune analyse d'entreprise n'est possible.
**B change de nature** : le SIREN n'est plus de l'état civil, c'est la clé d'accès aux comptes déposés, donc au poids économique.
**E fusionne de fait avec G** : les 12 axes de qualification marché sont un sous-ensemble du bloc `activites` + `centralitePA`, et se traitent dans la même passe, société par société.
**F est le pendant international de B**, et devient secondaire : le 360 s'applique aux étrangères comme aux françaises, et apporte bien plus qu'un numéro de registre.

---

## Décisions actées

1. **`contact` est collecté mais jamais affiché.** Les adresses figurent dans le JSON pour usage interne ; ni `pa-detail.js` ni `pa-hub.js` ne les rendent. Motif : ne pas exposer 147 adresses professionnelles à l'aspiration automatisée.
2. **Niveau de détail dégradé assumé** pour les entités étrangères et les candidates : pas d'identité juridique française. La page l'affiche explicitement plutôt que de laisser croire à un oubli.
   → **Précisé le 21/08/2026** : « dégradé » ne veut pas dire « vide ». Le chantier F substitue une ancre internationale (TVA/VIES, EUID, LEI, registre national) au SIREN, et la qualification marché du chantier E s'applique **à l'identique** aux entités étrangères. Voir `cartographie-entites-etrangeres.md`.
3. **Aucun champ n'est jamais rempli au jugé.** Tout champ non sourcé reste à `null` avec `confiance: "non_qualifie"`. Une absence de donnée est une donnée.
4. **Tout chiffre publié porte sa date de relevé.** `_meta.dateReleve` fait foi.
5. **Le matricule de plateforme agréée (ICD 0238, 4 caractères)** est l'identifiant pivot d'une PA dans l'annuaire, mais il **n'est pas public**. Le référentiel ne le portera pas tant que la DGFiP ne le publie pas.
6. **Réorientation du 21/08/2026 (soir), décidée par Bruno : le référentiel devient une analyse 360 d'entreprises**, et non un état civil de personnes morales. Question structurante : l'activité de plateforme agréée est-elle le cœur du métier, un axe stratégique, une extension naturelle, une activité annexe ou une conformité défensive ? Réponse par un **indice de centralité** sourcé, jamais par une part de CA inventée.
7. **Publication intégrale assumée**, décidée par Bruno le 21/08/2026 : l'analyse concurrentielle est publiée sur rfe.fluxym.com, y compris réputation, dynamique et lecture stratégique. Contrepartie non négociable : les 9 règles de publication du § 6 de `cartographie-360-modele.md` (source et date sur tout, séparation fait / lecture, aucun jugement ni classement, agrégats d'avis seulement, aucune donnée personnelle, pas de turnover, droit de réponse ouvert, déclaration du statut d'acteur de marché de Fluxym, même barème pour tous).
8. **La ventilation du CA par activité n'est jamais estimée.** Elle n'est publique que pour les sociétés cotées. `ventilationParActivite.disponible: false` est une réponse valide et attendue.
9. **CA groupe et CA de l'entité française sont deux champs distincts.** Les confondre est la faute la plus fréquente du marché (cas Generix : 110 M€ groupe contre 60,4 M€ pour l'entité).
10. **Le référentiel n'est pas indexable.** Toute nouvelle page porte `<meta name="robots" content="noindex, nofollow">`, conformément à la consigne applicable à l'ensemble du site.
11. **Barème de centralité — cinq règles actées le 21/08/2026** après étalonnage sur Esker et Basware (détail et démonstration dans `ETALONNAGE-360-ESKER-BASWARE.md`) :
    a. l'indice mesure la place de l'activité **agréée française**, non la proximité du métier avec la facturation électronique ; l'indice 4 est réservé aux sociétés qui n'auraient plus d'objet sans elle ;
    b. la distribution du socle agréé à des tiers est un indice fort de centralité, jamais un critère suffisant à lui seul ;
    c. trois ancrages de poids économique sont distingués et jamais mélangés : chiffre déclaré sur le site, chiffre issu d'un communiqué financier daté, comptes déposés de l'entité ; `caGroupe.nature` dit lequel est retenu ;
    d. **distinguer les republicateurs de comptes déposés des agrégateurs qui estiment**, précisé le 21/08/2026 : les données du greffe, du registre national des entreprises et de l'INSEE **sont une source primaire**, elles republient un document légalement déposé, et `caEntiteFrancaise.nature` vaut alors `comptes_deposes` ; les agrégateurs qui **modélisent** un chiffre d'affaires ne sont pas une source — constat établi sur Generix (243,7 M$ affichés contre 60,4 M€ déposés) puis sur Basware (185 à 365 M$ selon l'agrégateur). Critère de tri : le chiffre est-il déposé ou estimé ? ;
    e. une ventilation par **modèle de revenus** (part du SaaS) n'est pas une ventilation par **activité** : elle va dans le motif de non-disponibilité, jamais en réponse à la question posée ;
    f. **périmètre de lecture**, ajoutée le 21/08/2026 sur le cas GEP : quand l'entité immatriculée est une filiale spécialisée d'un groupe diversifié, les deux lectures peuvent s'opposer de 3 points sur 4 (métier de l'entité contre poids dans le groupe). L'indice se lit alors sur l'**investissement observable sur le mandat français** — pages consacrées au dispositif, entité et équipes locales, date d'immatriculation, agrément construit ou hérité — et les deux lectures sont exposées dans le champ `lecture`, pour que le lecteur voie le raisonnement au lieu de subir un chiffre.
12. **Pour une entité étrangère, la question n'est pas « a-t-elle un SIREN ? » mais « existe-t-il une entité française rattachée ? »**, décidé le 21/08/2026 sur le cas Basware. Le SIREN de la filiale va dans `identiteInternationale.presenceEnFrance.siren` et **jamais** dans le champ `siren` de la fiche, qui reste celui de l'entité immatriculée. `presenceEnFrance` devient l'un des premiers champs à renseigner du chantier F.
13. **La centralité et la posture commerciale sont deux axes distincts**, acté le 21/08/2026 au terme de la révision. L'indice de centralité répondait à deux questions à la fois — quelle place l'activité occupe, et comment elle est vendue — d'où sa compression sur deux valeurs. La distribution est sortie de l'indice et porte désormais la facette `postureCommerciale` (`grossiste`, `canal_indirect`, `conquete_directe`, `base_installee`, `non_qualifie`). Les signaux de distribution présents dans les faisceaux existants restent affichés comme preuves mais **ne comptent plus comme critères de centralité**. Aucun indice n'a été déplacé par la révision.
14. **Toute analyse produite se termine par un patch, sinon elle n'existe pas.** Acté le 21/08/2026 après avoir découvert que le pilote Generix, documenté le matin, n'avait jamais été converti en patch : la fiche du site était restée vide alors que le travail était fait. Un document dans `Info IA/` ne publie rien.
15. **Une passe de révision du barème sera faite à dix fiches**, décidé le 21/08/2026 et devenu prioritaire le même soir : après neuf fiches, six sont à l'indice 3. Piste à instruire : le niveau 3 agrège deux situations différentes — l'acteur dont la facture est le métier (Itesoft, Seres) et celui qui a bâti un canal propre autour de l'agrément (Paragon, Esker) ; ces deux profils ne se combattent pas de la même manière. Après sept fiches, les indices se concentrent sur deux valeurs (3 : Esker, Basware, Paragon, Seres ; 2 : Generix, GEP, Tessi) et une tension interne est identifiée : Generix présente une marque dédiée et un socle revendu, deux critères qui ont contribué à justifier un 3 ailleurs. Aucune retouche au coup par coup : relecture comparée des faisceaux d'indices en une seule passe. Rétablir la cohérence sur sept fiches coûte une heure, sur quarante c'est un autre chantier.
16. **Le poids économique des 79 plateformes disposant d'un SIREN est à renseigner en priorité** depuis les comptes déposés : trois à quatre exercices, résultat net, fonds propres et effectif, en quelques minutes par société. Meilleur rapport valeur/effort identifié sur le référentiel — et seule source donnant une **trajectoire**, donnée bien plus discriminante qu'un chiffre d'affaires isolé.
17. **Le champ `pays` renseigne la nationalité de l'entité immatriculée, jamais celle du groupe**, acté le 21/08/2026 sur le cas Medius. Trois groupes étrangers documentés, trois choix différents d'entité immatriculée : Basware a gardé l'agrément au siège finlandais malgré une filiale française de 2004, GEP l'a hérité d'une filiale finlandaise acquise, Medius l'a confié à sa filiale française. Il n'existe aucune règle générale, et une fiche `pays: France` peut masquer un groupe étranger de 500 personnes détenu par des fonds.
18. **Première étape du chantier F : confronter l'adresse publiée par la DGFiP au siège annoncé par le nom commercial**, décidé le 21/08/2026 sur le cas GEP. Quand les deux divergent, l'adresse a raison. Contrôle éprouvé sur deux cas le jour même : anomalie réelle confirmée sur GEP, soupçon infondé levé sur MEDIUS. Ce contrôle de trois minutes évite de chercher le SIREN d'une société qui n'en a pas, et détecte le motif « agrément hérité par acquisition d'une filiale spécialisée ». Candidats prioritaires : MEDIUS (`pays` = France, groupe suédois à Linköping) et les 16 entités sans pays renseigné.
19. **Le relevé des offres d'emploi se fait en une passe unique à date fixe** sur toute la cohorte ETI et grands comptes, et non société par société : un volume d'offres n'a de sens que comparé à une même date.
20. **Rien ne sera publié sur les conditions réglementaires applicables aux PA étrangères** (établissement stable, représentant, hébergement) avant lecture des textes primaires : art. 290 B CGI, art. 242 nonies B ann. II, décret n° 2024-266.
21. **Un groupe peut porter plusieurs immatriculations**, acté le 22/08/2026 sur la découverte AGENA3000 / DOCPROCESS : le groupe de Cholet a racheté DocProcess le 17/09/2025 et porte deux plateformes agréées immatriculées à quatre jours d'intervalle, l'une vendue en gros à des éditeurs tiers. Le référentiel contient au moins quatre cas du même type (AGENA3000, Tessi, EDICOM, Visma). Trois conséquences : **le nombre d'entrées n'est pas le nombre d'acteurs** ; le risque de rationalisation d'un des deux agréments doit être exposé comme risque et jamais comme pronostic ; un même socle peut apparaître sous plusieurs noms dans une même consultation. Deux sociétés du même groupe sont désormais traitées dans la même passe 360.
22. **Une variante du motif d'acquisition est distinguée depuis le 22/08/2026, sur le cas Tungsten** : lorsque ce n'est pas l'agrément mais **l'activité elle-même** qui a été achetée — ici le réseau ex-OB10 racheté à Tungsten Corporation en juin 2022 pour 53,7 M£, l'agrément restant porté par la filiale commerciale française créée en 1997 — la question utile devient « les équipes qui faisaient tourner le réseau sont-elles encore là ? ». Corollaire pour le chantier SIREN : une société renommée à la suite d'un changement de marque de groupe (Kofax France devenue Tungsten Automation France en janvier 2024) est introuvable par son nom commercial.
23. **Tout nouveau bloc de données est vérifié contre le format lu par le moteur d'affichage**, et pas seulement contre le modèle documentaire, acté le 22/08/2026 : les blocs de chiffre d'affaires des patches Tungsten et DocProcess étaient exprimés en euros sous la clé `valeur` alors que `js/pa-detail.js` lit un montant en millions sous la clé `montantMEUR`. **Une donnée exacte au mauvais format est une donnée absente.** Le moteur a été rendu tolérant aux deux unités, mais le contrôle reste à la charge du producteur du patch.
24. **Un rapprochement automatique sur un nom commercial ne produit pas seulement des trous, il produit aussi des faux**, acté le 22/08/2026 sur BCSolutions, dont la fiche portait un dirigeant appartenant à une société homonyme. Les faux sont plus dangereux que les trous : un contrôle est à programmer sur toutes les fiches enrichies par interface automatique dont le SIREN est resté vide alors que d'autres champs d'identité sont renseignés.
25. **Une ventilation par activité n'est retenue que si l'acteur la publie lui-même**, premier cas obtenu le 22/08/2026 avec Cegedim, société cotée publiant son chiffre d'affaires par division et par segment. Le rapport de deux chiffres publiés (62,9 M€ sur 649,2 M€) est autorisé et n'est pas une estimation ; la part de l'activité agréée à l'intérieur du segment publié reste, elle, non estimée.
26. **Un groupe peut viser les deux extrémités du marché avec deux agréments distincts**, acté le 22/08/2026 sur Visma : Chaintrust attaque par les cabinets d'expertise comptable et les très petites entreprises, MySupply par les acheteurs publics nordiques et leurs filiales françaises. La lecture concurrentielle doit donc se faire **par groupe** et pas seulement par entrée du référentiel : la question utile devient « par quelle porte ce groupe entre-t-il chez mon client ? ».
27. **L'indice 1 est attribué quand l'agrément sert à protéger un produit, non à vendre une plateforme**, premier cas le 22/08/2026 avec Lucca. Trois preuves ont suffi et font désormais critère : aucune page dédiée à l'offre agréée, périmètre annoncé limité à la réception et à l'e-reporting, et éditeur qui invite lui-même ses clients à combiner plusieurs plateformes selon les flux. Corollaire commercial : ces plateformes **cohabitent** avec une offre concurrente au lieu de s'y opposer.
28. **Le rattachement capitalistique et le poids économique se relèvent dans la même passe**, acté le 22/08/2026 à l'issue du recensement des groupes : les deux informations se trouvent au même endroit — fiche registre et mentions légales — et 123 entrées sur 163 n'ont aucun rattachement exploitable (champ vide ou « non déterminable »). Traiter les deux séparément revient à payer deux fois le coût d'accès.
29. **Une liaison entre immatriculations n'est publiée que si le lien capitalistique est établi sur pièces**, acté le 22/08/2026 : un partenariat technique, une participation minoritaire ou une filiation de dirigeants ne fait pas un groupe. Trois cas ont été écartés à ce titre — Tessi et Le Village Connecté (partenariat technique), SEQINO et TRESO2 (partenaire bancaire non prouvé actionnaire), WiseTech Global et Groupe Sigma (homonymie).
30. **Une entité immatriculée peut n'être qu'une coquille juridique créée pour porter l'agrément**, acté le 22/08/2026 avec YOOZ PDP : SASU au capital de 10 000 €, créée en mars 2023, sans aucun compte déposé, présidée par la société opérationnelle. Dans ce cas le poids économique se lit sur la société mère, jamais sur l'entité agréée, et l'indice de centralité ne peut pas être établi sur l'entité seule. Corollaire de lecture commerciale : la taille de l'entité agréée ne dit rien de la force de frappe de l'acteur.
31. **L'absence de chiffre d'affaires peut être un fait, et non une lacune de collecte**, acté le 22/08/2026 avec FLOWIE : des comptes déposés sous déclaration de confidentialité (art. L. 232-25 du code de commerce) rendent toute donnée financière légalement inaccessible. Ce cas se publie comme tel, avec la nature `comptes_confidentiels`, et il est distinct de `aucun_compte_depose` (aucun dépôt) et de `non_publie` (non relevé). Une opacité licite se constate, elle ne se reproche pas.
32. **Certaines sociétés déposent des comptes dont le chiffre d'affaires n'est pas restitué**, acté le 22/08/2026 avec SERENSIA : seuls le résultat net et les postes de bilan sont exploitables. Publier le résultat net seul est licite ; en déduire un chiffre d'affaires, même par ordre de grandeur, est interdit.
33. **Un dirigeant commun et un siège partagé ne valent pas chaîne capitalistique — mais ils ne doivent pas être perdus**, acté le 22/08/2026 avec ITESOFT et YOOZ PDP : mêmes locaux au Séquoia, Parc d'Andron, 30470 Aimargues, et Didier Charpentier président du conseil d'ITESOFT et de la holding CDML qui contrôle YOOZ, sans que la chaîne CDML vers ITESOFT soit publiée. La règle 29 interdisait de publier une liaison de groupe ; la perdre aurait été pire. D'où un type de liaison distinct, `controle_personnel_commun`, qui expose les faits établis sans affirmer un groupe.
34. **Des comptes anciens ne sont pas des comptes courants**, acté le 22/08/2026 avec AGICAP (aucun dépôt exploitable depuis l'exercice 2019) et SPENDESK (depuis 2020). Un chiffre issu du dernier dépôt se publie avec son exercice **et** le nombre d'exercices manquants. Corollaire : tout chiffre récent circulant sur ces sociétés est une estimation d'agrégateur, jamais un compte (règle 11d).
35. **Dans cette cohorte, le président est très souvent une personne morale**, et le champ `dirigeants` seul est alors trompeur : CEGID GROUP pour CEGID, CDML pour YOOZ, GSPI pour TENOR, UP TO TECH et LEGORREC CONSULTING pour FLOWIE, YOOZ pour YOOZ PDP, POINT79 MANAGEMENT LIMITED à la présidence du conseil de SPENDESK. Il faut systématiquement remonter d'un cran : c'est là que se trouve le rattachement, et parfois la liaison entre deux immatriculations.

---

## Suivi des lots de qualification marché

Voir `LOTS-E.md` pour le découpage nominatif des 15 lots.

| Lot | Type | Statut | Patch |
|---|---|---|---|
| Lots 1 à 3 (déjà faits, hors E) | — | ✅ terminé | fusionné |
| E1 à E9 | FR | à traiter | — |
| E10 à E13 | étrangères | à traiter | — |
| E14 à E15 | candidates | à traiter | — |

## Suivi des lots d'identité internationale

Découpage nominatif dans `BRIEF-F-entites-etrangeres.md`.

| Lot | Périmètre | Statut | Patch |
|---|---|---|---|
| F1 à F4 | étrangères non cartographiées (miroir de E10-E13) | à traiter | — |
| F5 | étrangères déjà cartographiées mais sans identité | à traiter | — |
| F6 | candidates étrangères (liste à établir sur pièces) | à traiter | — |

## Suivi du chantier 360

Un patch par société : `patches/patch-G-<NOM>.json`.

| Vague | Périmètre | Statut |
|---|---|---|
| Pilote | GENERIX Group — `pilote-360-GENERIX.md` | ✅ méthode éprouvée, non fusionné |
| Étalonnage | ESKER et BASWARE — `ETALONNAGE-360-ESKER-BASWARE.md` | ✅ barème calibré, 5 règles ajoutées, patches `patch-G-ESKER.json` et `patch-G-BASWARE.json` non fusionnés |
| Étalonnage | GEP — `ANOMALIE-GEP-OPUSCAPITA.md` | ✅ anomalie résolue (entité = GEP Finland Oy, ex-OpusCapita, Espoo), règle de périmètre ajoutée, patch `patch-G-GEP.json` non fusionné |
| G1a | PARAGON, SERES, TESSI — `NOTE-CERCLE-0-VAGUE-1.md` | ✅ 3 patches non fusionnés ; comptes déposés exploités, barème sous surveillance |
| G1b | ITESOFT et MEDIUS — `NOTE-CERCLE-0-VAGUE-2.md` | ✅ 2 patches non fusionnés ; anomalie MEDIUS levée, retrait de cote d'ITESOFT documenté |
| G1c | TRADESHIFT BABELWAY — 10e fiche | ✅ patch `patch-G-TRADESHIFT.json` non fusionné |
| Rattrapage | GENERIX Group — conversion du pilote en patch | ✅ `patch-G-GENERIX.json` ; le pilote n'avait jamais été publié sur le site |
| **Révision** | relecture comparée des 10 faisceaux — `REVISION-BAREME-10-FICHES.md` | ✅ facette `postureCommerciale` créée, aucun indice déplacé |
| G1d | TUNGSTEN AUTOMATION FRANCE et DOCPROCESS — `NOTE-CERCLE-0-VAGUE-3.md` | ✅ 2 patches non fusionnés (`patch-G-TUNGSTEN.json`, `patch-G-DOCPROCESS.json`) + `patch-CORRECTIONS-20260822.json` ; holding « non transparente » de DOCPROCESS résolue (rachat par AGENA3000 le 17/09/2025), règles 21 et 22 ajoutées |
| G1e | VENTYA, BCSolutions et CEGEDIM — `NOTE-CERCLE-0-VAGUE-4.md` | ✅ 3 patches non fusionnés ; SIREN de BCSolutions trouvé (445023427) et dirigeant erroné corrigé ; première ventilation par activité publiée (Cegedim) ; règles 23 à 25 ajoutées |
| G1f | DIGITAL TECHNOLOGIES, MySupply Aps, CHAINTRUST by Visma et LUCCA — `NOTE-CERCLE-0-VAGUE-5.md` | ✅ 4 patches non fusionnés ; **cercle 0 clos, 20 fiches 360** ; premier indice 1 (Lucca) ; Visma identifié comme troisième groupe à double immatriculation ; règles 26 et 27 ajoutées |
| H2 | recensement des groupes portant plusieurs immatriculations — `RECENSEMENT-GROUPES.md` | ✅ première passe : **6 groupes établis**, champ `immatriculationsLiees` créé (facette filtrable + affichage fiche), **cas Tessi infirmé**, 3 faux positifs écartés ; clôture conditionnée au rattachement des 123 entrées sans lien exploitable |
| H1 | poids économique **et** rattachement capitalistique des plateformes à SIREN, par lots de dix (règles 16 et 28) | 🚧 **lancé le 22/08/2026** — lot 1A livré : CEGID, SAGE, DOXALLIA, SERENSIA by Quadient, FLOWIE, YOOZ PDP. 65 plateformes à SIREN restent sans fiche 360, dont 30 ciblant l'ETI ou les grands comptes |
| H3 | 37 plateformes adjacentes ETI et grands comptes, fiches 360 allégées mais sourcées | à lancer ensuite |
| Transversal | recensement des groupes portant plusieurs immatriculations, sur les 163 entrées (règle 21) | à lancer |
| G2 | reprise 360 des sociétés déjà qualifiées du cercle 1 (Pagero, Sovos, Comarch, Opentext, Generix, Cegid, Sage) | à lancer |
| G3 | pure-players et entités créées pour la réforme | à lancer |
| G4 | cercle 3 — fiches allégées mais sourcées, ~90 sociétés | permanent |

**Charge estimée :** 30 à 45 min par société des cercles 0 à 2, 12 à 15 min pour une fiche allégée du cercle 3. Ce chantier ne se termine pas, il s'entretient.

**Périmètre commercial Fluxym :** BASWARE, ESKER, GEP et IVALUA sont distribuées par Fluxym. Elles sont traitées avec le même barème que toutes les autres, sans angle promotionnel, et aucune information issue d'une mission ou d'un dossier d'avant-vente ne remonte dans le référentiel. Sources publiques exclusivement.

## Prérequis technique du chantier F

`merge-plateformes.html` doit fusionner les blocs `identiteInternationale` **et** `analyse360` **clé par clé**, comme il le fait déjà pour `socleTechnique`. À faire **avant** le dépôt du premier patch F ou G.
→ **Fait** (version 3 du fichier, 21/08/2026) : fusion profonde générique pilotée par `blocsStructures.fusionProfonde` de `data/pa-taxonomie.json`, et `sourcesEnrichissement` cumulatif avec dédoublonnage. Fusion des deux patches d'étalonnage simulée à blanc le 21/08/2026 : deux écrasements, tous deux intentionnels (`ESKER.trancheEffectif`, `ESKER.descriptionFiche`), 11 sources ajoutées à Esker sur 8 conservées, 9 ajoutées à Basware sur 7 conservées.

## Prérequis d'affichage du chantier G

- fiche plateforme = fiche entreprise, dont la plateforme agréée est un chapitre ;
- nouveau filtre de premier plan : **centralité** (« cœur de métier » → « conformité défensive ») ;
- nouveau filtre : secteur des références clients ;
- **page méthodologie publique obligatoire** reprenant les 9 règles de publication : c'est elle qui rend le reste défendable.
