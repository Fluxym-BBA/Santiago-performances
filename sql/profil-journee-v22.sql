-- =============================================================================
-- Cockpit BDR — v22 — LE PROFIL DE LA JOURNÉE
--
-- POURQUOI CETTE TABLE EXISTE
-- Une journée à quatre appels ressemble à une journée ratée. Si elle s'est
-- passée en salon, elle est normale. La note du jour dit déjà ce genre de
-- chose, mais en texte libre : aucune moyenne, aucune jauge, aucun graphique ne
-- peut la lire. Cette table rend calculable ce que la note raconte, sans rien
-- retirer à la note, qui reste en place pour tout le reste.
--
-- CE QU'ELLE N'EST PAS
-- Ce n'est pas une feuille de temps. Elle n'entre dans aucun score, elle ne
-- modifie aucun compteur, elle n'a aucun trigger vers daily_activity. Le jour
-- où elle deviendrait un instrument de contrôle horaire, elle cesserait d'être
-- remplie, et l'application entière repose sur le fait qu'elle soit remplie
-- tous les jours.
--
-- CINQ CATÉGORIES, PAS UNE DE PLUS
-- Arrêtées avec Bruno le 27/08/2026. L'ordre d'affichage est celui de la
-- fréquence attendue, du plus courant au plus rare : c'est le premier de la
-- liste qui sera choisi neuf fois sur dix, et un geste par jour économisé sur
-- un an fait la différence entre un champ rempli et un champ abandonné.
--
-- IDEMPOTENTE : peut être passée deux fois sans dommage.
-- =============================================================================

create table if not exists public.day_profile (
    id             uuid primary key default gen_random_uuid(),

    -- Aligné sur sales_events : la cible est écrite explicitement par le front,
    -- le défaut auth.uid() n'est qu'un filet. C'est ce qui permet au
    -- propriétaire du Cockpit de corriger la journée de quelqu'un d'autre.
    user_id        uuid not null default auth.uid()
                        references auth.users(id) on delete cascade,
    activity_date  date not null default current_date,

    kind           text not null,

    -- Un pourcentage entier. Zéro est refusé : une activité qui n'a pris aucune
    -- part de la journée n'a rien à faire dans la liste, on la retire.
    share          smallint not null default 100,

    -- Précision libre, utile pour nommer un salon ou un webinar. Volontairement
    -- courte : la note du jour existe déjà pour les phrases.
    label          text,

    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    created_by     uuid default auth.uid() references auth.users(id) on delete set null,

    constraint day_profile_kind_known check (kind in
        ('prospection', 'crm_cleansing', 'webinar', 'salon', 'autre')),
    constraint day_profile_share_range check (share > 0 and share <= 100),
    constraint day_profile_label_len   check (label is null or char_length(label) <= 80),

    -- Une catégorie ne peut être déclarée qu'une fois par jour. Deux lignes
    -- « salon » à 25 % devraient être une seule ligne à 50 % : sans cette
    -- contrainte, la somme serait juste mais la lecture par catégorie
    -- compterait deux salons dans la même journée.
    constraint day_profile_one_line_per_kind unique (user_id, activity_date, kind)
);

-- La contrainte d'unicité fournit déjà l'index (user_id, activity_date) en
-- préfixe : aucun index supplémentaire n'est nécessaire pour lire une journée
-- ou une plage de dates d'une personne.

drop trigger if exists trg_day_profile_updated_at on public.day_profile;
create trigger trg_day_profile_updated_at
    before update on public.day_profile
    for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- SÉCURITÉ
-- Exactement les règles de sales_events, à la lettre : chacun lit et écrit chez
-- lui, can_read_all() lit chez tout le monde, can_write_any() est le seul à
-- pouvoir écrire chez quelqu'un d'autre. Un manager voit le profil de journée
-- de son équipe, il ne le corrige pas.
-- -----------------------------------------------------------------------------

alter table public.day_profile enable row level security;

