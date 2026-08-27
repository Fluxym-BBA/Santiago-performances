-- ============================================================================
-- COCKPIT BDR — v18 : un chiffre après la virgule dans les objectifs
--
-- POURQUOI
--
-- Depuis la v17, les objectifs se posent à l'année et se déduisent au prorata
-- des jours ouvrés. La division tombe très rarement juste : 1 000 rendez-vous
-- sur un exercice de 252 jours ouvrés, cela fait 3,97 par jour, que la v17
-- arrondissait à 4. L'écart paraît minuscule ; sur un exercice il vaut sept
-- rendez-vous, soit une semaine et demie de travail affichée en trop.
--
-- Le même problème existe sans l'année : « une proposition tous les deux
-- jours » n'était pas exprimable. 1 et 0 étaient les deux seules réponses, et
-- aucune des deux ne disait la bonne chose.
--
-- UN SEUL CHIFFRE, ET PAS DEUX. numeric(10,1) et non numeric(10,2) : la
-- précision au centième n'a aucun sens sur un compteur d'appels, et deux
-- décimales auraient surtout produit des « 3,97 » illisibles sur la jauge là où
-- « 4 » suffit. Un dixième, c'est ce qu'il faut pour dire « 2,5 rendez-vous par
-- semaine » sans prétendre à une exactitude que l'activité n'a pas.
--
-- CE QUE LE TYPE FAIT TOUT SEUL, ET POURQUOI ON NE S'EN CONTENTE PAS.
-- numeric(10,1) arrondit silencieusement : 2,55 devient 2,6 sans un mot. Ici
-- l'arrondi est donc écrit explicitement dans la fonction, et l'écran des
-- objectifs annonce à l'utilisateur les valeurs qu'il a dû arrondir avant
-- d'enregistrer. Une valeur changée en silence dans le dos de celui qui la
-- saisit est exactement ce qu'on refuse depuis le début.
--
-- CE QUI NE CHANGE PAS. Les saisies quotidiennes restent des entiers : on ne
-- passe pas 2,5 appels. Seul l'OBJECTIF devient décimal, parce qu'il est une
-- moyenne attendue et non un fait constaté. Les poids du barème restent entiers
-- eux aussi : décision de Bruno du 27/08.
--
-- POURQUOI DROP PUIS CREATE ET NON CREATE OR REPLACE. Changer le type d'un
-- paramètre change la signature : « create or replace » aurait créé une
-- SECONDE fonction à côté de l'ancienne, et PostgREST se serait retrouvé avec
-- deux candidates pour le même appel. Il faut donc supprimer l'ancienne, ce qui
-- fait perdre ses droits d'exécution : ils sont reposés plus bas, à l'identique
-- de la v12. Les oublier aurait donné un « permission denied for function » à
-- la première tentative d'enregistrement.
--
-- ORDRE DE DÉPLOIEMENT. Cette migration passe AVANT le code. L'ancien code
-- continue de fonctionner avec la colonne décimale — il envoie des entiers, que
-- numeric accepte sans broncher. L'inverse n'est pas vrai : le nouveau code
-- enverrait 2,5 à une fonction attendant un integer, et PostgREST refuserait.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. La colonne
--
-- « using round(value::numeric, 1) » plutôt qu'un cast nu : les valeurs
-- existantes sont des entiers, la conversion est donc sans perte, mais écrire
-- l'arrondi rend la migration rejouable telle quelle si la colonne avait déjà
-- été passée en numeric avec plus de décimales.
-- ----------------------------------------------------------------------------
alter table public.activity_targets
    alter column value type numeric(10,1) using round(value::numeric, 1);

-- La borne haute reste la même : un objectif au-delà du million est une faute
-- de frappe, pas une ambition. numeric(10,1) laisserait passer 999 999 999,9.
alter table public.activity_targets
    drop constraint if exists activity_targets_value_check;

alter table public.activity_targets
    add constraint activity_targets_value_check
    check (value >= 0 and value <= 1000000);

comment on column public.activity_targets.value is
    'Objectif attendu sur la période. Décimal à un chiffre depuis la v18 : la '
    'déduction au prorata des jours ouvrés tombe rarement juste, et arrondir à '
    'l''entier coûtait jusqu''à une semaine de travail sur un exercice.';

-- ----------------------------------------------------------------------------
-- 2. La fonction d'écriture
-- ----------------------------------------------------------------------------
drop function if exists public.set_activity_target(text, text, uuid, text, text, integer);

create or replace function public.set_activity_target(
    p_scope  text,
    p_job    text,
    p_user   uuid,
    p_scale  text,
    p_metric text,
    p_value  numeric
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
    v numeric;
begin
    if not public.can_write_any() then
        raise exception 'Seul le propriétaire du Cockpit peut fixer les objectifs.';
    end if;

    -- Arrondi explicite. La colonne le ferait elle-même, mais en silence : le
    -- rendre visible ici évite qu'un jour un changement de type de colonne
    -- modifie discrètement ce que la fonction accepte.
    v := round(p_value, 1);

    if p_scope = 'job' then
        insert into public.activity_targets (scope, job, scale, metric, value)
        values ('job', p_job, p_scale, p_metric, v)
        on conflict (job, scale, metric) where scope = 'job'
        do update set value = excluded.value;

    elsif p_scope = 'user' then
        insert into public.activity_targets (scope, user_id, scale, metric, value)
        values ('user', p_user, p_scale, p_metric, v)
        on conflict (user_id, scale, metric) where scope = 'user'
        do update set value = excluded.value;

    else
        raise exception 'Portée inconnue : %. Attendu « job » ou « user ».', p_scope;
    end if;
end;
$$;

-- Droits reposés à l'identique de la v12 : le DROP ci-dessus les a emportés.
revoke all on function public.set_activity_target(text, text, uuid, text, text, numeric)
    from public, anon;

grant execute on function public.set_activity_target(text, text, uuid, text, text, numeric)
    to authenticated;

commit;

-- PostgREST garde en mémoire la signature des fonctions exposées. Sans ce
-- signal, le premier enregistrement après la migration peut échouer sur une
-- signature qui n'existe plus. Supabase recharge en principe tout seul sur
-- DDL ; le dire explicitement ne coûte rien et évite d'avoir à en douter.
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- POUR REVENIR EN ARRIÈRE (les valeurs décimales seraient arrondies, donc
-- perdues — à ne faire que juste après la migration) :
--
--   drop function if exists public.set_activity_target(text,text,uuid,text,text,numeric);
--   alter table public.activity_targets
--       alter column value type integer using round(value)::integer;
--   ... puis rejouer le bloc set_activity_target de la v12.
-- ----------------------------------------------------------------------------
