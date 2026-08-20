-- ============================================================================
--  JEU DE DONNÉES DE DÉMONSTRATION D'ÉQUIPE — Cockpit BDR
--  À exécuter dans Supabase → SQL Editor → Run
--
--  Ce script remplit 3 mois d'historique (jours ouvrés) pour PLUSIEURS comptes
--  de démonstration, avec des profils volontairement différents. Il complète
--  seed-demo.sql, qui ne sait traiter qu'un seul compte.
--
--  Pourquoi trois profils différents
--  ---------------------------------
--  Un jeu de démonstration où tout le monde se ressemble ne permet de tester
--  aucune comparaison. Les trois profils ci-dessous sont construits pour que
--  les écarts soient lisibles ET défendables face à un commercial :
--
--    A. Le régulier, gros volume     : beaucoup d'appels, conversion moyenne.
--    B. L'irrégulier qui progresse   : forte variance, nette montée sur 3 mois,
--                                      compense le téléphone par l'e-mail.
--    C. Le manager qui prospecte     : trois fois moins d'appels, mais taux
--                                      d'abouti et conversion très supérieurs.
--
--  L'intérêt de C est de montrer qu'un score brut plus faible n'est pas une
--  contre-performance : c'est le débat que l'outil doit savoir provoquer.
--
--  Choix de méthode
--  ----------------
--  • Déterministe : les chiffres dérivent de md5(date + profil). Rejouer le
--    script produit exactement les mêmes données, sans doublon.
--  • Les RDV se déduisent des appels aboutis, jamais l'inverse, et ne peuvent
--    jamais les dépasser (contrainte daily_activity_calls_coherent).
--  • Les absences sont des jours SANS LIGNE, pas des jours à zéro. La nuance
--    compte : elle permet de vérifier que les moyennes portent sur les jours
--    actifs et non sur les jours du calendrier. Deux jours de formation sont
--    en revanche saisis à zéro, pour avoir les deux cas.
--  • La journée d'aujourd'hui reste vierge, pour tester la saisie réelle.
--  • Garde-fou : le script REFUSE d'écrire sur un compte qui n'est pas marqué
--    « démonstration ». Une faute de frappe sur une adresse ne peut donc pas
--    polluer les chiffres d'un vrai BDR.
--
--  ATTENTION : adapter les trois adresses ci-dessous à vos comptes de démo.
-- ============================================================================

do $$
declare
  p        record;
  v_user   uuid;
  v_demo   boolean;
  v_rows   int;
  v_total  int := 0;