drop policy if exists day_profile_select on public.day_profile;
create policy day_profile_select on public.day_profile
    for select using (user_id = auth.uid() or can_read_all());

drop policy if exists day_profile_insert on public.day_profile;
create policy day_profile_insert on public.day_profile
    for insert with check (user_id = auth.uid() or can_write_any());

drop policy if exists day_profile_update on public.day_profile;
create policy day_profile_update on public.day_profile
    for update using (user_id = auth.uid() or can_write_any())
             with check (user_id = auth.uid() or can_write_any());

drop policy if exists day_profile_delete on public.day_profile;
create policy day_profile_delete on public.day_profile
    for delete using (user_id = auth.uid() or can_write_any());

grant select, insert, update, delete on public.day_profile to authenticated;

-- -----------------------------------------------------------------------------
-- ÉCRITURE : TOUTE LA JOURNÉE EN UNE FOIS
--
-- POURQUOI UNE FONCTION PLUTÔT QUE QUATRE APPELS POSTGREST
-- Modifier une répartition touche presque toujours plusieurs lignes à la fois :
-- ajouter une deuxième activité fait passer la première de 100 % à 50 %,
-- supprimer l'avant-dernière fait remonter la dernière à 100 %. En PostgREST,
-- cela fait deux à trois requêtes dont la deuxième peut échouer, et l'écran se
-- retrouve avec un profil à 150 % enregistré en base. Ici, le remplacement est
-- atomique : ou bien la journée entière est écrite, ou bien rien ne bouge.
--
-- SECURITY INVOKER, et c'est délibéré : la fonction n'accorde aucun droit
-- supplémentaire, les policies ci-dessus s'appliquent normalement. Une tentative
-- d'écriture chez quelqu'un d'autre sans can_write_any() échoue exactement comme
-- un INSERT direct.
--
-- Ce que la fonction NE FAIT PAS : vérifier que la somme vaut 100. C'est
-- volontaire. L'écran affiche « il reste 25 % » et laisse la personne finir sa
-- phrase ; refuser l'écriture intermédiaire obligerait à tout saisir d'un coup
-- ou à perdre ce qui a été tapé. Une somme partielle est un état normal, pas
-- une erreur, et la lecture sait la présenter comme telle.
-- -----------------------------------------------------------------------------

create or replace function public.set_day_profile(
    p_user  uuid,
    p_date  date,
    p_lines jsonb
)
returns setof public.day_profile
language plpgsql
security invoker
set search_path = public
as $$
begin
    delete from public.day_profile d
     where d.user_id = p_user
       and d.activity_date = p_date;

    /* L'ORDRE D'ENVOI N'EST PAS CONSERVÉ, et c'est voulu. Toutes les lignes
       d'une même journée sont écrites dans la même transaction, donc elles
       partagent la même valeur de now() : aucune colonne de la table ne
       permettrait de retrouver l'ordre de saisie. Plutôt qu'une colonne de
       position à maintenir, l'écran affiche les catégories dans leur ordre
       canonique, toujours le même. La barre de répartition garde ainsi ses
       couleurs dans le même ordre d'un jour à l'autre, ce qui est justement ce
       qui la rend lisible d'un coup d'œil. */
    return query
    with entrees as (
        select
            (e ->> 'kind')::text                              as kind,
            coalesce((e ->> 'share')::smallint, 100::smallint) as share,
            nullif(btrim(coalesce(e ->> 'label', '')), '')     as label
        from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as e
    ),
    ins as (
        insert into public.day_profile (user_id, activity_date, kind, share, label)
        select p_user, p_date, kind, share, left(label, 80)
          from entrees
         where kind is not null
        returning *
    )
    select * from ins;
end;
$$;

grant execute on function public.set_day_profile(uuid, date, jsonb) to authenticated;

-- =============================================================================
-- FIN. Aucune donnée existante n'est touchée : la table est neuve, aucun
-- compteur ni aucun score ne dépend d'elle, et l'application d'avant la v22
-- continue de fonctionner à l'identique si le code n'est pas déployé.
-- =============================================================================
