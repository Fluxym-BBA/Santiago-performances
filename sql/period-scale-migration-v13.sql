-- ============================================================================
-- COCKPIT BDR — MIGRATION v13
-- « Lire ses objectifs à l'échelle qu'on suit », et « appliquer un objectif de
-- métier à ceux qui existent déjà ».
--
-- CONTEXTE
--
-- La v12 a introduit activity_targets : des objectifs par métier et par échelle
-- (jour, semaine, mois), avec des exceptions personnelles. Deux manques sont
-- apparus dès la mise en service, le 27/08/2026.
--
-- 1. LA LECTURE RESTAIT JOURNALIÈRE. Les objectifs mensuels étaient stockés mais
--    aucun écran ne les montrait : Dominique, qui suit un nombre de rendez-vous
--    dans le mois, voyait toujours une jauge du jour. L'écran de saisie doit
--    laisser choisir l'échelle de ses jauges, et se souvenir du choix d'une
--    session à l'autre. D'où profiles.gauge_scale.
--
-- 2. L'OBJECTIF DE MÉTIER NE S'APPLIQUAIT PAS À TOUT LE MONDE. Il s'applique
--    bien, mais seulement à qui n'a pas d'exception personnelle. Or la migration
--    v12 a converti les anciens réglages individuels en exceptions : Christophe,
--    Damien et les trois comptes de démonstration en ont une sur l'échelle du
--    jour. Changer le défaut du métier ne les touchait donc pas, ce qui donnait
--    l'impression, fausse mais compréhensible, que le défaut ne servait qu'aux
--    futurs arrivants. D'où apply_job_targets().
--
-- CE QUE apply_job_targets NE FAIT PAS
--
-- Elle ne recopie pas la valeur du métier dans chaque fiche personnelle. Ce
-- serait rétroactif une fois, puis figé : le prochain changement du défaut ne
-- toucherait plus personne, et on aurait reconstruit exactement le problème
-- qu'on répare. Elle EFFACE les exceptions, ce qui rend les gens à nouveau
-- sensibles au défaut, maintenant et à chaque changement futur.
--
-- ORDRE DE DÉPLOIEMENT : cette migration passe AVANT le code. Le code sait vivre
-- sans elle — l'échelle retombe sur le défaut, les préférences ne sont pas
-- retenues d'une session à l'autre et le bouton d'application se masque — mais il
-- n'y a aucune raison de s'en priver.
--
-- NOTE DU 27/08, APRÈS PASSAGE. Le défaut de lecture a été porté du jour au mois
-- dans js/api.js (scaleOf) : c'est l'échelle à laquelle les objectifs sont
-- réellement discutés ici. Rien à rejouer dans ce script, aucun DDL n'a changé ;
-- seuls deux commentaires ci-dessous ont été mis à jour pour ne pas mentir.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. L'ÉCHELLE DE LECTURE, MÉMORISÉE PAR PERSONNE
--
-- Une colonne sur profiles plutôt qu'une table de préférences : il y a une seule
-- préférence, elle est lue à chaque ouverture de l'application en même temps que
-- le profil, et une table séparée coûterait une requête de plus à chaque page
-- pour stocker un mot de cinq lettres.
--
-- Nullable à dessein, et sans DEFAULT. NULL veut dire « personne n'a choisi », et
-- le code applique alors son défaut — le mois depuis le 27/08. Écrire ce défaut
-- dans la colonne aurait affirmé un choix que personne n'a fait, empêché de
-- distinguer « n'a jamais touché au sélecteur » de « a explicitement demandé le
-- mois », et surtout figé le défaut en base : le changer aurait alors demandé une
-- migration de données au lieu d'une ligne de code.
-- ----------------------------------------------------------------------------

alter table public.profiles
    add column if not exists gauge_scale text;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.profiles'::regclass
          and conname = 'profiles_gauge_scale_chk'
    ) then
        alter table public.profiles
            add constraint profiles_gauge_scale_chk
            check (gauge_scale is null or gauge_scale in ('day', 'week', 'month'));
    end if;
end $$;

comment on column public.profiles.gauge_scale is
    'Échelle des jauges de la page de saisie pour cette personne : day, week, '
    'month, ou NULL quand elle n''a jamais choisi. Ne change RIEN à la saisie, '
    'qui reste quotidienne : seule la lecture des objectifs est concernée.';

