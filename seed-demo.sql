-- ============================================================================
--  JEU DE DONNÉES DE DÉMONSTRATION — Cockpit BDR
--  À exécuter dans Supabase → SQL Editor → Run
--
--  Ce script crée 3 mois d'historique réaliste (jours ouvrés uniquement) pour
--  UN utilisateur, afin de faire vivre tous les compteurs et graphiques.
--
--  Il ne touche PAS à la journée d'aujourd'hui : elle reste vierge pour que
--  vous testiez la saisie manuelle en conditions réelles.
--
--  Toutes les données sont déterministes (dérivées de la date) : réexécuter le
--  script produit exactement les mêmes chiffres, sans doublon.
--
--  ⚠️  À supprimer ensuite avec reset-demo.sql avant l'usage réel.
-- ============================================================================

do $$
declare
    -- ⬇️⬇️  LA SEULE LIGNE À MODIFIER : l'e-mail du compte créé dans Authentication → Users
    -- Compte de démonstration dédié, JAMAIS un vrai compte de BDR.
    -- Créez-le dans Supabase (Authentication > Users > Add user, avec Auto
    -- Confirm User), puis marquez-le « démo » depuis la page Comptes de
    -- l'application : ses chiffres sortiront alors des classements d'équipe.
    v_email   text := 'bbartoli+demo@fluxym.com';
    -- ⬆️⬆️

    v_user    uuid;
    v_rows    int;
    v_record  date;
    v_abs1    date;
    v_abs2    date;
    v_creuse  date;
    v_batch   date;
