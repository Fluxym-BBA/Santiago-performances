-- ============================================================================
-- COCKPIT BDR — v11 : tenir le carnet d'entreprises propre
--
-- Fichier à exécuter une fois, dans l'éditeur SQL de Supabase. Il ne touche
-- aucune donnée : il n'ajoute que quatre fonctions et leurs privilèges.
-- Rejouable autant de fois que nécessaire.
--
-- LE PROBLÈME QU'IL RÈGLE
--
-- Depuis la v10, taper un nom inconnu dans la page de saisie crée une ligne
-- dans `accounts`. C'est voulu : le carnet se constitue en travaillant. Mais
-- rien ne permettait de défaire une faute de frappe. « carefour » saisi le
-- 26 août restait dans le carnet pour toujours, proposé à l'autocomplétion à
-- côté de CARREFOUR, et supprimer la ligne d'activité n'y changeait rien
-- puisque l'entreprise vit sa propre vie.
--
-- Aucune politique DELETE n'existait sur `accounts`, donc la table refusait
-- toute suppression, sans message et sans recours.
--
-- CE QUI EST DÉCIDÉ ICI, ET POURQUOI
--
-- 1. LA SUPPRESSION PASSE PAR UNE FONCTION, PAS PAR UNE POLITIQUE DELETE.
--    Ce n'est pas un détail d'implémentation. Le critère est « aucune action du
--    cycle de vente n'est rattachée à cette entreprise », et il doit se juger
--    sur TOUTES les actions, y compris celles des collègues. Or une sous-
--    requête écrite dans une politique s'exécute avec les droits de l'appelant,
--    donc sous la RLS de sales_events, qui ne montre à un membre que ses
--    propres lignes. Un membre aurait donc jugé « aucune action » une
--    entreprise travaillée par quelqu'un d'autre, et la clé étrangère étant en
--    ON DELETE SET NULL, les lignes du collègue auraient silencieusement perdu
--    leur nom d'entreprise. Une fonction SECURITY DEFINER voit tout, tranche
--    juste, et peut dire pourquoi elle refuse.
--
--    Corollaire : aucun GRANT DELETE n'est donné sur la table. Il n'y a donc
--    qu'un seul chemin de suppression, celui qui compte les actions.
--
-- 2. LE FONDS IMPORTÉ DE SALESFORCE EST PROTÉGÉ. Les 445 noms chargés le
--    26 août n'ont, eux aussi, aucune action rattachée : une règle purement
--    « zéro action, donc supprimable » les aurait rendus tous effaçables, par
--    n'importe quel compte connecté, comptes de démonstration compris. Leur
--    marqueur est `created_by is null`, personne ne les ayant créés depuis
--    l'outil. Seul le propriétaire peut les retirer.
--
-- 3. LA FUSION EST RÉSERVÉE AU PROPRIÉTAIRE, comme le renommage l'est déjà par
--    la politique accounts_update de la v10. Elle réaffecte les actions
--    d'autres personnes : c'est le même pouvoir que corriger leurs chiffres.
--
-- 4. UNE SEULE VÉRITÉ SUR « EST-CE SUPPRIMABLE ». Le texte du refus est produit
--    par account_block_text(), appelée par l'écran comme par la suppression.
--    Deux règles écrites deux fois auraient fini par ne plus dire la même
--    chose, et l'écran aurait proposé un bouton que la base refuse.
--
-- ORDRE DE DÉPLOIEMENT : ce fichier AVANT le code de l'écran entreprises.html.
-- Sans lui, l'écran s'ouvre mais annonce que la migration manque.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. LA RÈGLE, ÉCRITE UNE FOIS
--
-- Renvoie NULL quand la suppression est permise, sinon la phrase à montrer.
-- IMMUTABLE et sans accès aux tables : elle ne juge que sur les trois faits
-- qu'on lui donne, ce qui la rend utilisable dans un SELECT sur 450 lignes sans
-- rien coûter.
--
-- Le pluriel est traité à la main. « 1 actions » dans un message d'erreur fait
-- douter du reste du logiciel.
-- ----------------------------------------------------------------------------
create or replace function public.account_block_text(
    p_events     bigint,
    p_created_by uuid,
    p_privileged boolean
) returns text
language sql
immutable
as $$
    select case
        when coalesce(p_events, 0) > 0 then
            format('%s action%s du cycle de vente %s rattachée%s à cette entreprise. '
                || 'Fusionnez-la avec la bonne entreprise, ou supprimez d''abord ces lignes '
                || 'dans la page de saisie du jour concerné.',
                p_events,
                case when p_events > 1 then 's' else '' end,
                case when p_events > 1 then 'sont' else 'est' end,
                case when p_events > 1 then 's' else '' end)
        when p_created_by is null and not coalesce(p_privileged, false) then
            'Cette entreprise vient de l''import Salesforce du 26 août. '
         || 'Seul le propriétaire du Cockpit peut la retirer du carnet.'
        else null
    end;
$$;

