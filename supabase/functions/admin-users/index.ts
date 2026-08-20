/* ============================================================================
   ADMIN-USERS — Edge Function

   Ce qu'elle fait
   ---------------
   Créer un compte, changer un mot de passe, supprimer un compte, et lire les
   informations de connexion (dernière connexion, e-mail confirmé) qui ne sont
   pas exposées à l'application.

   Pourquoi une fonction et pas du code dans le navigateur
   ------------------------------------------------------
   Ces quatre gestes exigent la clé `service_role`, qui donne tous les droits
   sur la base et contourne toute la Row Level Security. Elle ne doit jamais
   quitter Supabase, donc jamais atterrir dans un dépôt public. Ici elle est
   lue depuis les variables d'environnement de la fonction : le navigateur ne
   la voit pas, ne la reçoit pas, ne peut pas la deviner.

   L'ORDRE DE VÉRIFICATION EST LE POINT CRITIQUE DE TOUT CE FICHIER
   ----------------------------------------------------------------
   1. lire le jeton de l'appelant
   2. le faire valider par Supabase (identité réelle, pas déclarée)
   3. lire son profil AVEC SES PROPRES DROITS et vérifier is_admin et is_active
   4. seulement alors, instancier le client `service_role`

   Le client privilégié est créé après la vérification, jamais avant. Un `return`
   oublié ou une inversion de deux lignes suffirait à transformer cette fonction
   en porte ouverte sur la base : c'est pour cette raison que l'étape 4 est
   isolée dans `elevated()` et qu'aucun autre endroit du fichier ne lit la clé.

   Déploiement (aucun outil à installer)
   -------------------------------------
   Supabase → Edge Functions → Deploy a new function → nom `admin-users` →
   coller ce fichier → Deploy. « Verify JWT » peut rester activé : la fonction
   refait de toute façon la vérification elle-même.
   ============================================================================ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VERSION = 'admin-users/1.0';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/* Garde-fou optionnel contre la faute de frappe sur le domaine : renseigner par
   exemple « fluxym.com » dans les secrets de la fonction pour n'autoriser que
   les adresses de l'entreprise. Vide ou absent = aucune restriction. */
const DOMAINS = (Deno.env.get('ALLOWED_EMAIL_DOMAINS') || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/* --------------------------------------------------------------------------
   CORS. L'origine est ouverte volontairement : aucune action n'est possible
   sans un jeton d'administrateur valide, et l'authentification passe par
   l'en-tête Authorization, jamais par un cookie. Il n'y a donc pas de
   falsification de requête entre sites possible ici.
   -------------------------------------------------------------------------- */
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' }
    });

const fail = (message: string, status = 400) => json({ error: message }, status);

/* --------------------------------------------------------------------------
   Mot de passe provisoire

   Il sera dicté au téléphone ou collé dans un message, donc lisible avant
   d'être long : trois groupes de quatre caractères, sans les caractères
   qu'on confond (0/O, 1/l/I). Alphabet de 30 signes sur 12 positions, soit
   environ 59 bits d'entropie, très au-delà de ce qu'exige un mot de passe
   destiné à être changé à la première connexion.
   -------------------------------------------------------------------------- */
