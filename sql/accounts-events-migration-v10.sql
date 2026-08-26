-- ============================================================================
-- Cockpit BDR — migration v10
-- Nommer les entreprises du cycle de vente
-- ============================================================================
--
-- POURQUOI CETTE MIGRATION
--
-- daily_activity est une table agrégée : une ligne par personne et par jour,
-- des compteurs. Il n'y a nulle part où accrocher un nom d'entreprise, parce
-- qu'il n'existe aucun objet « une proposition ». Cette migration crée cet
-- objet, pour que le commercial puisse dire non seulement « deux propositions »
-- mais « une proposition chez Airbus et une chez Safran ».
--
-- LE CHOIX STRUCTURANT : LA LISTE DIT LA VÉRITÉ
--
-- Les cinq compteurs du cycle de vente (first_meetings, proposals_sent, no_go,
-- deals_dropped, deals_lost) cessent d'être saisis. Ils deviennent le décompte
-- des lignes de sales_events, tenu par un trigger. Une seule vérité, et donc
-- pas de « douze propositions déclarées mais sept nommées » à expliquer plus
-- tard dans les statistiques par client.
--
-- Ce choix est possible sans aucune reprise de données parce qu'il n'existe
-- à ce jour AUCUN événement de cycle de vente en base : zéro RDV1, zéro
-- proposition, zéro sortie sur 171 journées saisies. Refondre la saisie de ces
-- cinq champs ne casse donc l'habitude de personne. Six mois plus tard, il
-- aurait fallu réconcilier des compteurs avec des listes incomplètes.
--
-- CONSÉQUENCE À CONNAÎTRE AVANT D'APPLIQUER
--
-- Dès cette migration, écrire directement dans ces cinq colonnes n'a plus
-- d'effet : un trigger BEFORE les remplace par le décompte des événements.
-- C'est voulu, c'est ce qui garantit qu'il n'y a qu'une vérité quelle que soit
-- la porte d'entrée, set_metric ou upsert. Mais tant que la page de saisie
-- n'est pas déployée, ces cinq compteurs ne sont plus incrémentables. Comme
-- ils valent zéro partout et que personne ne s'en sert, le risque est nul.
-- L'ordre reste : cette migration, puis le code.
--
-- CE QUI N'EST PAS TOUCHÉ
--
-- Le score, total_actions, les trois vues, les contraintes d'intégrité des
-- appels, la RLS existante, les sept métriques du BDR. Les cinq colonnes
-- restent des entiers dans daily_activity, au même endroit, avec les mêmes
-- contraintes de positivité : tout ce qui les lit continue de fonctionner sans
-- le savoir.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. LES ENTREPRISES
--
-- Une table volontairement pauvre : un nom, et c'est tout. Ce n'est pas un
-- référentiel client, c'est le carnet d'adresses du Cockpit. Le référentiel,
-- c'est Salesforce, et rien ici ne prétend s'y rapprocher automatiquement.
--
-- name_key est le garde-fou contre le doublon d'orthographe. Calculée par la
-- base et non par le navigateur, parce qu'une règle de normalisation écrite
-- côté client est contournée dès la première requête faite autrement. Elle
-- réduit la casse et les espaces : « AIRBUS   Defence » et « Airbus Defence »
-- deviennent la même clé, donc le second refuse de s'insérer.
--
-- Ce qu'elle ne fait PAS : les accents et les fautes de frappe. « Fluxim » et
-- « Fluxym » resteront deux entreprises. Le remède est l'autocomplétion sous
-- les yeux du commercial, pas la base. Une vraie recherche floue demanderait
-- l'extension pg_trgm, disponible mais non installée, et ce n'est pas la peine
-- pour quatre cents noms.
-- ----------------------------------------------------------------------------
create table if not exists public.accounts (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    name_key    text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
    created_by  uuid default auth.uid() references auth.users(id) on delete set null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint accounts_name_not_blank check (btrim(name) <> ''),
    constraint accounts_name_max check (length(name) <= 120)
);

create unique index if not exists accounts_name_key_uq on public.accounts (name_key);
create index if not exists accounts_name_idx on public.accounts (name_key text_pattern_ops);

comment on table public.accounts is
    'Carnet d''entreprises du Cockpit, saisi à la main par les commerciaux. Pas un référentiel client : Salesforce l''est.';
comment on column public.accounts.name_key is
    'Nom normalisé (minuscules, espaces réduits), unique. Empêche le doublon de casse, pas la faute de frappe.';


