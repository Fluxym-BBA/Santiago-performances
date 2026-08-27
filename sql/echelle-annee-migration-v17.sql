-- ============================================================================
-- COCKPIT BDR — v17 : l'échelle Année, calée sur l'exercice
--
-- POURQUOI
--
-- Les objectifs existaient au jour, à la semaine et au mois. Or les objectifs
-- réels des BDR comme des commerciaux sont fixés à l'année : tout le reste en
-- découle. Sans cette échelle, chacun refaisait la division dans sa tête, et
-- personne ne la refaisait de la même façon.
--
-- L'ANNÉE, ICI, C'EST L'EXERCICE. Chez Fluxym il court du 1er octobre au
-- 30 septembre. Le mois de début est rangé dans app_settings et réglable depuis
-- l'écran « Barème et objectifs » : c'est le genre de valeur qui change une fois
-- tous les dix ans, mais qu'il ne faut pas avoir à venir chercher en SQL ce
-- jour-là. Un exercice calé sur janvier retombe naturellement sur l'année
-- civile, sans cas particulier.
--
-- CE QUI N'EST PAS FAIT ICI. Aucune donnée n'est convertie et aucun objectif
-- annuel n'est déduit des objectifs mensuels existants : le calcul serait une
-- supposition, et un objectif supposé est pire qu'un objectif absent. L'écran
-- propose une déduction au prorata des jours ouvrés, à relire et à enregistrer
-- à la main.
--
-- Rejouable sans dommage.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. LES CONTRAINTES D'ÉCHELLE
--
-- Deux endroits, et il faut les deux : activity_targets porte les valeurs,
-- profiles.gauge_scale porte l'échelle à laquelle chacun lit ses jauges. Oublier
-- la seconde donnerait une échelle sélectionnable mais non mémorisée, qui
-- retomberait sur le mois à chaque rechargement.
-- ----------------------------------------------------------------------------

alter table public.activity_targets drop constraint if exists activity_targets_scale_check;
alter table public.activity_targets add constraint activity_targets_scale_check
    check (scale = any (array['day'::text, 'week'::text, 'month'::text, 'year'::text]));

alter table public.profiles drop constraint if exists profiles_gauge_scale_chk;
alter table public.profiles add constraint profiles_gauge_scale_chk
    check (gauge_scale is null
        or gauge_scale = any (array['day'::text, 'week'::text, 'month'::text, 'year'::text]));

-- ----------------------------------------------------------------------------
-- 2. LE MOIS OÙ COMMENCE L'EXERCICE
--
-- Dix par défaut, la valeur de Fluxym. Le défaut compte : le code JavaScript se
-- replie sur la même valeur quand les réglages n'ont pas pu être lus, de sorte
-- qu'une lecture ratée donne les bonnes bornes au lieu de décaler tout
-- l'exercice de trois mois sans prévenir.
-- ----------------------------------------------------------------------------

alter table public.app_settings
    add column if not exists fiscal_year_start_month integer not null default 10;

alter table public.app_settings drop constraint if exists app_settings_fiscal_month_ck;
alter table public.app_settings add constraint app_settings_fiscal_month_ck
    check (fiscal_year_start_month between 1 and 12);

comment on column public.app_settings.fiscal_year_start_month is
    'Mois de début de l''exercice, 10 pour un exercice du 1er octobre au
     30 septembre. Réglable par le propriétaire depuis Barème et objectifs.';

-- ----------------------------------------------------------------------------
-- 3. LA FONCTION QUI VALIDAIT LES TROIS ÉCHELLES
--
-- apply_job_targets() refusait toute échelle hors day / week / month. Sans cette
-- reprise, le bouton « faire suivre le métier » aurait fonctionné partout sauf
-- sur l'onglet Année, avec un message d'erreur incompréhensible.
--
-- Le reste de la fonction est identique : la recopie n'est pas une recopie, elle
-- EFFACE les exceptions personnelles pour que tout le monde suive le défaut, y
-- compris les prochains.
-- ----------------------------------------------------------------------------

create or replace function public.apply_job_targets(p_job text, p_scale text)
returns integer
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

    if p_scale not in ('day', 'week', 'month', 'year') then
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
end
$$;

commit;
