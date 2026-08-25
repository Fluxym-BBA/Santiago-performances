-- ============================================================================
--  BDR COCKPIT — Migration v5 : écriture d'une valeur exacte (set_metric)
--  Usage : Supabase → SQL Editor → coller → Run. Idempotent, rejouable.
--
--  Ce script n'efface aucune donnée et ne touche à aucune contrainte.
--
--  LE BOGUE QU'ELLE CORRIGE
--  ------------------------
--  Taper « 10 » au clavier dans « Appels aboutis » sur une journée qui compte
--  déjà 13 appels passés renvoyait :
--      « Impossible : il y aurait plus d'appels aboutis que d'appels passés. »
--  alors que 10 <= 13. Le message était juste, la lecture qu'il invitait à
--  faire était fausse.
--
--  La cause n'est ni la contrainte ni le message, mais l'upsert partiel envoyé
--  par la page de saisie. PostgREST traduit
--      upsert({ user_id, activity_date, calls_connected: 10 })
--  en
--      insert into daily_activity (user_id, activity_date, calls_connected)
--      values (..., 10)
--      on conflict (user_id, activity_date) do update set calls_connected = ...
--
--  Or PostgreSQL évalue les contraintes CHECK sur la ligne PROPOSÉE, avant de
--  s'apercevoir du conflit et de basculer sur le UPDATE. Dans cette ligne
--  proposée, calls_made n'est pas fourni : il vaut son défaut, zéro. La base
--  contrôle donc 10 <= 0, refuse, et n'atteint jamais la ligne réelle qui
--  était parfaitement cohérente.
--
--  Vérifié le 25/08/2026 sur PostgreSQL 17 : le même upsert partiel sur une
--  table de test échoue en 23514 alors que la ligne existante est cohérente.
--
--  Conséquence : seule « Appels aboutis » était touchée, parce qu'elle est la
--  seule colonne dont la contrainte dépend d'une autre colonne. Les boutons
--  + / − n'étaient pas concernés : bump_metric crée la ligne à zéro d'abord,
--  puis fait un UPDATE, qui ne propose aucune ligne fantôme.
--
--  LA CORRECTION
--  -------------
--  set_metric applique la même mécanique que bump_metric, en absolu plutôt
--  qu'en relatif : créer la ligne si elle manque, puis mettre à jour la seule
--  colonne visée. La contrainte reste intacte et continue de refuser une
--  journée réellement incohérente, ce qui est son rôle.
--
--  La contrainte daily_activity_calls_coherent n'est PAS supprimée : elle est
--  voulue (voir Info IA/handover.md, section 7). Si les rappels entrants la
--  rendent gênante à l'usage, ce sera une décision explicite, pas un effet de
--  bord de ce script.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) ÉCRITURE D'UNE VALEUR EXACTE
--    p_user_id absent ou nul = pour soi. Renseigné et différent de soi = il
--    faut le droit d'écrire chez autrui, c'est-à-dire être propriétaire depuis
--    la migration v4. La RLS reste de toute façon la barrière réelle : cette
--    vérification ne fait que produire un message compréhensible au lieu d'un
--    UPDATE qui ne trouve aucune ligne.
-- ----------------------------------------------------------------------------
create or replace function public.set_metric(
  p_metric  text,
  p_value   integer,
  p_date    date default current_date,
  p_user_id uuid default null
)
returns public.daily_activity
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r      public.daily_activity;
  target uuid := coalesce(p_user_id, auth.uid());
begin
  -- La liste blanche est indispensable : le nom de colonne est injecté dans un
  -- format() plus bas. Sans elle, la fonction serait une porte d'entrée SQL.
  if p_metric not in ('companies_created','contacts_created','calls_made',
                      'calls_connected','meetings_booked','emails_sent') then
    raise exception 'Métrique non autorisée : %', p_metric;
  end if;

  if p_value is null or p_value < 0 then
    raise exception 'Valeur refusée : %', p_value;
  end if;

  if target is distinct from auth.uid() and not public.can_write_any() then
    raise exception 'Saisie pour un autre utilisateur réservée au propriétaire';
  end if;

  -- Cette insertion crée la journée avec des zéros partout, donc une ligne
  -- toujours cohérente. C'est exactement ce que l'upsert partiel ne savait
  -- pas faire.
  insert into public.daily_activity (user_id, activity_date)
  values (target, p_date)
  on conflict (user_id, activity_date) do nothing;

  execute format(
    'update public.daily_activity
        set %1$I = $1
      where user_id = $2 and activity_date = $3
      returning *', p_metric)
  into r
  using p_value, target, p_date;

  -- Zéro ligne mise à jour ne veut pas dire « rien à faire » : cela veut dire
  -- que la RLS a masqué la ligne. Le dire plutôt que renvoyer null, sinon le
  -- navigateur affiche une réussite silencieuse.
  if r.id is null then
    raise exception 'Journée introuvable ou modification refusée';
  end if;

  return r;
end;
$$;

revoke all on function public.set_metric(text, integer, date, uuid) from public, anon;
grant execute on function public.set_metric(text, integer, date, uuid) to authenticated;

comment on function public.set_metric(text, integer, date, uuid) is
  'Écrit une valeur exacte sur une métrique du jour. Crée la ligne à zéro si elle manque, puis met à jour la seule colonne visée : un upsert partiel serait refusé par la contrainte calls_connected <= calls_made, évaluée sur la ligne proposée avant la résolution du ON CONFLICT.';


-- ============================================================================
--  CONTRÔLE
--  Doit renvoyer une ligne : la fonction et ses droits.
-- ============================================================================
select
  p.proname                                as fonction,
  pg_get_function_arguments(p.oid)         as arguments,
  case when p.prosecdef then 'definer' else 'invoker' end as securite,
  has_function_privilege('authenticated', p.oid, 'execute') as executable_par_authenticated
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('set_metric', 'bump_metric')
order by p.proname;
