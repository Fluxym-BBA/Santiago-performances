-- ============================================================================
-- COCKPIT BDR — v20 : une échelle de lecture par compteur
--
-- POURQUOI
--
-- Le bandeau du haut fixe l'échelle des jauges pour toute la page : jour,
-- semaine, mois, et l'exercice depuis la v17. C'est un réglage utile mais
-- grossier. Les appels se pilotent à la semaine, les rendez-vous pris au mois,
-- et le chiffre d'affaires n'a de sens qu'à l'exercice. Un réglage unique
-- oblige à choisir la moins mauvaise échelle pour treize compteurs qui n'ont
-- pas le même rythme.
--
-- Le bandeau reste donc le DÉFAUT de la page, et chaque compteur peut s'en
-- écarter. Changer le bandeau remet tout le monde d'équerre : c'est aussi le
-- moyen le plus simple d'effacer d'un coup des réglages devenus illisibles.
--
-- POURQUOI UNE COLONNE ET NON UNE TABLE
--
-- La visibilité des objectifs (v16) a sa table, parce qu'elle se force par
-- métier et par personne depuis l'écran d'administration. L'échelle de lecture,
-- elle, n'est le choix de personne d'autre que celui qui regarde : c'est une
-- habitude de lecture, pas une consigne. Une colonne à côté de gauge_scale,
-- qui joue déjà ce rôle pour la page entière, coûte une ligne de migration là
-- où une table aurait coûté quatre index, trois politiques et deux fonctions.
--
-- La limite est assumée et elle est facile à lever : si un jour il faut pouvoir
-- imposer « le chiffre d'affaires se regarde à l'exercice » à toute l'équipe,
-- il faudra une table sur le modèle de target_visibility. Ce jour-là, la
-- colonne se lira comme l'exception personnelle et rien ne sera perdu.
--
-- POURQUOI AUCUNE CONTRAINTE SUR LES VALEURS
--
-- On pourrait vérifier ici que chaque valeur vaut « day », « week », « month »
-- ou « year ». Un CHECK ne peut pas contenir de sous-requête, il faudrait donc
-- une fonction, et surtout une écriture refusée par la base se traduirait à
-- l'écran par une erreur incompréhensible sur un simple clic de confort.
-- Le client valide avant d'écrire ET ignore à la lecture toute valeur qu'il ne
-- connaît pas : une échelle supprimée dans une version future retombe alors
-- silencieusement sur le défaut de la page, ce qui est exactement le bon
-- comportement.
--
-- ORDRE DE DÉPLOIEMENT. Cette migration passe AVANT le code, mais l'ancien
-- code s'accommode parfaitement de la colonne : il l'ignore. Un select('*')
-- la ramènera sans s'en servir.
-- ============================================================================

begin;

alter table public.profiles
    add column if not exists metric_scales jsonb not null default '{}'::jsonb;

alter table public.profiles
    drop constraint if exists profiles_metric_scales_chk;

-- Le strict minimum : que ce soit un objet. Un tableau ou un nombre ferait
-- planter la lecture côté client, une clé inconnue non.
alter table public.profiles
    add constraint profiles_metric_scales_chk
    check (jsonb_typeof(metric_scales) = 'object');

-- ----------------------------------------------------------------------------
-- LE DROIT D'ÉCRITURE, COLONNE PAR COLONNE
--
-- profiles n'accorde pas UPDATE à authenticated sur la table entière, mais
-- colonne par colonne : display_name et gauge_scale, et rien d'autre. C'est ce
-- qui empêche quelqu'un de se promouvoir propriétaire d'une simple requête
-- PostgREST, la politique RLS ne regardant que la LIGNE et pas les colonnes
-- touchées.
--
-- Une colonne ajoutée n'hérite donc d'aucun droit d'écriture. Sans la ligne
-- ci-dessous, chaque clic sur une lettre d'échelle partirait vers un
-- « permission denied for table profiles » que le code range dans un
-- console.warn : le réglage aurait l'air de fonctionner jusqu'au rechargement
-- de la page, où il serait revenu en arrière.
-- ----------------------------------------------------------------------------
grant update (metric_scales) on public.profiles to authenticated;

comment on column public.profiles.metric_scales is
    'Exceptions d''échelle de lecture, par compteur : { "calls_made": "week" }. '
    'Vide par défaut, chaque compteur suivant alors gauge_scale. Écrit par son '
    'seul titulaire : la politique RLS de profiles n''autorise l''update que sur '
    'sa propre ligne, y compris pour le propriétaire.';

commit;