begin
    ------------------------------------------------------------------------
    -- 0) Retrouver l'utilisateur, et échouer clairement s'il n'existe pas
    ------------------------------------------------------------------------
    select id into v_user from auth.users where lower(email) = lower(v_email);

    if v_user is null then
        raise exception
            'Aucun utilisateur avec l''e-mail "%". Vérifiez Authentication → Users (l''orthographe doit être exacte).',
            v_email;
    end if;

    ------------------------------------------------------------------------
    -- 1) Objectifs journaliers (alimentent les jauges de la page de saisie)
    ------------------------------------------------------------------------
    insert into public.daily_targets (
        user_id, companies_target, contacts_target,
        calls_made_target, calls_connected_target, meetings_target, emails_target)
    values (v_user, 5, 10, 40, 12, 2, 30)
    on conflict (user_id) do update set
        companies_target       = excluded.companies_target,
        contacts_target        = excluded.contacts_target,
        calls_made_target      = excluded.calls_made_target,
        calls_connected_target = excluded.calls_connected_target,
        meetings_target        = excluded.meetings_target,
        emails_target          = excluded.emails_target;

    ------------------------------------------------------------------------
    -- 2) 90 jours d'historique, du lundi au vendredi, jusqu'à HIER inclus
    --
    --    Le scénario intégré volontairement dans les chiffres :
    --      • une progression de fond : ~24 appels/jour il y a 3 mois, ~42 récemment
    --      • des vendredis plus calmes (-28 %)
    --      • un passage à vide d'une semaine il y a ~5 semaines (-55 %)
    --      • du bruit quotidien, pour que rien ne soit trop lisse
    --      • quelques journées de gros envois d'e-mails
    ------------------------------------------------------------------------
    insert into public.daily_activity (
        user_id, activity_date,
        companies_created, contacts_created,
        calls_made, calls_connected, meetings_booked, emails_sent)
    select
        v_user,
        b.jour,
        ((b.r / 11) % 7)::int                                          as companies_created,
        (((b.r / 11) % 7) * 2 + ((b.r / 5) % 6))::int                  as contacts_created,
        b.calls,
        b.connected,
        -- RDV : 5 % à 22 % des appels aboutis, jamais plus que les aboutis
        least(b.connected, floor(b.connected * (0.05 + (((b.r / 7) % 18) / 100.0)))::int) as meetings_booked,
        -- E-mails : socle 18-43, plus un envoi massif ponctuel
        (18 + ((b.r / 3) % 26) + case when (b.r % 29) = 0 then 68 else 0 end)::int as emails_sent
    from (
        select
            a.jour, a.r, a.calls,
            -- Appels aboutis : 24 % à 42 % des appels passés
            least(a.calls, round(a.calls * (0.24 + ((a.r % 19) / 100.0)))::int) as connected
        from (
            select
                g.d::date as jour,
                -- Pseudo-aléatoire stable dérivé de la date (28 bits, toujours positif)
                (('x' || substr(md5(g.d::date::text), 1, 7))::bit(28)::int % 997) as r,
                greatest(0, round(
                      -- tendance de fond
                      (24 + 18 * (1 - (current_date - 1 - g.d::date)::numeric / 90))
                      -- vendredis plus calmes
                    * case when extract(isodow from g.d) = 5 then 0.72 else 1 end
                      -- semaine de passage à vide
                    * case when g.d::date between current_date - 38 and current_date - 32 then 0.45 else 1 end
                      -- bruit quotidien
                    + ((('x' || substr(md5(g.d::date::text), 1, 7))::bit(28)::int % 997) % 15) - 7
                ))::int as calls
            from generate_series(current_date - 90, current_date - 1, interval '1 day') as g(d)
            where extract(isodow from g.d) between 1 and 5   -- lundi → vendredi
        ) a
    ) b
    on conflict (user_id, activity_date) do update set
        companies_created = excluded.companies_created,
        contacts_created  = excluded.contacts_created,
        calls_made        = excluded.calls_made,
        calls_connected   = excluded.calls_connected,
        meetings_booked   = excluded.meetings_booked,
        emails_sent       = excluded.emails_sent;

    get diagnostics v_rows = row_count;

    ------------------------------------------------------------------------
    -- 3) Repères narratifs, pour rendre le dashboard intéressant à explorer
    ------------------------------------------------------------------------

    -- 3a) LE jour record, il y a environ 3 semaines
    select activity_date into v_record
    from public.daily_activity
    where user_id = v_user and activity_date between current_date - 25 and current_date - 18
    order by activity_date limit 1;

    if v_record is not null then
        update public.daily_activity set
            calls_made = 71, calls_connected = 34, meetings_booked = 6,
            emails_sent = 58, companies_created = 9, contacts_created = 18,
            notes = 'Journée record : campagne sur le secteur industrie, fichier très qualifié. [DÉMO]'
        where user_id = v_user and activity_date = v_record;
    end if;

    -- 3b) Deux jours sans aucune activité (formation) : crée un vrai trou dans les courbes
    select activity_date into v_abs1
    from public.daily_activity
    where user_id = v_user and activity_date between current_date - 52 and current_date - 47
    order by activity_date limit 1;

    if v_abs1 is not null then
        select min(activity_date) into v_abs2
        from public.daily_activity
        where user_id = v_user and activity_date > v_abs1;

        update public.daily_activity set
            calls_made = 0, calls_connected = 0, meetings_booked = 0,
            emails_sent = 0, companies_created = 0, contacts_created = 0,
            notes = 'Formation interne sur 2 jours, aucune prospection. [DÉMO]'
        where user_id = v_user and activity_date in (v_abs1, v_abs2);
    end if;

    -- 3c) Une note explicative sur la semaine creuse
    select activity_date into v_creuse
    from public.daily_activity
    where user_id = v_user and activity_date between current_date - 38 and current_date - 32
    order by activity_date limit 1;

    if v_creuse is not null then
        update public.daily_activity set
            notes = 'Fichier épuisé, en attente de nouveaux comptes de la part du marketing. [DÉMO]'
        where user_id = v_user and activity_date = v_creuse;
    end if;

    -- 3d) Une note sur la plus grosse journée d'e-mails
    select activity_date into v_batch
    from public.daily_activity
    where user_id = v_user and activity_date <= current_date - 1
    order by emails_sent desc, activity_date desc limit 1;

    if v_batch is not null then
        update public.daily_activity set
            notes = 'Séquence e-mail envoyée en masse sur le secteur retail. [DÉMO]'
        where user_id = v_user and activity_date = v_batch and notes is null;
    end if;

    -- Le profil est marqué compte de démonstration, sans quoi ces 90 jours
    -- fabriqués viendraient fausser tous les classements de la vue d'équipe.
    update public.profiles
       set is_demo = true,
           display_name = coalesce(nullif(display_name, ''), 'Compte de démonstration')
     where user_id = v_user;

    raise notice 'Démo installée : % jours écrits pour % (record le %).', v_rows, v_email, v_record;
    raise notice 'Le compte est marqué « démo » : il est exclu des classements d''équipe.';
end $$;

-- ============================================================================
--  VÉRIFICATION — le résultat de cette requête s'affiche dans le SQL Editor
-- ============================================================================
select
    count(*)                                    as jours_saisis,
    min(activity_date)                          as du,
    max(activity_date)                          as au,
    sum(calls_made)                             as total_appels,
    sum(calls_connected)                        as total_aboutis,
    sum(meetings_booked)                        as total_rdv,
    sum(emails_sent)                            as total_emails,
    round(avg(productivity_score), 1)           as score_moyen,
    max(productivity_score)                     as meilleur_score,
    round(100.0 * sum(calls_connected) / nullif(sum(calls_made), 0), 1) as taux_aboutis_pct,
    round(100.0 * sum(meetings_booked) / nullif(sum(calls_connected), 0), 1) as taux_rdv_pct
from public.v_daily_kpi;
