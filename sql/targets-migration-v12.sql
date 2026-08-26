-- ============================================================================
-- COCKPIT BDR — v12 : les objectifs, à trois échelles et fixés par le
--                     propriétaire
--
-- Fichier à exécuter une fois, dans l'éditeur SQL de Supabase. Rejouable :
-- la table n'est créée que si elle manque, et les insertions sont idempotentes.
--
-- ----------------------------------------------------------------------------
-- CE QUI NE MARCHAIT PAS
--
-- Les objectifs étaient journaliers, individuels, et réglés par chacun depuis
-- sa propre page de saisie. Le résultat est lisible dans daily_targets au
-- 26 août : Dominique a mis zéro partout le 25, Santiago le 26. Les deux ont
-- éteint leurs jauges, et ils ont eu raison de le faire. Un objectif journalier
-- de rendez-vous n'a pas de sens pour un BDR : un jour sans rendez-vous n'est
-- pas un mauvais jour, c'est un jour normal, et une jauge qui affiche 0 % tous
-- les soirs ne dit rien d'autre que « ignore-moi ». Ce que Dominique suit, elle,
-- c'est un nombre de rendez-vous dans le mois.
--
-- Trois manques, donc : pas d'échelle autre que la journée, pas de valeur par
-- défaut tenue par le responsable, et une main laissée à chacun sur ce qui
-- devrait être un engagement.
--
-- ----------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION MET EN PLACE
--
-- Une table en lignes plutôt qu'en colonnes. daily_targets avait une colonne
-- par métrique : passer à trois échelles aurait demandé vingt-sept colonnes,
-- puis une table de plus pour les valeurs par défaut. Une ligne par
-- (portée, échelle, métrique) absorbe les trois dimensions sans jamais
-- redemander une migration de schéma, et une métrique de plus dans METRICS n'y
-- change rien.
--
-- LA RÉSOLUTION D'UN OBJECTIF TIENT EN UNE PHRASE : la valeur de la personne si
-- elle existe, sinon celle de son métier, sinon aucun objectif et donc aucune
-- jauge. Le troisième cas est un vrai cas, et non un repli à zéro : un objectif
-- absent doit se voir comme absent. Zéro voudrait dire « ne rien faire est
-- l'objectif », ce qui est une phrase différente.
--
-- Elle est appliquée côté navigateur et non ici, volontairement. La table fait
-- moins de trois cents lignes, elle est chargée en entier comme l'est déjà le
-- barème, et le métier d'une personne est une donnée que le navigateur possède
-- déjà. Une fonction SQL de résolution aurait ajouté un aller-retour par écran
-- et une deuxième définition de la même règle.
--
-- LE MÉTIER RETENU QUAND QUELQU'UN A LES DEUX : commercial. Christophe est
-- coché BDR et commercial, et Bruno a tranché le 27 août, il est commercial.
-- La règle est donc « is_sales l'emporte », et non un maximum ou une moyenne
-- des deux barèmes d'objectifs, qui n'auraient correspondu à aucune réalité.
--
-- ----------------------------------------------------------------------------
-- CE QUI EST MIGRÉ, ET CE QUI NE L'EST PAS
--
-- Les valeurs individuelles strictement positives sont reprises à l'échelle
-- jour, et uniquement pour les métriques du métier de la personne.
--
-- Les zéros de Dominique et de Santiago ne sont PAS repris, et c'est une
-- décision, pas un oubli. Un zéro individuel écraserait l'objectif que le
-- propriétaire fixe pour le métier : la personne qui a éteint sa jauge en août
-- resterait sans objectif en septembre, sans que personne ne s'en aperçoive.
-- Ils repartent donc sur le défaut de leur métier, qui est désormais du ressort
-- de Bruno.
--
-- Ne sont pas repris non plus les objectifs commerciaux d'un BDR pur
-- (first_meetings et proposals valaient 1 chez Dominique et Santiago) : ce sont
-- les valeurs par défaut des colonnes, jamais affichées à un BDR, jamais
-- choisies par personne.
--
-- daily_targets n'est PAS supprimée. Elle n'est plus lue par personne après ce
-- lot, mais une table qu'on supprime le soir même de la bascule est une table
-- qu'on ne peut plus consulter le lendemain quand quelqu'un demande « j'avais
-- mis combien, déjà ». Sa suppression fera l'objet d'un lot séparé.
--
-- ORDRE DE DÉPLOIEMENT : ce fichier AVANT le code. Sans lui, l'écran des
-- objectifs et les jauges de la page de saisie annoncent que la migration
-- manque, et rien d'autre ne bouge.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. LA TABLE
--
-- `scope` dit à qui s'adresse la ligne, et les deux colonnes qui suivent sont
-- exclusives : soit un métier, soit une personne, jamais les deux, jamais
-- aucune. La contrainte le garantit plutôt que la convention, faute de quoi une
-- ligne bancale (un métier ET une personne) serait un objectif que personne ne
-- saurait résoudre.
-- ----------------------------------------------------------------------------
create table if not exists public.activity_targets (
    id          uuid primary key default gen_random_uuid(),
    scope       text        not null check (scope in ('job', 'user')),
    job         text        check (job in ('bdr', 'sales')),
    user_id     uuid        references auth.users(id) on delete cascade,
    scale       text        not null check (scale in ('day', 'week', 'month')),
    metric      text        not null check (btrim(metric) <> ''),
    value       integer     not null check (value >= 0 and value <= 1000000),
    updated_at  timestamptz not null default now(),
    updated_by  uuid        default auth.uid(),

    constraint activity_targets_scope_ck check (
        (scope = 'job'  and job is not null and user_id is null) or
        (scope = 'user' and user_id is not null and job is null)
    )
);

