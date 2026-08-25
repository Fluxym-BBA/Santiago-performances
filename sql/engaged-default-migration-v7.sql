/* ==========================================================================
   COCKPIT BDR — MIGRATION v7
   « Ne pas saisir vaut zéro » pour les appels avec échange
   --------------------------------------------------------------------------
   Contexte
   La v6 a créé daily_activity.calls_engaged en NULLABLE, sans valeur par
   défaut, pour distinguer trois mois d'historique où la question n'était pas
   posée (NULL) d'une journée réellement sans conversation (0). Ce choix était
   juste pour l'historique et faux pour la suite : une journée saisie après le
   déploiement gardait NULL tant que personne ne touchait le compteur, donc
   elle était traitée comme « non mesurée » et faisait disparaître les taux
   d'échange de toute la période.

   Concrètement, il aurait fallu cliquer chaque jour sur le compteur, même pour
   dire zéro, sous peine de ne jamais voir la statistique. Aucun des six autres
   compteurs ne fonctionne comme ça : ne pas saisir d'e-mail vaut zéro e-mail,
   personne ne clique pour le confirmer.

   Décision
   La colonne prend un DEFAULT 0 : toute ligne créée à partir de maintenant est
   comptée sans aucun geste. La frontière entre « compté » et « pas encore
   compté » devient la DATE (25/08/2026, déclarée dans METRICS côté
   application), et non la présence d'une valeur.

   Rattrapage
   Les lignes du 25/08 créées avant cette migration sont passées à 0. Ce n'est
   pas une invention : au moment d'écrire, les seules lignes concernées ont
   zéro appel abouti, donc zéro échange est la vérité. Le bloc de contrôle en
   fin de fichier le vérifie AVANT d'écrire et s'arrête si ce n'est plus vrai.

   Ce qui n'est pas fait, volontairement
   Aucune contrainte n'interdit NULL après le 25/08. Une correction
   d'historique saisie plus tard doit rester possible, et l'application ignore
   de toute façon les journées antérieures à l'ouverture du compteur, même si
   elles portent une valeur.

   Ordre de déploiement
   Cette migration peut passer avant ou après le code. Le code sait déjà lire
   une valeur absente comme un zéro ; la migration ne fait que rendre la base
   franche et éviter que la page de saisie affiche « non mesuré » sur une
   journée du jour.
   ========================================================================== */

begin;

/* -- 1. Garde-fou -----------------------------------------------------------
   On refuse d'écrire des zéros sur une journée qui a eu des appels aboutis
   sans mesure d'échange : dans ce cas, zéro serait un mensonge et il faut
   trancher à la main. */
do $$
declare
    v_risque int;
begin
    select count(*) into v_risque
    from public.daily_activity
    where calls_engaged is null
      and activity_date >= date '2026-08-25'
      and calls_connected > 0;

    if v_risque > 0 then
        raise exception
            'Migration interrompue : % journée(s) postérieure(s) au 25/08/2026 ont des appels aboutis sans mesure d''échange. Les passer à zéro affirmerait qu''aucune conversation n''a eu lieu. Trancher ces lignes à la main avant de rejouer.',
            v_risque;
    end if;
end $$;

/* -- 2. Valeur par défaut --------------------------------------------------- */
alter table public.daily_activity
    alter column calls_engaged set default 0;

/* -- 3. Rattrapage des journées déjà créées depuis l'ouverture du compteur -- */
update public.daily_activity
   set calls_engaged = 0
 where calls_engaged is null
   and activity_date >= date '2026-08-25';

/* -- 4. Mémoire de la décision, lisible depuis la base --------------------- */
comment on column public.daily_activity.calls_engaged is
    'Appels aboutis ayant donné une conversation (au-delà des 30 premières secondes). DEFAULT 0 depuis la migration v7 : ne pas saisir vaut zéro, comme pour les autres compteurs. NULL ne subsiste que sur les journées antérieures au 25/08/2026, date d''ouverture du compteur, où la question n''était pas posée. L''application se fonde sur cette date et non sur la présence d''une valeur.';

commit;

/* -- 5. Contrôle ----------------------------------------------------------
   Trois lignes attendues : la valeur par défaut, le nombre de journées encore
   non comptées (toutes antérieures au 25/08), et l'absence de trou depuis. */
select 'defaut' as controle,
       coalesce(column_default, 'aucun') as valeur
  from information_schema.columns
 where table_schema = 'public' and table_name = 'daily_activity'
   and column_name = 'calls_engaged'
union all
select 'journees_null_avant_ouverture',
       count(*)::text
  from public.daily_activity
 where calls_engaged is null and activity_date < date '2026-08-25'
union all
select 'journees_null_depuis_ouverture_doit_valoir_0',
       count(*)::text
  from public.daily_activity
 where calls_engaged is null and activity_date >= date '2026-08-25';