begin
  for p in
    select * from (values
      -- email, code, appels début, appels fin, taux abouti début/fin, taux RDV début/fin,
      -- socle e-mails, amplitude e-mails, facteur vendredi, saute le vendredi, modulo sociétés, bruit
      ('bruno.bartoli.fluxym+demo-santiago-performance@gmail.com',  'A', 44, 52, 0.27, 0.30, 0.06, 0.08, 20, 16, 0.75, false, 7,  7),
      ('bruno.bartoli.fluxym+demo2-santiago-performance@gmail.com', 'B', 24, 58, 0.20, 0.28, 0.05, 0.11, 34, 26, 0.80, false, 5, 14),
      ('bruno.bartoli.fluxym+demo3-santiago-performance@gmail.com', 'C', 20, 16, 0.42, 0.48, 0.15, 0.19,  8, 11, 1.00, true,  3,  5)
    ) as t(email, code, c_start, c_end, cr_start, cr_end, mr_start, mr_end, mail_base, mail_span, fri, skip_fri, comp_mod, noise)
  loop
    select u.id, pr.is_demo into v_user, v_demo
    from auth.users u join public.profiles pr on pr.user_id = u.id
    where lower(u.email) = lower(p.email);

    if v_user is null then
      raise notice 'IGNORÉ : aucun compte pour %', p.email;
      continue;
    end if;

    -- Le garde-fou. Ne jamais écrire de données fictives sur un compte réel.
    if not v_demo then
      raise notice 'IGNORÉ : le compte % n''est pas marqué démo.', p.email;
      continue;
    end if;

    ----------------------------------------------------------------------
    -- Objectifs journaliers, cohérents avec le profil de chacun
    ----------------------------------------------------------------------
    insert into public.daily_targets (user_id, companies_target, contacts_target,
                                      calls_made_target, calls_connected_target, meetings_target, emails_target)
    values (v_user,
            case p.code when 'A' then 5  when 'B' then 4  else 2  end,
            case p.code when 'A' then 10 when 'B' then 8  else 4  end,
            case p.code when 'A' then 50 when 'B' then 45 else 20 end,
            case p.code when 'A' then 14 when 'B' then 12 else 9  end,
            case p.code when 'A' then 2  when 'B' then 2  else 1  end,
            case p.code when 'A' then 30 when 'B' then 45 else 15 end)
    on conflict (user_id) do update set
      companies_target       = excluded.companies_target,
      contacts_target        = excluded.contacts_target,
      calls_made_target      = excluded.calls_made_target,
      calls_connected_target = excluded.calls_connected_target,
      meetings_target        = excluded.meetings_target,
      emails_target          = excluded.emails_target;

    ----------------------------------------------------------------------
    -- Table rase sur la fenêtre : un « on conflict » ne suffirait pas, il
    -- laisserait en place les jours devenus des absences entre deux runs.
    ----------------------------------------------------------------------
    delete from public.daily_activity
     where user_id = v_user and activity_date >= current_date - 90;

    insert into public.daily_activity (user_id, activity_date, companies_created, contacts_created,
                                       calls_made, calls_connected, meetings_booked, emails_sent)
    select
      v_user, s.jour, s.comp, s.comp * 2 + ((s.r / 5) % 4),
      s.calls,
      least(s.calls, greatest(0, round(s.calls * (p.cr_start + (p.cr_end - p.cr_start) * s.t
                                                  + (((s.r / 7) % 7) - 3) / 100.0))::int)) as connected,
      0,                     -- les RDV sont calculés juste après, depuis les aboutis
      s.mails
    from (
      select
        g.d::date as jour,
        -- pseudo-aléatoire stable dérivé de la date et du profil (28 bits, toujours positif)
        (('x' || substr(md5(g.d::date::text || p.code), 1, 7))::bit(28)::int % 997) as r,
        ((g.d::date - (current_date - 90))::numeric / 89) as t,
        greatest(0, round(
            (p.c_start + (p.c_end - p.c_start) * ((g.d::date - (current_date - 90))::numeric / 89))
          * case when extract(isodow from g.d) = 5 then p.fri else 1 end
          + ((('x' || substr(md5(g.d::date::text || p.code), 1, 7))::bit(28)::int % 997)
              % (2 * p.noise + 1)) - p.noise
        ))::int as calls,
        ((('x' || substr(md5(g.d::date::text || p.code), 1, 7))::bit(28)::int % 997) / 11) % p.comp_mod as comp,
        (p.mail_base
         + ((('x' || substr(md5(g.d::date::text || p.code), 1, 7))::bit(28)::int % 997) / 3) % p.mail_span
         + case when (('x' || substr(md5(g.d::date::text || p.code), 1, 7))::bit(28)::int % 997) % 31 = 0
                then 45 else 0 end)::int as mails
      from generate_series(current_date - 90, current_date - 1, interval '1 day') as g(d)
      where extract(isodow from g.d) between 1 and 5           -- lundi vers vendredi
        and not (p.skip_fri and extract(isodow from g.d) = 5)  -- C ne prospecte pas le vendredi
        -- Absences : aucune ligne créée, ce n'est pas la même chose qu'un zéro.
        and not (p.code = 'A' and g.d::date between current_date - 33 and current_date - 27)   -- congés
        and not (p.code = 'B' and g.d::date between current_date - 17 and current_date - 13)   -- congés
        and not (p.code = 'B' and (('x' || substr(md5(g.d::date::text || p.code), 1, 7))::bit(28)::int % 997) % 17 = 0)
                                                                                              -- oublis de saisie
        and not (p.code = 'C' and g.d::date between current_date - 12 and current_date - 8)    -- congés
    ) s;

    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;

    ----------------------------------------------------------------------
    -- Les RDV, déduits des appels aboutis et bornés par eux
    ----------------------------------------------------------------------
    update public.daily_activity d set meetings_booked = least(
      d.calls_connected,
      round(d.calls_connected * (p.mr_start + (p.mr_end - p.mr_start)
            * ((d.activity_date - (current_date - 90))::numeric / 89)
            + ((('x' || substr(md5(d.activity_date::text || p.code), 1, 7))::bit(28)::int % 997) / 13 % 5) / 100.0))::int)
    where d.user_id = v_user and d.activity_date >= current_date - 90;

    raise notice 'Compte % (profil %) : % jours créés', p.email, p.code, v_rows;
  end loop;

  raise notice 'Total : % jours de démonstration', v_total;
end $$;