comment on table public.activity_targets is
    'Objectifs d''activité, par métier ou par personne, aux échelles jour, semaine et mois.
     Résolution appliquée par le navigateur : valeur de la personne, sinon de son métier,
     sinon aucun objectif. Fixés par le propriétaire uniquement.';

-- Deux index partiels plutôt qu'une clé unique sur cinq colonnes : une clé
-- ordinaire laisserait passer deux lignes pour le même métier dès que l'une a
-- user_id nul, NULL n'étant jamais égal à NULL.
create unique index if not exists activity_targets_job_uq
    on public.activity_targets (job, scale, metric) where scope = 'job';

create unique index if not exists activity_targets_user_uq
    on public.activity_targets (user_id, scale, metric) where scope = 'user';

-- Lecture par personne : c'est la requête de la page de saisie.
create index if not exists activity_targets_user_idx
    on public.activity_targets (user_id) where scope = 'user';


-- ----------------------------------------------------------------------------
-- 2. HORODATAGE
--
-- Même geste que trg_score_weights_touch sur le barème : savoir quand un
-- objectif a changé et par qui est ce qui permet, deux mois plus tard, de
-- comprendre pourquoi une jauge s'est mise à afficher 40 %.
-- ----------------------------------------------------------------------------
create or replace function public.activity_targets_touch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    new.updated_at := now();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
    return new;
end;
$$;

drop trigger if exists trg_activity_targets_touch on public.activity_targets;
create trigger trg_activity_targets_touch
    before insert or update on public.activity_targets
    for each row execute function public.activity_targets_touch();

revoke all on function public.activity_targets_touch() from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. DROITS
--
-- Tout le monde lit, le propriétaire seul écrit.
--
-- La lecture est ouverte à tous les comptes connectés parce qu'un objectif
-- n'est pas une donnée sensible : c'est même l'inverse, une équipe qui ne
-- connaît que son propre objectif ne sait pas ce qu'on attend d'elle. La page
-- d'équipe pourra l'afficher sans passer par une fonction.
--
-- L'écriture est bornée à can_write_any(), comme le barème. C'est la décision
-- de Bruno du 27 août : un objectif se négocie de vive voix, pas dans un champ
-- de formulaire, et personne ne doit plus pouvoir éteindre sa propre jauge.
-- ----------------------------------------------------------------------------
alter table public.activity_targets enable row level security;

drop policy if exists activity_targets_select on public.activity_targets;
create policy activity_targets_select on public.activity_targets
    for select using (auth.uid() is not null);

drop policy if exists activity_targets_write on public.activity_targets;
create policy activity_targets_write on public.activity_targets
    for all using (public.can_write_any()) with check (public.can_write_any());

grant select on public.activity_targets to authenticated;
grant insert, update, delete on public.activity_targets to authenticated;
revoke all on public.activity_targets from anon;