-- ----------------------------------------------------------------------------
-- 2. LES ÉVÉNEMENTS DU CYCLE DE VENTE
--
-- Une ligne par événement déclaré. kind porte EXACTEMENT le nom de la colonne
-- de daily_activity qu'il alimente, et ce n'est pas un hasard : deux
-- vocabulaires pour la même chose finissent toujours par diverger, et le
-- navigateur peut ainsi envoyer la clé de métrique qu'il affiche déjà.
--
-- account_id est nullable, à dessein. Un commercial pressé doit pouvoir
-- déclarer une proposition sans nommer le client : la contrainte n'est pas de
-- tout documenter, elle est de saisir tous les jours. Un événement anonyme
-- compte quand même dans le compteur et dans le score.
-- ----------------------------------------------------------------------------
create table if not exists public.sales_events (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
    activity_date date not null default current_date,
    kind          text not null,
    account_id    uuid references public.accounts(id) on delete set null,
    created_at    timestamptz not null default now(),
    created_by    uuid default auth.uid() references auth.users(id) on delete set null,
    constraint sales_events_kind_known check (kind in
        ('first_meetings', 'proposals_sent', 'no_go', 'deals_dropped', 'deals_lost'))
    -- Pas de contrainte « date non future » ici : une contrainte CHECK doit
    -- être immuable et current_date ne l'est pas, PostgreSQL la refuserait.
    -- daily_activity vit avec la même limite depuis l'origine, et c'est la
    -- page de saisie qui borne le calendrier.
);

create index if not exists sales_events_user_day_idx on public.sales_events (user_id, activity_date);
create index if not exists sales_events_account_idx  on public.sales_events (account_id, kind, activity_date desc);

comment on table public.sales_events is
    'Un événement de cycle de vente déclaré. Source de vérité des cinq compteurs correspondants de daily_activity.';
comment on column public.sales_events.kind is
    'Porte le nom exact de la colonne alimentée dans daily_activity, pour n''avoir qu''un seul vocabulaire.';


-- ----------------------------------------------------------------------------
-- 3. LE COMPTEUR DÉRIVÉ
--
-- Deux fonctions, et un seul endroit qui compte.
--
-- derive_sales_counters() est un trigger BEFORE sur daily_activity : quoi qu'on
-- tente d'écrire dans les cinq colonnes, elles sont remplacées par le décompte
-- réel des événements. C'est ce qui rend la vérité unique sans avoir à
-- retoucher set_metric, saveDay, ni aucun autre chemin d'écriture présent ou
-- futur.
--
-- touch_sales_day() est appelée par le trigger de sales_events. Elle ne calcule
-- rien : elle provoque une écriture sur la journée concernée et laisse le
-- trigger BEFORE faire le compte. Dupliquer le calcul dans les deux fonctions
-- reviendrait à avoir deux fois la même règle, donc un jour deux règles.
--
-- Elle ne crée une journée que s'il reste au moins un événement : supprimer le
-- dernier événement d'un jour ne doit pas laisser une ligne de saisie vide
-- derrière lui, qui compterait comme une journée renseignée.
-- ----------------------------------------------------------------------------
create or replace function public.derive_sales_counters()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_fm int; v_ps int; v_ng int; v_dd int; v_dl int;
begin
    select count(*) filter (where kind = 'first_meetings'),
           count(*) filter (where kind = 'proposals_sent'),
           count(*) filter (where kind = 'no_go'),
           count(*) filter (where kind = 'deals_dropped'),
           count(*) filter (where kind = 'deals_lost')
      into v_fm, v_ps, v_ng, v_dd, v_dl
      from public.sales_events
     where user_id = new.user_id
       and activity_date = new.activity_date;

    new.first_meetings := v_fm;
    new.proposals_sent := v_ps;
    new.no_go          := v_ng;
    new.deals_dropped  := v_dd;
    new.deals_lost     := v_dl;
    return new;
end;
$$;