comment on function public.account_block_text(bigint, uuid, boolean) is
    'Raison du refus de suppression d''une entreprise, NULL si la suppression est permise.
     Seule source de vérité, appelée par accounts_overview() et par delete_account().';


-- ----------------------------------------------------------------------------
-- 2. L'ÉCRAN : TOUT LE CARNET, AVEC L'USAGE DE CHAQUE NOM
--
-- Une seule requête pour les 450 lignes, et non un appel par entreprise :
-- l'écran est fait pour être ouvert, filtré, relu, et 450 allers-retours le
-- rendraient inutilisable.
--
-- SECURITY DEFINER pour la même raison que account_history() en v10 : le
-- décompte doit porter sur les actions de tout le monde, alors que la RLS de
-- sales_events ne montre à un membre que les siennes. Ce qui sort d'ici reste
-- volontairement pauvre : un nombre, deux dates, un prénom de créateur. Jamais
-- la table, jamais le détail de l'activité de quelqu'un.
--
-- `nom_createur` est renvoyé parce que la première question devant une faute de
-- frappe est « qui l'a écrite », et que la réponse évite de supprimer le nom
-- d'un collègue qui savait ce qu'il faisait.
-- ----------------------------------------------------------------------------
create or replace function public.accounts_overview()
returns table (
    id            uuid,
    name          text,
    created_at    timestamptz,
    created_by    uuid,
    nom_createur  text,
    mine          boolean,
    n_events      bigint,
    n_users       bigint,
    first_event   date,
    last_event    date,
    block_reason  text
)
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
    v_privileged boolean;
begin
    -- Le grant limite déjà l'appel au rôle authenticated. La garde est là pour
    -- le jour où quelqu'un rendra la fonction accessible sans y penser.
    if auth.uid() is null then
        raise exception 'Connexion requise pour consulter le carnet d''entreprises.';
    end if;

    -- Évalué une fois, et non par ligne : can_write_any() lit profiles.
    v_privileged := public.can_write_any();

    return query
    with usage as (
        select e.account_id,
               count(*)                   as n_events,
               count(distinct e.user_id)  as n_users,
               min(e.activity_date)       as first_event,
               max(e.activity_date)       as last_event
          from public.sales_events e
         where e.account_id is not null
         group by e.account_id
    )
    select a.id,
           a.name,
           a.created_at,
           a.created_by,
           case when a.created_by is null then null
                else public.display_name_of(a.created_by) end,
           a.created_by = auth.uid(),
           coalesce(u.n_events, 0),
           coalesce(u.n_users, 0),
           u.first_event,
           u.last_event,
           public.account_block_text(coalesce(u.n_events, 0), a.created_by, v_privileged)
      from public.accounts a
      left join usage u on u.account_id = a.id
     order by a.name;
end;
$$;

comment on function public.accounts_overview() is
    'Carnet d''entreprises avec, pour chaque nom, le nombre d''actions du cycle de vente
     toutes personnes confondues, et la raison qui empêche éventuellement de le supprimer.';