-- ----------------------------------------------------------------------------
-- 4. REPRISE DES OBJECTIFS EXISTANTS
--
-- Le mapping colonne vers métrique est écrit ici en dur, et c'est volontaire :
-- c'est un instantané du 27 août 2026, pas une règle vivante. La règle vivante,
-- celle qui dit quelle métrique appartient à quel métier, est dans METRICS,
-- côté navigateur. Recopier une table de correspondance dans la base en
-- ferait une deuxième définition, qui divergerait.
--
-- Le filtre sur le métier évite de créer des objectifs fantômes : Dominique
-- avait first_meetings_target à 1, valeur par défaut d'une colonne qu'un BDR ne
-- voit jamais. Migrée telle quelle, elle serait devenue un objectif personnel
-- de RDV1 pour quelqu'un qui n'en tient aucun.
-- ----------------------------------------------------------------------------
with correspondance (colonne, metrique, metiers) as (
    values ('companies_target',       'companies_created', array['bdr']),
           ('contacts_target',        'contacts_created',  array['bdr','sales']),
           ('calls_made_target',      'calls_made',        array['bdr','sales']),
           ('calls_connected_target', 'calls_connected',   array['bdr','sales']),
           ('engaged_target',         'calls_engaged',     array['bdr','sales']),
           ('meetings_target',        'meetings_booked',   array['bdr']),
           ('emails_target',          'emails_sent',       array['bdr']),
           ('first_meetings_target',  'first_meetings',    array['sales']),
           ('proposals_target',       'proposals_sent',    array['sales'])
),
aplat as (
    select t.user_id,
           c.metrique,
           (to_jsonb(t) ->> c.colonne)::integer as valeur,
           c.metiers,
           array_remove(array[
               case when p.is_bdr   then 'bdr'   end,
               case when p.is_sales then 'sales' end
           ], null) as metiers_personne
      from public.daily_targets t
      join public.profiles p on p.user_id = t.user_id
     cross join correspondance c
)
insert into public.activity_targets (scope, user_id, scale, metric, value)
select 'user', user_id, 'day', metrique, valeur
  from aplat
 where valeur is not null
   and valeur > 0                       -- une jauge éteinte n'est pas un objectif
   and metiers && metiers_personne      -- et la métrique doit concerner la personne
on conflict do nothing;


-- ----------------------------------------------------------------------------
-- 5. VALEURS PAR DÉFAUT PAR MÉTIER, À L'ÉCHELLE JOUR
--
-- Reprises de DEFAULT_TARGETS dans js/api.js, pour qu'aucune jauge existante ne
-- change de valeur le jour du déploiement. Ce ne sont pas des repères validés :
-- le commentaire du code disait déjà, pour les deux objectifs commerciaux,
-- qu'ils avaient été posés sans une seule journée de donnée réelle.
--
-- RIEN N'EST AMORCÉ AUX ÉCHELLES SEMAINE ET MOIS. Multiplier un objectif
-- journalier par cinq puis par vingt-et-un donnerait 21 RDV1 par mois à un
-- commercial, un chiffre que personne n'a décidé et que l'écran présenterait
-- pourtant comme un objectif. Tant que Bruno n'a pas rempli l'échelle mois,
-- elle n'affiche aucune jauge, et c'est la seule chose honnête à faire.
-- L'écran propose le calcul, il ne l'écrit pas à sa place.
-- ----------------------------------------------------------------------------
insert into public.activity_targets (scope, job, scale, metric, value)
values ('job', 'bdr',   'day', 'companies_created', 5),
       ('job', 'bdr',   'day', 'contacts_created',  10),
       ('job', 'bdr',   'day', 'calls_made',        40),
       ('job', 'bdr',   'day', 'calls_connected',   10),
       ('job', 'bdr',   'day', 'calls_engaged',     8),
       ('job', 'bdr',   'day', 'meetings_booked',   2),
       ('job', 'bdr',   'day', 'emails_sent',       30),

       ('job', 'sales', 'day', 'contacts_created',  10),
       ('job', 'sales', 'day', 'calls_made',        40),
       ('job', 'sales', 'day', 'calls_connected',   10),
       ('job', 'sales', 'day', 'calls_engaged',     8),
       ('job', 'sales', 'day', 'first_meetings',    1),
       ('job', 'sales', 'day', 'proposals_sent',    1)
on conflict do nothing;