create or replace function public.touch_sales_day(p_user uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if exists (select 1 from public.sales_events
                where user_id = p_user and activity_date = p_date) then
        insert into public.daily_activity (user_id, activity_date, created_by, updated_by)
        values (p_user, p_date, auth.uid(), auth.uid())
        on conflict (user_id, activity_date)
        do update set updated_at = now(), updated_by = auth.uid();
    else
        update public.daily_activity
           set updated_at = now(), updated_by = auth.uid()
         where user_id = p_user and activity_date = p_date;
    end if;
end;
$$;

create or replace function public.tg_sales_events_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    -- La journée d'arrivée d'abord, puis celle de départ si elle diffère : un
    -- événement déplacé d'un jour à l'autre laisse deux compteurs à corriger.
    if tg_op in ('INSERT', 'UPDATE') then
        perform public.touch_sales_day(new.user_id, new.activity_date);
    end if;
    if tg_op = 'DELETE'
       or (tg_op = 'UPDATE' and (old.user_id <> new.user_id
                                 or old.activity_date <> new.activity_date)) then
        perform public.touch_sales_day(old.user_id, old.activity_date);
    end if;
    return null;
end;
$$;

drop trigger if exists daily_activity_derive_sales on public.daily_activity;
create trigger daily_activity_derive_sales
    before insert or update on public.daily_activity
    for each row execute function public.derive_sales_counters();

drop trigger if exists sales_events_sync on public.sales_events;
create trigger sales_events_sync
    after insert or update or delete on public.sales_events
    for each row execute function public.tg_sales_events_sync();


-- ----------------------------------------------------------------------------
-- 4. RLS
--
-- sales_events reprend mot pour mot la logique de daily_activity : chacun voit
-- et écrit ses journées, les managers voient tout et écrivent pour tous. C'est
-- le seul verrou qui compte, parce que les triggers sont SECURITY DEFINER et
-- font confiance à ce qui a franchi cette porte.
--
-- accounts est différent : c'est un bien commun, tout le monde lit et crée,
-- mais seuls ceux qui peuvent écrire pour autrui peuvent corriger un nom, car
-- renommer une entreprise change ce que lisent les autres. Personne ne peut
-- supprimer : la clé étrangère est ON DELETE SET NULL, une suppression
-- détacherait silencieusement l'historique au lieu d'échouer. Renommer suffit.
--
-- La lecture exige une session (auth.uid() is not null) et non « true » : une
-- liste de clients n'a pas à être lisible par la clé anonyme.
-- ----------------------------------------------------------------------------
alter table public.accounts      enable row level security;
alter table public.sales_events  enable row level security;

drop policy if exists accounts_select on public.accounts;
create policy accounts_select on public.accounts
    for select using (auth.uid() is not null);

drop policy if exists accounts_insert on public.accounts;
create policy accounts_insert on public.accounts
    for insert with check (auth.uid() is not null);

drop policy if exists accounts_update on public.accounts;
create policy accounts_update on public.accounts
    for update using (public.can_write_any()) with check (public.can_write_any());

drop policy if exists events_select on public.sales_events;
create policy events_select on public.sales_events
    for select using (user_id = auth.uid() or public.can_read_all());

drop policy if exists events_insert on public.sales_events;
create policy events_insert on public.sales_events
    for insert with check (user_id = auth.uid() or public.can_write_any());

drop policy if exists events_update on public.sales_events;
create policy events_update on public.sales_events
    for update using (user_id = auth.uid() or public.can_write_any())
             with check (user_id = auth.uid() or public.can_write_any());

drop policy if exists events_delete on public.sales_events;
create policy events_delete on public.sales_events
    for delete using (user_id = auth.uid() or public.can_write_any());


-- ----------------------------------------------------------------------------
-- 5. L'HISTORIQUE D'UNE ENTREPRISE
--
-- Sert l'avertissement « une proposition est déjà partie chez ce client ». Pour
-- être utile, il doit voir les événements des collègues : une proposition
-- envoyée par quelqu'un d'autre est précisément celle qu'on veut signaler.
--
-- D'où une fonction dédiée plutôt qu'une politique de lecture élargie sur
-- sales_events : elle ne renvoie que le type, la date et un prénom, jamais la
-- table. Ouvrir sales_events en lecture à toute l'équipe pour obtenir la même
-- information exposerait au passage l'activité complète de chacun.
-- ----------------------------------------------------------------------------
create or replace function public.account_history(p_account uuid)
returns table (kind text, activity_date date, who text, is_mine boolean)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
    select e.kind,
           e.activity_date,
           public.display_name_of(e.user_id),
           e.user_id = auth.uid()
      from public.sales_events e
     where e.account_id = p_account
       and auth.uid() is not null
     order by e.activity_date desc, e.created_at desc
     limit 100;
$$;


-- ----------------------------------------------------------------------------
-- 6. PRIVILÈGES
--
-- Leçon de la v9, apprise à la dure : changer la signature d'une fonction en
-- crée une nouvelle aux yeux de PostgreSQL, qui repart avec les privilèges par
-- défaut du schéma. Ici anon est dans ces défauts. Et « revoke from public » ne
-- retire pas un droit accordé explicitement à un rôle nommé, d'où le « public,
-- anon » systématique, y compris pour les fonctions de trigger.
-- ----------------------------------------------------------------------------
-- Les trois rouages internes du trigger ne sont appelés par personne d'autre
-- que le trigger. Les laisser exposés sur /rest/v1/rpc permettait à un
-- utilisateur connecté d'appeler touch_sales_day avec l'identifiant d'un
-- collègue, donc de provoquer une écriture sur la journée d'autrui. On les
-- retire aussi à authenticated, pas seulement à anon.
--
-- Le trigger continue de fonctionner : le privilège EXECUTE d'une fonction de
-- trigger est vérifié à la création du trigger, et l'appel imbriqué de
-- touch_sales_day se fait avec les droits du propriétaire de la fonction
-- appelante, qui est SECURITY DEFINER. Vérifié par une insertion réelle après
-- le revoke, le compteur s'est bien mis à jour.
revoke all on function public.touch_sales_day(uuid, date)  from public, anon, authenticated;
revoke all on function public.derive_sales_counters()      from public, anon, authenticated;
revoke all on function public.tg_sales_events_sync()       from public, anon, authenticated;

-- account_history reste ouverte à authenticated : c'est le point d'entrée de
-- l'avertissement de doublon, et elle ne renvoie qu'un type, une date et un
-- prénom, jamais la table.
revoke all on function public.account_history(uuid) from public, anon;
grant execute on function public.account_history(uuid) to authenticated, service_role;

revoke all on table public.accounts     from anon;
revoke all on table public.sales_events from anon;
grant select, insert, update on table public.accounts to authenticated;
grant select, insert, update, delete on table public.sales_events to authenticated;