-- ----------------------------------------------------------------------------
-- 3. SUPPRIMER UNE ENTREPRISE
--
-- Renvoie le nom supprimé, pour que l'écran puisse le citer dans sa
-- confirmation plutôt que d'annoncer « suppression effectuée » sans dire de
-- quoi. En cas de refus, elle lève une exception dont le texte est écrit pour
-- être affiché tel quel : PostgREST le remonte dans `message`, et humanError()
-- le laisse passer.
--
-- Le décompte des actions est refait ici, et non lu depuis l'écran : entre le
-- chargement de la liste et le clic, un collègue a pu rattacher une action au
-- nom qu'on s'apprête à effacer.
-- ----------------------------------------------------------------------------
create or replace function public.delete_account(p_account uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_name  text;
    v_owner uuid;
    v_n     bigint;
    v_block text;
begin
    if auth.uid() is null then
        raise exception 'Connexion requise pour supprimer une entreprise.';
    end if;

    select a.name, a.created_by into v_name, v_owner
      from public.accounts a where a.id = p_account;
    if v_name is null then
        raise exception 'Cette entreprise n''est plus dans le carnet. Rechargez la page.';
    end if;

    select count(*) into v_n
      from public.sales_events e where e.account_id = p_account;

    v_block := public.account_block_text(v_n, v_owner, public.can_write_any());
    if v_block is not null then
        raise exception '% : %', v_name, v_block;
    end if;

    delete from public.accounts where id = p_account;
    return v_name;
end;
$$;

comment on function public.delete_account(uuid) is
    'Supprime une entreprise du carnet si aucune action du cycle de vente n''y est rattachée.
     Le fonds importé de Salesforce (created_by nul) est réservé au propriétaire.';


-- ----------------------------------------------------------------------------
-- 4. FUSIONNER DEUX ENTREPRISES
--
-- Le geste que la suppression ne peut pas faire : « CAREFOUR » porte déjà trois
-- actions, on ne veut pas les perdre, on veut les voir chez CARREFOUR.
--
-- Réservée au propriétaire. Elle réaffecte des lignes appartenant à d'autres
-- personnes, ce que seul can_write_any() autorise ailleurs dans la base.
--
-- Aucun recalcul de daily_activity n'est nécessaire, et c'est un point qui se
-- vérifie plutôt que se suppose : les compteurs du cycle de vente sont dérivés
-- du NOMBRE d'événements par personne et par jour. La fusion change le nom
-- attaché à un événement, jamais sa date ni son auteur, donc jamais un
-- compteur. Le trigger sales_events_sync se déclenche quand même sur chaque
-- ligne mise à jour et recalcule la même valeur : inoffensif, et c'est ce qui
-- garantit que rien ne dérive si cette hypothèse cesse d'être vraie un jour.
--
-- Ce que la fusion ne fait pas, volontairement : dédoublonner les actions.
-- Si les deux entreprises portent chacune une proposition envoyée le même jour
-- par la même personne, il en restera deux après la fusion. Ce sont deux
-- déclarations réelles, et le score du jour les compte déjà toutes les deux :
-- en supprimer une ici modifierait un chiffre passé sans que personne ne l'ait
-- demandé.
-- ----------------------------------------------------------------------------
create or replace function public.merge_accounts(p_source uuid, p_target uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_src text;
    v_dst text;
    v_n   integer;
begin
    if not public.can_write_any() then
        raise exception 'La fusion de deux entreprises est réservée au propriétaire du Cockpit.';
    end if;
    if p_source is null or p_target is null then
        raise exception 'Il faut deux entreprises : celle à faire disparaître, et celle à garder.';
    end if;
    if p_source = p_target then
        raise exception 'Une entreprise ne peut pas être fusionnée avec elle-même.';
    end if;

    select name into v_src from public.accounts where id = p_source;
    select name into v_dst from public.accounts where id = p_target;
    if v_src is null or v_dst is null then
        raise exception 'Une des deux entreprises n''est plus dans le carnet. Rechargez la page.';
    end if;

    update public.sales_events
       set account_id = p_target
     where account_id = p_source;
    get diagnostics v_n = row_count;

    delete from public.accounts where id = p_source;
    return v_n;
end;
$$;

comment on function public.merge_accounts(uuid, uuid) is
    'Réaffecte toutes les actions de p_source vers p_target, puis supprime p_source.
     Réservée au propriétaire. Ne modifie aucun compteur ni aucun score.';


-- ----------------------------------------------------------------------------
-- 5. PRIVILÈGES
--
-- Leçon de la v9, puis de la v10 : une fonction nouvellement créée repart avec
-- les privilèges par défaut du schéma, et anon en fait partie sur ce projet.
-- Une fonction SECURITY DEFINER laissée exécutable par anon serait une porte
-- ouverte sur le carnet client sans authentification. On révoque d'abord, on
-- accorde ensuite, et dans cet ordre.
--
-- account_block_text n'est pas exposée : elle ne sert qu'aux deux autres, qui
-- l'appellent en tant que propriétaire de la définition.
-- ----------------------------------------------------------------------------
revoke all on function public.account_block_text(bigint, uuid, boolean) from public, anon, authenticated;

revoke all on function public.accounts_overview()              from public, anon;
revoke all on function public.delete_account(uuid)             from public, anon;
revoke all on function public.merge_accounts(uuid, uuid)       from public, anon;

grant execute on function public.accounts_overview()           to authenticated, service_role;
grant execute on function public.delete_account(uuid)          to authenticated, service_role;
grant execute on function public.merge_accounts(uuid, uuid)    to authenticated, service_role;

-- Aucun GRANT DELETE sur public.accounts : voir le point 1 de l'en-tête. La
-- suppression n'a qu'un chemin, et ce chemin compte les actions.


-- ----------------------------------------------------------------------------
-- 6. CONTRÔLES À PASSER APRÈS EXÉCUTION
--
-- a) Les trois fonctions existent, sont SECURITY DEFINER et ont un search_path :
--
--    select p.proname, p.prosecdef, p.proconfig
--      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and p.proname in ('accounts_overview','delete_account','merge_accounts',
--                         'account_block_text');
--
-- b) anon ne peut rien exécuter :
--
--    select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_peut
--      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and p.proname in ('accounts_overview','delete_account','merge_accounts');
--    -- attendu : false partout
--
-- c) Le carnet répond, et le fonds Salesforce est bien marqué comme protégé
--    pour qui n'est pas propriétaire :
--
--    select count(*) filter (where block_reason is null)     as supprimables,
--           count(*) filter (where block_reason is not null) as bloquees
--      from public.accounts_overview();
--
-- d) Toujours aucune politique DELETE sur accounts, donc aucun autre chemin :
--
--    select polname, polcmd from pg_policy p
--      join pg_class c on c.oid = p.polrelid where c.relname = 'accounts';
--    -- attendu : select, insert, update, et rien pour delete
-- ----------------------------------------------------------------------------
