-- ============================================================================
--  BDR COCKPIT — Schéma initial (Supabase / PostgreSQL)
--  Projet : suivi quotidien de productivité BDR (Santiago)
--  Usage  : Supabase → SQL Editor → coller → Run
--  Auteur : généré pour Bruno BARTOLI — Fluxym
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) TABLE DE SAISIE : une seule ligne par utilisateur et par jour
--    Le couple (user_id, activity_date) est unique => permet l'UPSERT et
--    la modification d'un jour passé sans jamais créer de doublon.
-- ----------------------------------------------------------------------------
create table if not exists public.daily_activity (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid()
                            references auth.users (id) on delete cascade,
  activity_date date        not null default current_date,

  -- Carte « Enrichissement du CRM »
  companies_created integer not null default 0 check (companies_created >= 0),
  contacts_created  integer not null default 0 check (contacts_created  >= 0),

  -- Carte « Prospection » → sous-carte Appels téléphoniques
  calls_made        integer not null default 0 check (calls_made      >= 0),
  calls_connected   integer not null default 0 check (calls_connected >= 0),
  meetings_booked   integer not null default 0 check (meetings_booked >= 0),

  -- Carte « Prospection » → sous-carte E-mails de prospection
  emails_sent       integer not null default 0 check (emails_sent     >= 0),

  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint daily_activity_one_row_per_day unique (user_id, activity_date),
  -- cohérence métier : on ne peut pas avoir plus d'appels aboutis que d'appels
  constraint daily_activity_calls_coherent  check (calls_connected <= calls_made)
);

comment on table  public.daily_activity is 'Saisie quotidienne des actions de prospection (1 ligne / user / jour)';
comment on column public.daily_activity.calls_connected is 'Appels aboutis = décideur ou interlocuteur atteint';

-- ----------------------------------------------------------------------------
-- 2) OBJECTIFS JOURNALIERS (pour les jauges du dashboard)
-- ----------------------------------------------------------------------------
create table if not exists public.daily_targets (
  user_id                uuid primary key default auth.uid()
                         references auth.users (id) on delete cascade,
  companies_target       integer not null default 5,
  contacts_target        integer not null default 10,
  calls_made_target      integer not null default 40,
  calls_connected_target integer not null default 10,
  meetings_target        integer not null default 2,
  emails_target          integer not null default 30,
  updated_at             timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 3) updated_at automatique
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_daily_activity_updated_at on public.daily_activity;
create trigger trg_daily_activity_updated_at
  before update on public.daily_activity
  for each row execute function public.set_updated_at();

drop trigger if exists trg_daily_targets_updated_at on public.daily_targets;
create trigger trg_daily_targets_updated_at
  before update on public.daily_targets
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4) ROW LEVEL SECURITY — chacun ne voit et ne modifie que ses propres lignes
--    C'est LA seule barrière entre la clé anon (publique) et les données.
-- ----------------------------------------------------------------------------
alter table public.daily_activity enable row level security;
alter table public.daily_targets  enable row level security;

drop policy if exists "activity_select_own" on public.daily_activity;
create policy "activity_select_own" on public.daily_activity
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "activity_insert_own" on public.daily_activity;
create policy "activity_insert_own" on public.daily_activity
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "activity_update_own" on public.daily_activity;
create policy "activity_update_own" on public.daily_activity
  for update to authenticated using (user_id = auth.uid())
                                with check (user_id = auth.uid());

drop policy if exists "activity_delete_own" on public.daily_activity;
create policy "activity_delete_own" on public.daily_activity
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "targets_all_own" on public.daily_targets;
create policy "targets_all_own" on public.daily_targets
  for all to authenticated using (user_id = auth.uid())
                             with check (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 5) VUE KPI — taux et score de productivité calculés côté base
--    security_invoker = true  => la RLS de daily_activity s'applique bien.
-- ----------------------------------------------------------------------------
create or replace view public.v_daily_kpi
with (security_invoker = true) as
select
  d.id,
  d.user_id,
  d.activity_date,
  d.companies_created,
  d.contacts_created,
  d.calls_made,
  d.calls_connected,
  d.meetings_booked,
  d.emails_sent,
  d.notes,
  -- taux de mise en relation
  case when d.calls_made > 0
       then round(100.0 * d.calls_connected / d.calls_made, 1) end as connect_rate,
  -- taux de conversion appel abouti -> RDV
  case when d.calls_connected > 0
       then round(100.0 * d.meetings_booked / d.calls_connected, 1) end as meeting_rate,
  -- nombre d'appels nécessaires pour 1 RDV
  case when d.meetings_booked > 0
       then round(1.0 * d.calls_made / d.meetings_booked, 1) end as calls_per_meeting,
  d.calls_made + d.emails_sent + d.companies_created + d.contacts_created as total_actions,
  -- score pondéré : à ajuster avec Santiago
  (d.calls_made        * 1
 + d.calls_connected   * 3
 + d.meetings_booked   * 20
 + d.emails_sent       * 1
 + d.companies_created * 2
 + d.contacts_created  * 2) as productivity_score
from public.daily_activity d;

-- Meilleur jour de chaque utilisateur (pour le comparatif « aujourd'hui vs record »)
create or replace view public.v_best_day
with (security_invoker = true) as
select distinct on (user_id) *
from public.v_daily_kpi
order by user_id, productivity_score desc, activity_date desc;

-- ----------------------------------------------------------------------------
-- 6) FONCTION D'INCRÉMENT ATOMIQUE — pour les boutons « +1 » du front
--    Crée la ligne du jour si elle n'existe pas, puis incrémente.
--    Appel : supabase.rpc('bump_metric', { p_metric: 'calls_made', p_delta: 1 })
-- ----------------------------------------------------------------------------
create or replace function public.bump_metric(
  p_metric text,
  p_delta  integer default 1,
  p_date   date    default current_date
)
returns public.daily_activity
language plpgsql
as $$
declare
  r public.daily_activity;
begin
  if p_metric not in ('companies_created','contacts_created','calls_made',
                      'calls_connected','meetings_booked','emails_sent') then
    raise exception 'Métrique non autorisée : %', p_metric;
  end if;

  insert into public.daily_activity (user_id, activity_date)
  values (auth.uid(), p_date)
  on conflict (user_id, activity_date) do nothing;

  execute format(
    'update public.daily_activity
        set %1$I = greatest(0, %1$I + $1)
      where user_id = $2 and activity_date = $3
      returning *', p_metric)
  into r
  using p_delta, auth.uid(), p_date;

  return r;
end;
$$;

revoke all on function public.bump_metric(text, integer, date) from public, anon;
grant execute on function public.bump_metric(text, integer, date) to authenticated;

-- ----------------------------------------------------------------------------
-- 7) DROITS DATA API (utile si « Automatically expose new tables » est décoché)
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.daily_activity to authenticated;
grant select, insert, update, delete on public.daily_targets  to authenticated;
grant select on public.v_daily_kpi, public.v_best_day to authenticated;
-- Aucun droit pour le rôle anon : rien n'est lisible sans être connecté.
revoke all on public.daily_activity, public.daily_targets from anon;
