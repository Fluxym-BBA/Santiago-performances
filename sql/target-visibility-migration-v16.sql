-- ============================================================================
-- COCKPIT BDR — v16 : afficher ou masquer un objectif, compteur par compteur
--
-- POURQUOI CETTE TABLE
--
-- Les objectifs sont fixés par le propriétaire (activity_targets, v12), et
-- depuis la v13 chacun choisit l'échelle à laquelle il les lit. Il manquait le
-- droit de ne pas les voir du tout : un BDR qui débute sur un compteur n'a pas
-- besoin d'une jauge à 4 % sous les yeux toute la journée, et un compteur qu'on
-- suit sans objectif reste un compteur qu'on saisit.
--
-- Le modèle est CELUI DES OBJECTIFS, volontairement, pour qu'il n'y ait qu'une
-- règle à retenir dans tout l'outil :
--
--     une ligne scope = 'user' pour une personne     l'emporte sur
--     une ligne scope = 'job'  pour un métier        l'emporte sur
--     rien du tout, et l'objectif est alors AFFICHÉ
--
-- Le défaut est donc « visible ». Une base vide se comporte exactement comme
-- avant la migration : c'est ce qui permet de déployer le SQL avant le code
-- sans rien changer à l'écran.
--
-- CE QUI DIFFÈRE DES OBJECTIFS, ET C'EST VOULU
--
-- 1. Chacun écrit SA ligne. activity_targets est réservé à can_write_any() ;
--    ici une personne doit pouvoir masquer son propre objectif, sinon le
--    réglage n'a aucun sens. La politique « self » n'autorise que
--    scope = 'user' avec son propre user_id : personne ne peut toucher au
--    défaut d'un métier ni au réglage d'un collègue.
--
-- 2. Pas de dimension d'échelle. Un objectif se montre ou se cache, ce choix ne
--    dépend pas de le lire au jour, à la semaine ou au mois. Une colonne scale
--    aurait triplé les lignes sans rien apporter.
--
-- CE QUI N'EST PAS VALIDÉ ICI. La colonne metric n'est pas contrainte à la
-- liste blanche metric_allowed() : une contrainte CHECK exige une fonction
-- immuable, or cette liste est susceptible de bouger. Une ligne portant un nom
-- de compteur inconnu est simplement ignorée à l'affichage, elle ne peut ni
-- masquer ni révéler quoi que ce soit.
--
-- Rejouable sans dommage.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. LA TABLE
-- ----------------------------------------------------------------------------

create table if not exists public.target_visibility (
    id          uuid        primary key default gen_random_uuid(),
    scope       text        not null check (scope in ('job', 'user')),
    job         text        check (job in ('bdr', 'sales')),
    user_id     uuid        references auth.users(id) on delete cascade,
    metric      text        not null check (btrim(metric) <> ''),
    visible     boolean     not null,
    updated_at  timestamptz not null default now(),
    updated_by  uuid        default auth.uid(),

    -- Une ligne désigne un métier OU une personne, jamais les deux, jamais
    -- aucun des deux : sans cette contrainte, une ligne orpheline resterait
    -- invisible dans les deux écrans de réglage tout en pesant sur la
    -- résolution.
    constraint target_visibility_scope_ck check (
        (scope = 'job'  and job is not null and user_id is null)
     or (scope = 'user' and user_id is not null and job is null)
    )
);

comment on table public.target_visibility is
    'Affichage des objectifs, compteur par compteur. Une ligne user l''emporte
     sur une ligne job, et l''absence de ligne vaut « affiché ». Le propriétaire
     règle le défaut par métier, chacun règle ses propres exceptions.';

-- Deux index partiels plutôt qu'une clé unique sur quatre colonnes : une clé
-- portant sur job ET user_id laisserait passer deux lignes pour la même
-- personne, NULL n'étant jamais égal à NULL.
create unique index if not exists target_visibility_job_uq
    on public.target_visibility (job, metric) where scope = 'job';

create unique index if not exists target_visibility_user_uq
    on public.target_visibility (user_id, metric) where scope = 'user';

-- ----------------------------------------------------------------------------
-- 2. QUI PEUT LIRE ET ÉCRIRE
-- ----------------------------------------------------------------------------

alter table public.target_visibility enable row level security;

-- Lecture ouverte à toute personne connectée : un manager qui consulte l'écran
-- d'un membre doit voir ce que ce membre voit, sinon la conversation « tu en es
-- où sur les échanges ? » porte sur deux écrans différents.
drop policy if exists target_visibility_select on public.target_visibility;
create policy target_visibility_select on public.target_visibility
    for select using (auth.uid() is not null);

-- Le propriétaire et les administrateurs : tout, y compris les défauts par
-- métier et les exceptions des autres, ce qui rend possible le « forcer à
-- chacun ».
drop policy if exists target_visibility_admin on public.target_visibility;
create policy target_visibility_admin on public.target_visibility
    for all using (public.can_write_any()) with check (public.can_write_any());

