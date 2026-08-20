-- ============================================================================
--  REMISE À ZÉRO — Cockpit BDR
--  Supprime les données de démonstration créées par seed-demo.sql.
--  À exécuter dans Supabase → SQL Editor → Run
-- ============================================================================

do $$
declare
    -- ⬇️⬇️  LA SEULE LIGNE À MODIFIER : le même e-mail que dans seed-demo.sql
    -- Par défaut on ne vide que le compte de démonstration : effacer par
    -- erreur les saisies d'un vrai BDR détruirait des semaines de travail.
    v_email text := 'bbartoli+demo@fluxym.com';
    -- ⬆️⬆️

    -- true  = supprime AUSSI la journée d'aujourd'hui et les objectifs (table rase)
    -- false = ne supprime que l'historique (≤ hier) et conserve votre saisie du jour
    v_tout_effacer boolean := false;

    v_user uuid;
    v_rows int;
begin
    select id into v_user from auth.users where lower(email) = lower(v_email);

    if v_user is null then
        raise exception 'Aucun utilisateur avec l''e-mail "%".', v_email;
    end if;

    if v_tout_effacer then
        delete from public.daily_activity where user_id = v_user;
        get diagnostics v_rows = row_count;
        delete from public.daily_targets where user_id = v_user;
        raise notice 'Table rase : % lignes supprimées, objectifs réinitialisés.', v_rows;
    else
        delete from public.daily_activity
        where user_id = v_user and activity_date <= current_date - 1;
        get diagnostics v_rows = row_count;
        raise notice 'Historique supprimé : % lignes. La journée du % est conservée.', v_rows, current_date;
    end if;
end $$;

-- ============================================================================
--  VÉRIFICATION — doit renvoyer 0 ligne (ou seulement la journée du jour)
-- ============================================================================
select activity_date, calls_made, calls_connected, meetings_booked,
       emails_sent, companies_created, contacts_created, productivity_score
from public.v_daily_kpi
order by activity_date desc;