function makePassword(): string {
    const A = 'abcdefghjkmnpqrstuvwxyz23456789';
    const n = new Uint32Array(12);
    crypto.getRandomValues(n);
    const c = [...n].map(x => A[x % A.length]);
    return `${c.slice(0, 4).join('')}-${c.slice(4, 8).join('')}-${c.slice(8, 12).join('')}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function checkEmail(raw: unknown): string {
    const email = String(raw || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error("Adresse e-mail invalide");
    if (DOMAINS.length) {
        const dom = email.split('@')[1];
        if (!DOMAINS.includes(dom)) {
            throw new Error(`Domaine non autorisé : ${dom}. Domaines admis : ${DOMAINS.join(', ')}`);
        }
    }
    return email;
}

function checkPassword(raw: unknown): { password: string; generated: boolean } {
    if (raw == null || String(raw).trim() === '') {
        return { password: makePassword(), generated: true };
    }
    const password = String(raw);
    if (password.length < 8) throw new Error('Le mot de passe doit faire au moins 8 caractères');
    return { password, generated: false };
}

const isUuid = (s: unknown) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

/* --------------------------------------------------------------------------
   ÉTAPE 4, ET ELLE N'EXISTE QU'ICI.
   Un seul endroit du fichier lit la clé privilégiée. Si un jour cette fonction
   grossit, la règle à tenir est simple : ne jamais appeler `elevated()` avant
   d'avoir obtenu un profil administrateur de `authorize()`.
   -------------------------------------------------------------------------- */
const elevated = () => createClient(URL_, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false }
});

/* --------------------------------------------------------------------------
   ÉTAPES 1 à 3. Renvoie le profil de l'appelant, ou lève.
   -------------------------------------------------------------------------- */
async function authorize(req: Request) {
    // 1) le jeton
    const auth = req.headers.get('Authorization') || '';
    const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!jwt) throw { status: 401, message: 'Authentification requise' };

    // 2) l'identité, validée par Supabase et non déduite du contenu du jeton :
    //    un JWT peut être fabriqué, sa signature non.
    const asCaller = createClient(URL_, ANON, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: u, error: uErr } = await asCaller.auth.getUser();
    if (uErr || !u?.user) throw { status: 401, message: 'Session invalide ou expirée' };

    // 3) le rôle, lu dans la base et avec les droits de l'appelant lui-même.
    //    Lire le profil sous l'identité de l'appelant plutôt qu'avec la clé
    //    privilégiée est délibéré : même une règle RLS mal écrite ne pourrait
    //    pas ici élargir ce qu'il a le droit de voir.
    const { data: me, error: pErr } = await asCaller
        .from('profiles')
        .select('user_id, email, display_name, is_admin, is_active')
        .eq('user_id', u.user.id)
        .maybeSingle();
    if (pErr) throw { status: 500, message: `Lecture du profil impossible : ${pErr.message}` };
    if (!me) throw { status: 403, message: 'Aucun profil associé à ce compte' };
    if (!me.is_active) throw { status: 403, message: 'Compte désactivé' };
    if (!me.is_admin) throw { status: 403, message: 'Action réservée aux administrateurs' };

    return me;
}

/* ==========================================================================
   ACTIONS
   ========================================================================== */

/** Comptes vus depuis auth : dernière connexion, e-mail confirmé. */
async function actionList(db: ReturnType<typeof elevated>) {
    const users: unknown[] = [];
    // La pagination est explicite : sans elle, seuls les 50 premiers comptes
    // remonteraient, et le bogue ne se verrait qu'au 51e utilisateur.
    for (let page = 1; page <= 20; page++) {
        const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw { status: 500, message: error.message };
        const batch = data?.users || [];
        batch.forEach(x => users.push({
            user_id: x.id,
            email: x.email,
            created_at: x.created_at,
            last_sign_in_at: x.last_sign_in_at ?? null,
            email_confirmed_at: x.email_confirmed_at ?? x.confirmed_at ?? null
        }));
        if (batch.length < 200) break;
    }
    return { users };
}

async function actionCreate(db: ReturnType<typeof elevated>, body: any, me: any) {
    const email = checkEmail(body.email);
    const { password, generated } = checkPassword(body.password);
    const display_name = String(body.display_name || '').trim();

    const { data, error } = await db.auth.admin.createUser({
        email,
        password,
        // Sans cette ligne le compte est créé mais ne peut pas se connecter, et
        // l'erreur ressemble à un mot de passe erroné. L'application n'envoie
        // aucun courriel : la confirmation doit donc être faite ici.
        email_confirm: true,
        user_metadata: {
            display_name: display_name || undefined,
            is_bdr: body.is_bdr !== false
        }
    });
    if (error) {
        const m = String(error.message || '');
        if (/already|exists|registered|duplicate/i.test(m)) {
            throw { status: 409, message: `Un compte existe déjà pour ${email}` };
        }
        throw { status: 400, message: m };
    }

    const userId = data.user!.id;

    // Le déclencheur handle_new_user a déjà créé le profil, en BDR et non
    // administrateur. On n'applique donc que les écarts demandés, et surtout
    // on ne recrée rien : la ligne existe.
    const patch: Record<string, unknown> = {
        is_admin: body.is_admin === true,
        is_bdr: body.is_bdr !== false,
        is_demo: body.is_demo === true,
        is_active: true
    };
    if (display_name) patch.display_name = display_name;

    const { data: prof, error: pErr } = await db
        .from('profiles').update(patch).eq('user_id', userId).select().maybeSingle();

    // Un profil manquant ici signifie que le déclencheur n'est pas installé.
    // Le compte existe déjà : mieux vaut créer la ligne que laisser un compte
    // orphelin impossible à administrer.
    if (!prof && !pErr) {
        await db.from('profiles').insert({
            user_id: userId, email,
            display_name: display_name || email.split('@')[0],
            ...patch
        });
    }

    return {
        user_id: userId, email, password, generated,
        created_by: me.email,
        profile: prof || null
    };
}

async function actionPassword(db: ReturnType<typeof elevated>, body: any) {
    if (!isUuid(body.user_id)) throw { status: 400, message: 'Identifiant de compte invalide' };
    const { password, generated } = checkPassword(body.password);

    const { data, error } = await db.auth.admin.updateUserById(String(body.user_id), {
        password,
        // Un compte dont l'e-mail n'aurait jamais été confirmé resterait bloqué
        // au moment de se connecter, sans rapport apparent avec le mot de passe.
        email_confirm: true
    });
    if (error) throw { status: 400, message: error.message };
    return { user_id: data.user!.id, email: data.user!.email, password, generated };
}

async function actionDelete(db: ReturnType<typeof elevated>, body: any, me: any) {
    const id = String(body.user_id || '');
    if (!isUuid(id)) throw { status: 400, message: 'Identifiant de compte invalide' };

    // Se supprimer soi-même n'a aucun cas d'usage légitime et laisse
    // l'administration dans un état incertain.
    if (id === me.user_id) {
        throw { status: 400, message: 'Vous ne pouvez pas supprimer votre propre compte' };
    }

    const { data: target } = await db
        .from('profiles').select('*').eq('user_id', id).maybeSingle();

    // Le dernier administrateur actif est protégé ici, et de nouveau par un
    // déclencheur dans la base. La double barrière est volontaire : une
    // suppression lancée depuis le tableau de bord Supabase ne passerait pas
    // par cette fonction.
    if (target?.is_admin && target?.is_active) {
        const { count } = await db
            .from('profiles').select('user_id', { count: 'exact', head: true })
            .eq('is_admin', true).eq('is_active', true).neq('user_id', id);
        if (!count) {
            throw { status: 409, message: 'Impossible : ce compte est le dernier administrateur actif' };
        }
    }

    // Compté avant, pour pouvoir dire ce qui a réellement disparu. La
    // suppression du compte efface l'activité en cascade.
    const { count: days } = await db
        .from('daily_activity').select('id', { count: 'exact', head: true }).eq('user_id', id);

    const { error } = await db.auth.admin.deleteUser(id);
    if (error) throw { status: 400, message: error.message };

    return {
        deleted: true,
        user_id: id,
        email: target?.email ?? null,
        display_name: target?.display_name ?? null,
        days_removed: days || 0
    };
}

/* ==========================================================================
   POINT D'ENTRÉE
   ========================================================================== */

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return fail('Méthode non autorisée', 405);

    if (!URL_ || !ANON || !SERVICE) {
        return fail('Fonction mal configurée : variables d\'environnement absentes', 500);
    }

    let me: any;
    try {
        me = await authorize(req);
    } catch (e: any) {
        return fail(e.message || 'Accès refusé', e.status || 403);
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return fail('Corps de requête illisible', 400);
    }

    const action = String(body?.action || '');

    try {
        const db = elevated();   // jamais avant authorize()
        switch (action) {
            case 'ping':     return json({ ok: true, version: VERSION, admin: me.email });
            case 'list':     return json(await actionList(db));
            case 'create':   return json(await actionCreate(db, body, me));
            case 'password': return json(await actionPassword(db, body));
            case 'delete':   return json(await actionDelete(db, body, me));
            default:         return fail(`Action inconnue : ${action || '(vide)'}`, 400);
        }
    } catch (e: any) {
        return fail(e?.message || 'Erreur inattendue', e?.status || 500);
    }
});