-- Chacun, sur sa propre ligne et rien d'autre. Les deux conditions sont
-- répétées dans using et dans with check : sans le with check, une personne
-- pourrait créer une ligne au nom d'un collègue, et sans le using elle ne
-- pourrait pas revenir sur son propre choix.
drop policy if exists target_visibility_self on public.target_visibility;
create policy target_visibility_self on public.target_visibility
    for all to authenticated
    using      (scope = 'user' and user_id = auth.uid())
    with check (scope = 'user' and user_id = auth.uid());

grant select                       on public.target_visibility to authenticated;
grant insert, update, delete       on public.target_visibility to authenticated;

-- ----------------------------------------------------------------------------
-- 3. FORCER LE DÉFAUT À TOUT LE MONDE
--
-- Efface les exceptions personnelles d'un métier, donc tout le monde revient au
-- défaut du propriétaire. C'est le même raisonnement qu'en v13 sur les
-- objectifs : on EFFACE les exceptions au lieu de recopier le défaut dans
-- chaque ligne personnelle. Recopier rendrait le forçage rétroactif une fois,
-- puis figé : le jour où le propriétaire change d'avis, plus personne ne
-- suivrait.
--
-- SECURITY INVOKER : la suppression passe par la politique admin, donc un
-- membre qui appellerait cette fonction ne supprimerait que ses propres lignes.
-- Aucune élévation de privilège à surveiller.
-- ----------------------------------------------------------------------------

create or replace function public.clear_visibility_exceptions(p_job text)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
    n integer;
begin
    if p_job is not null and p_job not in ('bdr', 'sales') then
        raise exception 'Métier inconnu : %', p_job using errcode = '22023';
    end if;

    delete from public.target_visibility v
     where v.scope = 'user'
       and (
            p_job is null
            or exists (
                select 1 from public.profiles p
                 where p.user_id = v.user_id
                   and ((p_job = 'bdr' and p.is_bdr) or (p_job = 'sales' and p.is_sales))
            )
       );

    get diagnostics n = row_count;
    return n;
end;
$$;

comment on function public.clear_visibility_exceptions(text) is
    'Supprime les choix d''affichage personnels, pour un métier ou pour tout le
     monde quand l''argument est nul. Renvoie le nombre de lignes effacées.';

grant execute on function public.clear_visibility_exceptions(text) to authenticated;

commit;


-- ============================================================================
-- 4. POSER UN RÉGLAGE
--
-- Un update suivi d'un insert plutôt qu'un ON CONFLICT : l'unicité repose sur
-- des index PARTIELS, et l'inférence de conflit ne sait pas les retrouver. Même
-- raison qu'en v12 pour set_activity_target, et même conséquence côté client,
-- où l'upsert de PostgREST est inutilisable sur cette table.
--
-- SECURITY INVOKER : c'est la RLS qui décide qui peut écrire quoi. Un membre qui
-- appellerait cette fonction avec le métier en portée se verrait refuser
-- l'écriture, pas contourner la règle.
-- ============================================================================

create or replace function public.set_target_visibility(
    p_scope   text,
    p_job     text,
    p_user    uuid,
    p_metric  text,
    p_visible boolean
) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
    if p_scope not in ('job', 'user') then
        raise exception 'Portée inconnue : %', p_scope using errcode = '22023';
    end if;
    if p_metric is null or btrim(p_metric) = '' then
        raise exception 'Compteur manquant' using errcode = '22023';
    end if;
    if p_visible is null then
        raise exception 'Valeur manquante' using errcode = '22023';
    end if;

    if p_scope = 'job' then
        if p_job not in ('bdr', 'sales') then
            raise exception 'Métier inconnu : %', p_job using errcode = '22023';
        end if;
        update public.target_visibility
           set visible = p_visible, updated_at = now(), updated_by = auth.uid()
         where scope = 'job' and job = p_job and metric = p_metric;
        if not found then
            insert into public.target_visibility(scope, job, user_id, metric, visible)
            values ('job', p_job, null, p_metric, p_visible);
        end if;
    else
        if p_user is null then
            raise exception 'Personne manquante' using errcode = '22023';
        end if;
        update public.target_visibility
           set visible = p_visible, updated_at = now(), updated_by = auth.uid()
         where scope = 'user' and user_id = p_user and metric = p_metric;
        if not found then
            insert into public.target_visibility(scope, job, user_id, metric, visible)
            values ('user', null, p_user, p_metric, p_visible);
        end if;
    end if;
end;
$$;

grant execute on function public.set_target_visibility(text, text, uuid, text, boolean) to authenticated;

-- ============================================================================
-- 5. RENDRE UNE PERSONNE À SON MÉTIER
--
-- Efface ses réglages au lieu d'y recopier le défaut, pour la raison déjà vue
-- en v13 sur les objectifs : recopier rendrait le forçage vrai une fois puis
-- figé, et cette personne cesserait de suivre le métier dès que le métier
-- changerait d'avis.
-- ============================================================================

create or replace function public.clear_user_visibility(p_user uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
    n integer;
begin
    delete from public.target_visibility
     where scope = 'user' and user_id = p_user;
    get diagnostics n = row_count;
    return n;
end;
$$;

grant execute on function public.clear_user_visibility(uuid) to authenticated;