-- ============================================================================
--  REPÈRES NARRATIFS
--  Sans eux les courbes sont trop lisses, et rien ne donne envie de cliquer.
--  Toutes les notes sont suffixées [DÉMO] pour être reconnaissables.
-- ============================================================================
do $$
declare
  a uuid; b uuid; c uuid;
  d1 date; d2 date;
begin
  select user_id into a from public.profiles where email like '%+demo-santiago%'  and is_demo;
  select user_id into b from public.profiles where email like '%+demo2-santiago%' and is_demo;
  select user_id into c from public.profiles where email like '%+demo3-santiago%' and is_demo;

  -- A : deux jours de formation, saisis mais à zéro (à distinguer d'un jour non saisi)
  select min(activity_date) into d1 from public.daily_activity
   where user_id = a and activity_date >= current_date - 56;
  select min(activity_date) into d2 from public.daily_activity
   where user_id = a and activity_date > d1;
  update public.daily_activity set calls_made = 0, calls_connected = 0, meetings_booked = 0,
         emails_sent = 0, companies_created = 0, contacts_created = 0,
         notes = 'Formation produit sur deux jours, aucune prospection. [DÉMO]'
   where user_id = a and activity_date in (d1, d2);

  -- A : la journée record
  select min(activity_date) into d1 from public.daily_activity
   where user_id = a and activity_date >= current_date - 21;
  update public.daily_activity set calls_made = 78, calls_connected = 31, meetings_booked = 5,
         emails_sent = 41, companies_created = 8, contacts_created = 17,
         notes = 'Journée record : campagne secteur industrie, fichier très qualifié. [DÉMO]'
   where user_id = a and activity_date = d1;

  -- A : le retour de congés
  select min(activity_date) into d1 from public.daily_activity
   where user_id = a and activity_date > current_date - 27;
  update public.daily_activity set notes = 'Retour de congés, reprise du fichier en cours. [DÉMO]'
   where user_id = a and activity_date = d1;

  -- B : deux jours de salon. Peu d'appels, beaucoup de contacts : un cas où le
  --     score brut chute alors que la journée est excellente.
  select min(activity_date) into d1 from public.daily_activity
   where user_id = b and activity_date >= current_date - 45;
  select min(activity_date) into d2 from public.daily_activity
   where user_id = b and activity_date > d1;
  update public.daily_activity set calls_made = 9, calls_connected = 7, meetings_booked = 4,
         emails_sent = 88, companies_created = 12, contacts_created = 26,
         notes = 'Salon professionnel : peu d''appels, beaucoup de contacts collectés. [DÉMO]'
   where user_id = b and activity_date in (d1, d2);

  -- B : la reprise après congés
  select min(activity_date) into d1 from public.daily_activity
   where user_id = b and activity_date > current_date - 13;
  update public.daily_activity set notes = 'Reprise après congés, nouveau fichier ABM reçu du marketing. [DÉMO]'
   where user_id = b and activity_date = d1;

  -- C : le mi-temps assumé
  select min(activity_date) into d1 from public.daily_activity where user_id = c;
  update public.daily_activity set notes = 'Prospection à mi-temps : pas de phoning le vendredi (comité). [DÉMO]'
   where user_id = c and activity_date = d1;
end $$;


-- ============================================================================
--  CONTRÔLE. Les taux sont recalculés depuis les volumes agrégés, jamais en
--  moyennant des taux journaliers, et les moyennes portent sur les jours
--  actifs. C'est la règle du projet, elle s'applique aussi aux contrôles.
-- ============================================================================
select
  p.display_name                                                              as nom,
  count(*)                                                                    as jours_saisis,
  sum(d.calls_made)                                                           as appels,
  round(100.0 * sum(d.calls_connected) / nullif(sum(d.calls_made), 0), 1)     as taux_abouti_pct,
  sum(d.meetings_booked)                                                      as rdv,
  round(100.0 * sum(d.meetings_booked) / nullif(sum(d.calls_connected), 0), 1) as rdv_par_abouti_pct,
  round(sum(d.calls_made)::numeric / count(*), 1)                             as appels_par_jour_actif,
  round(sum(d.meetings_booked)::numeric / count(*), 2)                        as rdv_par_jour_actif,
  round((sum(d.calls_made) + 3 * sum(d.calls_connected) + 20 * sum(d.meetings_booked)
        + sum(d.emails_sent) + 2 * sum(d.companies_created)
        + 2 * sum(d.contacts_created))::numeric / count(*), 0)                as score_moyen_jour
from public.daily_activity d
join public.profiles p on p.user_id = d.user_id
where p.is_demo
group by p.display_name
order by p.display_name;