-- Le privilège d'écriture est accordé COLONNE PAR COLONNE, et c'est ce qui tient
-- la sécurité ici. La policy profiles_update_own_name autorise un membre à
-- modifier sa propre ligne sans restreindre les colonnes — une policy RLS ne
-- sait pas le faire. C'est le GRANT qui limite, et il ne portait jusqu'ici que
-- sur display_name. Sans la ligne qui suit, personne ne pourrait enregistrer sa
-- préférence ; avec un GRANT sur la table entière, n'importe qui se serait
-- promu is_admin depuis la console du navigateur.
grant update (gauge_scale) on public.profiles to authenticated;

-- ----------------------------------------------------------------------------
-- 2. APPLIQUER L'OBJECTIF D'UN MÉTIER À CEUX QUI EXISTENT DÉJÀ
--
-- SECURITY INVOKER, comme les deux fonctions de la v12 : la fonction ne doit
-- rien pouvoir faire que l'appelant ne puisse faire lui-même.
--
-- Le garde explicite en tête n'est pas une redondance avec la policy. Un DELETE
-- refusé par RLS ne lève aucune erreur : il supprime zéro ligne. Sans ce garde,
-- un membre aurait vu « 0 exception effacée » et cru que l'écran était à jour,
-- alors que la base l'avait ignoré en silence.
--
-- La définition du métier reproduit celle du code (targetJobOf, js/api.js) :
-- commercial l'emporte sur BDR quand quelqu'un porte les deux casquettes, car
-- c'est le cycle de vente qui décide alors de ce qu'on attend de lui. Christophe
-- est dans ce cas. Les deux définitions doivent rester identiques, sinon le
-- décompte annoncé à l'écran et les lignes réellement effacées divergent.
--
-- Toutes les métriques de l'échelle sont effacées, pas seulement celles du
-- métier affiché. Une exception sur un compteur qui n'appartient pas au métier
-- de la personne est invisible à l'écran mais bien présente en base, et elle se
-- réveillerait le jour où on lui ajoute l'autre casquette. « Cette personne suit
-- son métier » doit être vrai sans réserve.
-- ----------------------------------------------------------------------------

create or replace function public.apply_job_targets(
    p_job   text,
    p_scale text
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
    n integer;
begin
    if not can_write_any() then
        raise exception 'Seul le propriétaire du Cockpit peut appliquer un objectif de métier.';
    end if;

    if p_job not in ('bdr', 'sales') then
        raise exception 'Métier inconnu : %', p_job;
    end if;

    if p_scale not in ('day', 'week', 'month') then
        raise exception 'Échelle inconnue : %', p_scale;
    end if;

    delete from activity_targets t
    where t.scope = 'user'
      and t.scale = p_scale
      and t.user_id in (
          select p.user_id
          from profiles p
          where case p_job
                    when 'sales' then p.is_sales
                    when 'bdr'   then (p.is_bdr and not p.is_sales)
                end
      );

    get diagnostics n = row_count;
    return n;
end $$;

comment on function public.apply_job_targets(text, text) is
    'Efface les objectifs personnels des membres d''un métier sur une échelle, '
    'pour qu''ils suivent à nouveau le défaut du métier — maintenant et à chaque '
    'changement futur. Renvoie le nombre de lignes effacées. Propriétaire seul.';

revoke all on function public.apply_job_targets(text, text) from public;
grant execute on function public.apply_job_targets(text, text) to authenticated;

commit;

-- ============================================================================
-- VÉRIFICATIONS APRÈS PASSAGE
--
--   -- La colonne existe et n'accepte que trois valeurs :
--   select gauge_scale, count(*) from profiles group by 1;
--   -- doit échouer avec 23514 :
--   update profiles set gauge_scale = 'trimestre' where user_id = auth.uid();
--
--   -- Qui porte encore une exception personnelle, et sur quelle échelle :
--   select p.display_name,
--          case when p.is_sales then 'sales' when p.is_bdr then 'bdr' end as metier,
--          t.scale, count(*) as n
--   from activity_targets t join profiles p on p.user_id = t.user_id
--   where t.scope = 'user'
--   group by 1, 2, 3 order by 1, 3;
--
--   -- Le privilège est bien limité à deux colonnes pour authenticated :
--   select column_name from information_schema.column_privileges
--   where table_name = 'profiles' and grantee = 'authenticated'
--     and privilege_type = 'UPDATE';
-- ============================================================================