-- ----------------------------------------------------------------------------
-- 5 bis. ÉCRITURE : DEUX FONCTIONS, ET PAS UN UPSERT DEPUIS LE NAVIGATEUR
--
-- PostgREST sait faire un upsert, mais il l'infère à partir des colonnes
-- passées dans on_conflict, et l'inférence échoue sur un index PARTIEL comme
-- activity_targets_job_uq, dont la clause « where scope = 'job' » n'est pas
-- déduite de la requête. Plutôt que de renoncer aux index partiels, qui sont ce
-- qui garantit l'unicité correcte, l'écriture passe par ces deux fonctions où
-- le on conflict est écrit à la main.
--
-- Elles sont en SECURITY INVOKER, donc soumises à la RLS : c'est toujours la
-- politique activity_targets_write qui décide, et non la fonction. Le contrôle
-- explicite en tête ne sert qu'à produire une phrase lisible au lieu du
-- « new row violates row-level security policy » que PostgreSQL renverrait.
--
-- clear_activity_target existe parce que « pas d'objectif » est une valeur en
-- soi, distincte de zéro : retirer l'objectif personnel de quelqu'un le fait
-- revenir au défaut de son métier, alors que le mettre à zéro lui dirait que
-- ne rien faire est l'objectif.
-- ----------------------------------------------------------------------------
create or replace function public.set_activity_target(
    p_scope  text,
    p_job    text,
    p_user   uuid,
    p_scale  text,
    p_metric text,
    p_value  integer
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
    if not public.can_write_any() then
        raise exception 'Seul le propriétaire du Cockpit peut fixer les objectifs.';
    end if;

    if p_scope = 'job' then
        insert into public.activity_targets (scope, job, scale, metric, value)
        values ('job', p_job, p_scale, p_metric, p_value)
        on conflict (job, scale, metric) where scope = 'job'
        do update set value = excluded.value;

    elsif p_scope = 'user' then
        insert into public.activity_targets (scope, user_id, scale, metric, value)
        values ('user', p_user, p_scale, p_metric, p_value)
        on conflict (user_id, scale, metric) where scope = 'user'
        do update set value = excluded.value;

    else
        raise exception 'Portée inconnue : %. Attendu « job » ou « user ».', p_scope;
    end if;
end;
$$;

create or replace function public.clear_activity_target(
    p_scope  text,
    p_job    text,
    p_user   uuid,
    p_scale  text,
    p_metric text
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
    if not public.can_write_any() then
        raise exception 'Seul le propriétaire du Cockpit peut retirer un objectif.';
    end if;

    delete from public.activity_targets
     where scale = p_scale
       and metric = p_metric
       and ((p_scope = 'job'  and scope = 'job'  and job = p_job)
         or (p_scope = 'user' and scope = 'user' and user_id = p_user));
end;
$$;

revoke all on function public.set_activity_target(text, text, uuid, text, text, integer)
    from public, anon;
revoke all on function public.clear_activity_target(text, text, uuid, text, text)
    from public, anon;

grant execute on function public.set_activity_target(text, text, uuid, text, text, integer)
    to authenticated;
grant execute on function public.clear_activity_target(text, text, uuid, text, text)
    to authenticated;


-- ----------------------------------------------------------------------------
-- 6. L'ANCIENNE TABLE
--
-- Gardée, plus lue. Le commentaire est là pour la prochaine personne qui
-- l'ouvrira en se demandant pourquoi ses valeurs ne bougent plus.
-- ----------------------------------------------------------------------------
comment on table public.daily_targets is
    'OBSOLÈTE depuis la v12 du 27 août 2026. Remplacée par activity_targets, qui gère les
     trois échelles et les valeurs par défaut par métier. Plus lue par aucun écran.
     Conservée le temps de vérifier la reprise, suppression prévue dans un lot ultérieur.';


-- ----------------------------------------------------------------------------
-- 7. CONTRÔLES À PASSER APRÈS EXÉCUTION
--
-- a) Ce qui a été repris, par personne :
--
--    select p.display_name, t.scale, count(*), sum(t.value)
--      from public.activity_targets t
--      join public.profiles p on p.user_id = t.user_id
--     where t.scope = 'user'
--     group by 1, 2 order by 1;
--    -- attendu : ni Dominique ni Santiago (leurs zéros ne sont pas des objectifs)
--
-- b) Les défauts par métier :
--
--    select job, scale, count(*) from public.activity_targets
--     where scope = 'job' group by 1, 2 order by 1, 2;
--    -- attendu : bdr/day 7, sales/day 6, et rien en semaine ni en mois
--
-- c) Aucune ligne bancale :
--
--    select count(*) from public.activity_targets
--     where (scope = 'job'  and (job is null or user_id is not null))
--        or (scope = 'user' and (user_id is null or job is not null));
--    -- attendu : 0
--
-- d) anon ne voit rien :
--
--    select has_table_privilege('anon', 'public.activity_targets', 'select');
--    -- attendu : false
--
-- e) un membre lit mais n'écrit pas (à passer avec une identité simulée) :
--
--    set local role authenticated;
--    set local request.jwt.claims = '{"sub":"<un membre>","role":"authenticated"}';
--    select count(*) from public.activity_targets;                      -- doit répondre
--    select public.set_activity_target('job','bdr',null,'month','calls_made',999);
--    -- attendu : « Seul le propriétaire du Cockpit peut fixer les objectifs. »
-- ----------------------------------------------------------------------------
