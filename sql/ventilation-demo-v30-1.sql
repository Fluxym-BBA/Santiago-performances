/* ===========================================================================
   v30.1 — VENTILATION DE L'HISTORIQUE DE DÉMONSTRATION
   30/08/2026, exécuté sur la base juste avant la migration v30.

   POURQUOI

   Le déclencheur de l'entonnoir ne bascule qu'au 27/08/2026 : avant cette date,
   il laisse les totaux tels quels et ne réclame aucune ventilation. Les quatre
   comptes de démonstration, semés du 27/02 au 26/08, avaient donc 428 journées
   avec un total d'appels aboutis et de rendez-vous, mais aucun détail par
   catégorie.

   La v30 fait porter les points par les catégories. Sans ventilation, ces 428
   journées perdaient 31 466 points : les courbes de démonstration s'écrasaient
   sur six mois, et l'aperçu de calibrage de l'écran Barème, qui repose
   précisément sur ces comptes faute d'autre matière abondante, n'avait plus rien
   à mesurer.

   CE QUI EST DÉDUIT ET CE QUI EST INVENTÉ, la distinction compte

   Déduit, exact : aboutis sans échange = calls_connected − calls_engaged. La
   donnée existe déjà, c'est de l'arithmétique.

   Inventé : la coupe entre nouveau contact et contact connu, et la part de
   rendez-vous reprogrammés. Une rotation déterministe sur le jour de l'année
   donne 60 / 40 sur les échanges et 20 / 60 / 20 sur les rendez-vous. Déterministe
   pour être reproductible à l'identique, et pour que le résultat varie d'un jour
   à l'autre au lieu d'appliquer partout le même ratio.

   NE JAMAIS ÉTENDRE CE SCRIPT AUX COMPTES RÉELS. Inventer le détail d'une
   journée réellement déclarée, c'est écrire à la place de la personne qui l'a
   saisie. Les deux journées de Dominique des 25 et 26/08 ont été laissées
   telles quelles, et c'est à elle de les reprendre si elle veut ses points.

   NEUTRALITÉ : le déclencheur recalcule les totaux depuis les catégories. Comme
   la ventilation conserve les sommes au point près, aucun total ne bouge et
   aucun score ne bouge, ni avant ni après la v30. Vérifié : 4 370 aboutis,
   2 868 échanges et 106 rendez-vous, avant comme après.

   ORDRE : avant la v30, pour qu'aucune courbe ne s'écrase même une seconde.
   =========================================================================== */

begin;

/* ---------------------------------------------------------------------------
   1. LES 428 JOURNÉES SANS AUCUN DÉTAIL
   --------------------------------------------------------------------------- */
with cible as (
  select d.user_id, d.activity_date,
         d.calls_connected as cc, d.calls_engaged as ce, d.meetings_booked as mb,
         extract(doy from d.activity_date)::int as j
    from public.daily_activity d
    join public.profiles p on p.user_id = d.user_id
   where p.is_demo = true
     and (coalesce(d.calls_dead_end,0) + coalesce(d.calls_engaged_new,0)
        + coalesce(d.calls_engaged_known,0) + coalesce(d.meetings_rescheduled,0)
        + coalesce(d.meetings_new,0) + coalesce(d.meetings_known,0)) = 0
     and (coalesce(d.calls_connected,0) + coalesce(d.calls_engaged,0)
        + coalesce(d.meetings_booked,0)) > 0
),
/* Une ligne par échange et par rendez-vous, chacun rangé dans une catégorie par
   rotation. generate_series en LATERAL avec LEFT JOIN : une journée à zéro
   rendez-vous ne produit aucune ligne de série et doit malgré tout survivre à
   la jointure, d'où le « on true » et les coalesce. */
ech as (
  select c.user_id, c.activity_date,
         coalesce(sum(case when (c.j + s.i) % 5 in (0,1,2) then 1 else 0 end), 0) as e_new,
         coalesce(sum(case when (c.j + s.i) % 5 in (3,4)   then 1 else 0 end), 0) as e_known
    from cible c
    left join lateral generate_series(0, c.ce - 1) s(i) on true
   group by c.user_id, c.activity_date
),
rdv as (
  select c.user_id, c.activity_date,
         coalesce(sum(case when (c.j + s.i) % 5 = 0        then 1 else 0 end), 0) as r_res,
         coalesce(sum(case when (c.j + s.i) % 5 in (1,2,3) then 1 else 0 end), 0) as r_new,
         coalesce(sum(case when (c.j + s.i) % 5 = 4        then 1 else 0 end), 0) as r_known
    from cible c
    left join lateral generate_series(0, c.mb - 1) s(i) on true
   group by c.user_id, c.activity_date
)
update public.daily_activity d
   set calls_dead_end       = c.cc - c.ce,
       calls_engaged_new    = e.e_new,
       calls_engaged_known  = e.e_known,
       meetings_rescheduled = r.r_res,
       meetings_new         = r.r_new,
       meetings_known       = r.r_known
  from cible c
  join ech e on e.user_id = c.user_id and e.activity_date = c.activity_date
  join rdv r on r.user_id = c.user_id and r.activity_date = c.activity_date
 where d.user_id = c.user_id
   and d.activity_date = c.activity_date;

/* ---------------------------------------------------------------------------
   2. LA JOURNÉE CONTRADICTOIRE

   BDR 1 le 26/08 déclarait 6 échanges pour 3 appels aboutis. Saisie à la main
   avant la bascule, donc jamais recalculée par le déclencheur. L'entonnoir y
   affichait un taux d'engagement de 200 %.

   La ligne n'avait aucun score « vrai » à préserver, puisqu'elle se contredisait.
   Elle est rendue cohérente : 6 aboutis dont 5 échanges, 2 rendez-vous. Écart de
   score : −1 point sur une journée de démonstration.

   Écrite en dur plutôt que devinée par une règle : une seule ligne, et une règle
   générale pour un cas unique aurait masqué le fait qu'il est unique.
   --------------------------------------------------------------------------- */
update public.daily_activity d
   set calls_dead_end       = 1,
       calls_engaged_new    = 3,
       calls_engaged_known  = 2,
       meetings_rescheduled = 0,
       meetings_new         = 1,
       meetings_known       = 1
  from public.profiles p
 where p.user_id = d.user_id
   and p.is_demo = true
   and p.display_name = 'BDR 1'
   and d.activity_date = date '2026-08-26';

commit;

/* ---------------------------------------------------------------------------
   CONTRÔLE APRÈS

   select p.is_demo, count(*) as journees,
          count(*) filter (where d.calls_connected <> coalesce(d.calls_dead_end,0)
                                 + coalesce(d.calls_engaged_new,0)
                                 + coalesce(d.calls_engaged_known,0)) as aboutis_incoherents,
          count(*) filter (where d.meetings_booked <> coalesce(d.meetings_rescheduled,0)
                                 + coalesce(d.meetings_new,0)
                                 + coalesce(d.meetings_known,0))      as rdv_incoherents
     from public.daily_activity d
     join public.profiles p on p.user_id = d.user_id
    group by p.is_demo;

   Attendu : zéro incohérence sur is_demo = true. Deux sur is_demo = false, les
   journées de Dominique des 25 et 26/08, laissées volontairement intactes.
   --------------------------------------------------------------------------- */
