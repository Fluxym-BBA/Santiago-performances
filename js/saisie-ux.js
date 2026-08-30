/* v25 — L'ergonomie de la maquette v2, appliquée pour de vrai.

   TROIS CHANGEMENTS PAR RAPPORT À LA v24.2

   1. Les onglets suivent le découpage de la maquette validée, et il est
      cohérent : les e-mails ne sont plus dans l'onglet des appels mais avec
      l'enrichissement du CRM. Ce sont les deux activités au clavier de la
      journée, elles se saisissent ensemble ; l'entonnoir téléphonique se
      saisit à part, avec le casque sur les oreilles.

   2. Le compteur de chaque onglet est calculé à partir des compteurs qu'il
      contient réellement, et non plus recopié d'un total de carte. Le total
      « prospection » écrit par saisie.js additionne les appels et les
      e-mails : recopié sur l'onglet des appels, il annonçait vingt-sept
      actions au-dessus de vingt et un appels.

   3. Les deux blocs de lecture de la maquette sont là : l'entonnoir du jour
      dans l'onglet des appels, et « d'où viennent les points » dans le bilan.
      Les deux sont calculés depuis ce qui est déjà à l'écran, sans une seule
      requête de plus.

   RAPPEL DE LA v24.2, qui reste vrai : les points d'un clic sont connus AVANT
   le clic.

   La version précédente lisait la variation de #day-score après coup. C'était
   fragile pour deux raisons, toutes deux constatées à l'écran :

     - paint() écrit le score en dernier, dans paintDerived(). Lire à la première
       mutation du DOM donnait donc zéro point, et zéro point déclenche l'effet le
       plus terne. Aucun clic n'a jamais dépassé le premier palier, pas même un
       rendez-vous à vingt-cinq points ;
     - le champ recevait deux animations : celle de flash() dans app.css, posée au
       clic, puis la nôtre au moment de la résolution. D'où un nombre qui bougeait
       deux fois, avec un temps de retard visible.

   Les points sont maintenant calculés à partir du barème lui-même, sans le
   dupliquer, et l'effet part dans le même geste que le clic. */
import { METRICS, METRIC_BY_KEY, SCORE_WEIGHTS } from './api.js';

(() => {
  'use strict';

  /* Un seul feu d'artifice toutes six secondes. Au-delà, un rendez-vous
     déclenche le palier intermédiaire. Sans ce plafond, quatre rendez-vous
     saisis d'affilée donnent quatre feux d'artifice, et l'effet devient une
     gêne au lieu d'une récompense. Mettre 0 pour n'en plafonner aucun. */
  /* Durée pendant laquelle une cinématique occupe l'écran, par palier. Ce n'est
     pas la durée de l'animation la plus longue mais celle au bout de laquelle
     une nouvelle peut partir sans se marcher dessus. */
  const FX_DUREE = { 0: 380, 1: 500, 2: 720, 3: 1400 };
  const SEUIL_PALIER_2 = 5;   /* points : en dessous, effet discret */
  const SEUIL_PALIER_3 = 16;  /* points : à partir de là, feu d'artifice */
  const CLE_ONGLET = 'cockpit_saisie_onglet';

  const reduced = window.matchMedia('(prefers-reduced-motion:reduce)').matches;

  /* Définition des onglets. L'ordre compte, il suit le déroulé de la journée.
     Un onglet dont toutes les cartes sont masquées par saisie.js (selon le
     métier de la personne) disparaît de lui-même : un BDR voit trois onglets,
     un commercial en voit quatre. */
  /* Définition des onglets, dans l'ordre de la maquette v2.

     `cartes`  les cartes de index.html à ranger dans le panneau ;
     `compte`  les compteurs dont la somme s'affiche sur l'étiquette. Ce sont des
               CLÉS DE MÉTRIQUE, pas un total de carte : c'est la seule façon que
               le nombre annoncé par l'onglet soit exactement celui de ce qu'il
               contient ;
     `total`   le total de carte que cette couche prend en charge, quand le
               découpage en onglets a rendu faux celui de saisie.js.

     Un onglet dont toutes les cartes sont masquées par saisie.js selon le métier
     de la personne disparaît de lui-même : un BDR voit trois onglets, un
     commercial en voit trois autres. */
  const ONGLETS = [
    { id:'appels', ico:'📞', couleur:'#00A7E1', titre:'Appels et rendez-vous',
      sous:'Passés, décrochés, rendez-vous obtenus', unite:'appels',
      cartes:['[data-card="prospection"]'],
      compte:['calls_made'],
      total:{ sel:'[data-total="prospection"]', cles:['calls_made'] } },

    { id:'crm', ico:'🗂️', couleur:'#6366f1', titre:'E-mails et CRM',
      sous:'Envois, entreprises, contacts', unite:'actions',
      cartes:['[data-card="emails"]', '[data-card="crm"]'],
      compte:['emails_sent', 'companies_created', 'contacts_created'],
      total:{ sel:'[data-total="emails"]', cles:['emails_sent'] } },

    { id:'vente', ico:'🤝', couleur:'#10b981', titre:'Cycle de vente',
      sous:'Événements et sorties de pipeline', unite:'actions',
      cartes:['[data-card="pipeline"]', '[data-card="outcome"]'],
      compte:['first_meetings', 'proposals_sent', 'no_go', 'deals_dropped', 'deals_lost'] },

    { id:'bilan', ico:'⚡', couleur:'#0ea5e9', titre:'Ce que la journée dit',
      sous:'Taux, points, note du jour', unite:'points',
      cartes:[], compte:null }
  ];

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  /* Masquage : on ne regarde jamais le style calculé, parce qu'une carte rangée
     dans un panneau inactif est calculée comme invisible alors qu'elle est bien
     là. On lit uniquement ce que saisie.js pose explicitement. */
  const estMasquee = el => !el || el.hidden || el.style.display === 'none'
    || el.getAttribute('aria-hidden') === 'true';

  const nombre = txt => {
    const n = parseInt(String(txt == null ? '' : txt).replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  };

  /* ---------------------------------------------------------------- canvas */
  let cv = null, cx = null, parts = [], raf = null;
  function canvas(){
    if(cv) return cv;
    cv = document.createElement('canvas');
    cv.id = 'ux-fx-canvas';
    cv.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cv);
    cx = cv.getContext('2d');
    const fit = () => {
      const r = window.devicePixelRatio || 1;
      cv.width = window.innerWidth * r; cv.height = window.innerHeight * r;
      cx.setTransform(r, 0, 0, r, 0, 0);
    };
    window.addEventListener('resize', fit);
    fit();
    return cv;
  }
  function salve(x, y, n, o){
    if(reduced) return;
    o = o || {};
    canvas();
    const C = o.couleurs || ['#00A7E1'];
    for(let i = 0; i < n; i++){
      const a = o.haut ? (-Math.PI / 2 + (Math.random() - .5) * (o.angle || 2.4))
                       : Math.random() * Math.PI * 2;
      const v = (o.vitesse || 3) * (0.45 + Math.random());
      parts.push({ x, y, vx:Math.cos(a) * v, vy:Math.sin(a) * v - (o.pousse || 0),
        g:o.g || 0.12, vie:o.vie || 58, max:o.vie || 58, t:o.taille || 4,
        c:C[Math.floor(Math.random() * C.length)],
        rot:Math.random() * 6, vr:(Math.random() - .5) * .35, carre:!!o.carre });
    }
    if(!raf) raf = requestAnimationFrame(boucle);
  }
  /* La boucle s'arrête dès qu'il n'y a plus une particule : aucun cycle
     d'animation ne tourne dans le vide, y compris sur un poste modeste. */
  function boucle(){
    const W = window.innerWidth, H = window.innerHeight;
    cx.clearRect(0, 0, W, H);
    parts = parts.filter(p => p.vie > 0 && p.y < H + 60);
    parts.forEach(p => {
      p.vy += p.g; p.vx *= .992; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vie--;
      cx.globalAlpha = Math.max(0, p.vie / p.max);
      cx.fillStyle = p.c;
      if(p.carre){
        cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
        cx.fillRect(-p.t / 2, -p.t / 2, p.t, p.t * 1.7); cx.restore();
      } else {
        cx.beginPath(); cx.arc(p.x, p.y, p.t / 2, 0, 6.3); cx.fill();
      }
    });
    cx.globalAlpha = 1;
    if(parts.length) raf = requestAnimationFrame(boucle);
    else { raf = null; cx.clearRect(0, 0, W, H); }
  }

  function bulle(x, y, texte, classe){
    const s = document.createElement('span');
    s.className = 'ux-fx-pop ' + classe;
    s.textContent = texte;
    if(classe === 'ux-fx-pop--l'){ s.style.left = '50%'; s.style.top = '34%'; }
    else { s.style.left = Math.max(8, x - 18) + 'px'; s.style.top = Math.max(8, y - 30) + 'px'; }
    document.body.appendChild(s);
    setTimeout(() => s.remove(), classe === 'ux-fx-pop--l' ? 1600 : 1100);
  }
  function anime(el, classe, duree){
    if(!el || reduced) return;
    el.classList.remove(classe);
    void el.offsetWidth;
    el.classList.add(classe);
    setTimeout(() => el.classList.remove(classe), duree || 1000);
  }

  /* Ce que vaut un clic sur ce compteur, en points.

     Le poids direct de la clé, plus le poids de chaque total dérivé qu'elle
     alimente. Un clic sur « Échange, nouveau contact » vaut donc le poids de
     l'appel abouti plus celui de l'appel avec échange, parce que METRICS déclare
     ces deux totaux comme dérivés de cette catégorie. Rien n'est écrit en dur :
     les dérivations viennent du champ « derived » de METRICS, les poids de
     SCORE_WEIGHTS, que loadScoreWeights() remplit depuis la base en mutant le
     tableau sur place, donc la référence importée ici reste la bonne. */
  function poidsDe(cle){
    const w = SCORE_WEIGHTS.find(x => x.key === cle);
    return w ? Number(w.w) || 0 : 0;
  }
  function pointsDuClic(cle){
    if(!cle) return 0;
    let p = poidsDe(cle);
    METRICS.forEach(m => {
      if(m.derived && m.derived.indexOf(cle) >= 0) p += poidsDe(m.key);
    });
    return p;
  }
  /* Trois paliers, les mêmes que les cinématiques : la couleur du bouton annonce
     l'effet qu'il va déclencher, et la pastille dit combien il rapporte. */
  function palierDe(points){ return points >= 10 ? 3 : points >= 4 ? 2 : 1; }

  /* Valeur affichée d'un compteur, lue à l'écran et jamais recalculée.

     Trois cas, dans cet ordre :
       - un total dérivé (appels aboutis, rendez-vous obtenus, appels avec
         échange) est la somme de ses parts. On refait l'addition plutôt que de
         lire le total affiché, exactement pour la raison expliquée dans
         paintDerived() de saisie.js : la réponse de la base arrive trois cents
         millisecondes après la frappe, et lire un total encore ancien afficherait
         un taux calculé sur l'avant-dernière valeur ;
       - un compteur saisissable a un champ #in-<clé> ;
       - un compteur du cycle de vente n'a pas de champ mais un #count-<clé>,
         puisque ses lignes viennent d'événements.
     Un compteur absent de l'écran, parce qu'il n'est pas du métier de la
     personne, vaut zéro sans faire d'histoire. */
  function valeurDe(cle){
    const m = METRIC_BY_KEY[cle];
    if(m && m.derived) return m.derived.reduce((t, k) => t + valeurDe(k), 0);
    const champ = document.getElementById('in-' + cle);
    if(champ) return nombre(champ.value);
    const compte = document.getElementById('count-' + cle);
    if(compte) return nombre(compte.textContent);
    return 0;
  }
  const somme = cles => (cles || []).reduce((t, k) => t + valeurDe(k), 0);

  /* Les libellés du barème sont réglables depuis la base : on les échappe avant
     de les injecter, comme partout ailleurs dans le projet. */
  const echappe = t => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /* Couleur de lecture d'un compteur. Reprise de la maquette validée : la même
     famille de bleus pour l'entonnoir téléphonique, le vert pour ce qui conclut,
     l'ambre et les violets pour le travail au clavier. */
  const COULEURS = {
    calls_made:'#00A7E1', calls_connected:'#0ea5e9', calls_engaged:'#0284c7',
    meetings_booked:'#10b981', first_meetings:'#10b981', proposals_sent:'#059669',
    emails_sent:'#f59e0b', companies_created:'#6366f1', contacts_created:'#8b5cf6'
  };
  const couleurDe = cle => COULEURS[cle] || 'var(--cyan)';

  /* La récompense dépend des points réellement gagnés, pas du compteur touché. */
  /* ON NE TOUCHE PLUS AU NOMBRE. app.css animait déjà le champ via flash(),
     appelée par onBump() dès le clic. Ajouter la nôtre par dessus faisait bouger
     le nombre une seconde fois, avec un décalage. Le retour immédiat sur le
     nombre est laissé à flash(), et nos effets portent sur la tuile, la bulle de
     points, le score et les confettis. */
  function celebre(points, x, y, metric){
    if(points <= 0){
      anime(metric, 'fx-p0', 400);
      return 0;
    }
    if(points < SEUIL_PALIER_2){
      anime(metric, 'fx-p1', 500);
      bulle(x, y, '+' + points + ' pt' + (points > 1 ? 's' : ''), 'ux-fx-pop--s');
      return 1;
    }
    if(points < SEUIL_PALIER_3){
      anime(metric, 'fx-p2', 700);
      bulle(x, y, '+' + points + ' pts', 'ux-fx-pop--m');
      salve(x, y, 14, { haut:true, vitesse:3.4, pousse:1.6, taille:4, vie:46,
        couleurs:['#00A7E1', '#0ea5e9', '#6ee7b7', '#a5f3fc'] });
      return 2;
    }
    /* Palier 3 : le jalon de la journée. */
    anime(metric, 'fx-p3', 1100);
    anime($('.ux-score'), 'ux-score--boom', 900);
    bulle(x, y, '🎉 +' + points + ' points', 'ux-fx-pop--l');
    const P = ['#fbbf24', '#f59e0b', '#10b981', '#00A7E1', '#6366f1', '#f472b6', '#ffffff'];
    const W = window.innerWidth, H = window.innerHeight;
    salve(x, y, 46, { haut:true, vitesse:6.2, pousse:3.4, taille:6, vie:80, carre:true, couleurs:P });
    setTimeout(() => salve(W * .24, H * .42, 40, { vitesse:5.4, taille:5, vie:78, carre:true, couleurs:P }), 160);
    setTimeout(() => salve(W * .76, H * .40, 40, { vitesse:5.4, taille:5, vie:78, carre:true, couleurs:P }), 300);
    setTimeout(() => salve(W * .50, H * .28, 52, { vitesse:6.8, taille:6, vie:88, carre:true, couleurs:P }), 440);
    return 3;
  }

  /* --------------------------------------------------- une seule à la fois

     PROBLÈME OBSERVÉ EN LIGNE : deux rendez-vous cliqués coup sur coup ne
     donnaient pas deux fois le feu d'artifice. La v24 limitait le palier 3 à
     une fois toutes les six secondes, pour éviter qu'une saisie en rafale ne
     transforme l'écran en 14 juillet permanent. Sauf que ce garde-fou est
     invisible : pour qui clique, la récompense devient imprévisible, et une
     récompense imprévisible ne récompense plus rien.

     Remplacé par un verrou honnête : une cinématique à la fois, et les clics
     qui arrivent pendant qu'elle joue sont CUMULÉS puis joués ensemble à la
     fin. Trois conséquences, toutes voulues :

       - deux rendez-vous cliqués lentement donnent deux feux d'artifice ;
       - quatre rendez-vous cliqués en rafale, typiquement une saisie de fin de
         journée, donnent un seul feu d'artifice de cent points, plus gros que
         chacun des quatre ;
       - le cumul peut faire monter de palier. Douze appels cliqués vite valent
         douze points et déclenchent le feu d'artifice, ce qu'un seul appel ne
         fait jamais. C'est exactement ce qu'on veut encourager.

     Le retrait ne passe pas par la file : il est court, terne, et corriger une
     erreur ne doit jamais attendre son tour. */
  let fxOccupe = false, fxAttente = null;

  function fete(points, x, y, metric){
    if(fxOccupe){
      if(fxAttente){
        fxAttente.points += points;
        fxAttente.x = x; fxAttente.y = y; fxAttente.metric = metric;
      } else fxAttente = { points:points, x:x, y:y, metric:metric };
      return;
    }
    fxOccupe = true;
    const palier = celebre(points, x, y, metric) || 0;
    setTimeout(() => {
      fxOccupe = false;
      if(!fxAttente) return;
      const f = fxAttente;
      fxAttente = null;
      fete(f.points, f.x, f.y, f.metric);
    }, FX_DUREE[palier] || 500);
  }

  /* ------------------------------------------------------- lecture du score
     Le score est celui que saisie.js écrit dans #day-score. On ne le calcule
     pas, on l'observe : c'est ce qui garantit que la récompense correspond
     exactement au barème en vigueur. */
  const lireScore = () => nombre($('#day-score') ? $('#day-score').textContent : 0);

  /* Le clic déclenche l'effet immédiatement, avec les points du barème. Plus
     d'attente, plus d'observation du score : la récompense part dans le même
     geste que le chiffre qui monte.

     Capture, et jamais d'interception : on ne fait que lire l'événement, les
     écouteurs de saisie.js reçoivent le clic intact. */
  document.addEventListener('click', ev => {
    const btn = ev.target.closest && ev.target.closest('.stepper-btn');
    if(!btn || btn.disabled) return;
    const metric = btn.closest('.metric');
    const cle = btn.dataset.key || (metric && metric.dataset.metric);

    if(btn.classList.contains('stepper-btn--minus')){
      /* Le retrait a sa cinématique propre, volontairement terne : corriger ne se
         récompense pas, mais on doit voir ce qu'on vient de perdre. */
      const perdus = pointsDuClic(cle);
      anime(metric, 'fx-minus', 400);
      bulle(ev.clientX, ev.clientY,
        perdus > 0 ? '\u2212' + perdus + ' pts' : 'retiré', 'ux-fx-pop--minus');
      return;
    }
    fete(pointsDuClic(cle), ev.clientX, ev.clientY, metric);
  }, true);

  /* Saisie directe au clavier. Un seul nombre tapé peut valoir plusieurs
     incréments : les points sont multipliés par l'écart réellement saisi. */
  document.addEventListener('change', ev => {
    const champ = ev.target.closest && ev.target.closest('.metric-input');
    if(!champ) return;
    const avant = nombre(champ.dataset.uxAvant);
    const apres = nombre(champ.value);
    champ.dataset.uxAvant = apres;
    if(apres === avant) return;
    const r = champ.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top;
    const metric = champ.closest('.metric');
    const unite = pointsDuClic(champ.dataset.key);

    /* Un nombre tapé plus grand qu'avant vaut exactement autant de clics : la
       personne qui saisit ses quarante appels d'un coup en fin de journée a le
       droit à la même récompense que celle qui a cliqué quarante fois. */
    if(apres > avant){ fete(unite * (apres - avant), x, y, metric); return; }

    /* Un nombre corrigé vers le bas prend la cinématique terne du retrait, pour
       la même raison qu'au clic : on doit voir ce qu'on vient de perdre. */
    const perdus = unite * (avant - apres);
    anime(metric, 'fx-minus', 400);
    bulle(x, y, perdus > 0 ? '\u2212' + perdus + ' pts' : 'corrigé', 'ux-fx-pop--minus');
  }, true);

  /* La valeur d'avant est mémorisée à la prise de focus : sans elle, impossible
     de savoir si l'on a tapé 12 en partant de 0 ou de 11. */
  document.addEventListener('focusin', ev => {
    const champ = ev.target.closest && ev.target.closest('.metric-input');
    if(champ) champ.dataset.uxAvant = nombre(champ.value);
  }, true);

  /* ------------------------------------------------------------- onglets */
  let barre = null, panneaux = {}, actif = null;

  function grille(){ return $('.cards-grid--saisie'); }

  function construire(){
    const g = grille();
    if(!g || barre) return false;

    /* Quelles cartes existent, et lesquelles saisie.js a-t-il masquées ? */
    const plan = ONGLETS.map(o => {
      let cartes = [];
      o.cartes.forEach(sel => { const el = $(sel, g); if(el) cartes.push(el); });
      if(o.id === 'bilan'){
        const sc = $('#day-score', g);
        const carte = sc ? sc.closest('.card') : null;
        if(carte) cartes = [carte];
      }
      return { o, cartes, visible:cartes.some(c => !estMasquee(c)) };
    }).filter(p => p.cartes.length > 0);

    if(plan.filter(p => p.visible).length < 2) return false; /* rien à onglet-er */

    barre = document.createElement('nav');
    barre.className = 'ux-tabs';
    barre.setAttribute('role', 'tablist');
    barre.setAttribute('aria-label', 'Sections de la saisie du jour');
    const liste = document.createElement('div');
    liste.className = 'ux-tabs-list';
    barre.appendChild(liste);

    const score = document.createElement('div');
    score.className = 'ux-score';
    score.innerHTML = '<span class="ux-score-n" id="ux-score-n">0</span>'
      + '<span class="ux-score-t"><span>Score du jour</span><i id="ux-score-i">mis à jour à chaque saisie</i></span>';
    barre.appendChild(score);

    g.parentNode.insertBefore(barre, g);

    plan.forEach(p => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ux-tab';
      b.dataset.ux = p.o.id;
      b.style.setProperty('--ux-c', p.o.couleur);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', 'false');
      b.innerHTML = '<span class="ux-tab-ico">' + p.o.ico + '</span>'
        + '<span class="ux-tab-txt"><b></b><span></span></span>'
        + '<span class="ux-tab-num"><b>0</b><span></span></span>';
      $('.ux-tab-txt b', b).textContent = p.o.titre;
      $('.ux-tab-txt span', b).textContent = p.o.sous;
      $('.ux-tab-num span', b).textContent = p.o.unite;
      b.hidden = !p.visible;
      b.addEventListener('click', () => montrer(p.o.id));
      b.addEventListener('keydown', e => {
        if(e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const vis = $$('.ux-tab', liste).filter(x => !x.hidden);
        const i = vis.indexOf(b);
        const n = vis[i + (e.key === 'ArrowRight' ? 1 : -1)];
        if(n){ montrer(n.dataset.ux); n.focus(); }
      });
      liste.appendChild(b);

      const pan = document.createElement('div');
      /* Une classe par onglet : la maquette ne met pas les mêmes colonnes dans
         l'entonnoir téléphonique et dans le bilan. */
      pan.className = 'ux-panel ux-panel--' + p.o.id;
      pan.dataset.ux = p.o.id;
      pan.setAttribute('role', 'tabpanel');
      g.appendChild(pan);
      p.cartes.forEach(c => pan.appendChild(c)); /* déplacement, pas recréation */
      poserBlocs(p.o.id, pan);
      panneaux[p.o.id] = { pan, bouton:b, conf:p.o, cartes:p.cartes };
    });

    document.body.classList.add('ux-on');
    calerHauteur();
    const memoire = (() => { try { return localStorage.getItem(CLE_ONGLET); } catch(e){ return null; } })();
    montrer(panneaux[memoire] && !panneaux[memoire].bouton.hidden ? memoire
      : plan.filter(p => p.visible)[0].o.id);
    rafraichir();
    return true;
  }

  function montrer(id){
    if(!panneaux[id]) return;
    actif = id;
    Object.keys(panneaux).forEach(k => {
      const e = panneaux[k];
      e.pan.classList.toggle('is-on', k === id);
      e.bouton.setAttribute('aria-selected', String(k === id));
    });
    try { localStorage.setItem(CLE_ONGLET, id); } catch(e){ /* mode privé */ }
  }

  /* Décalage de la barre collante : mesuré, jamais devinée, pour ne pas passer
     sous l'en-tête du site s'il devient collant un jour. */
  function calerHauteur(){
    let h = 0;
    $$('header, .site-header, .topbar, .nav-main').forEach(el => {
      const st = getComputedStyle(el);
      if(st.position === 'sticky' || st.position === 'fixed'){
        h = Math.max(h, el.getBoundingClientRect().height);
      }
    });
    document.documentElement.style.setProperty('--ux-top', h + 'px');
  }

  /* ---------------------------------------------------- valeur de chaque geste

     La maquette validée affiche sur chaque compteur ce que le geste rapporte.
     Ce n'est pas de la décoration : un BDR qui voit « 25 pts » sur le rendez-vous
     et « 1 pt » sur l'appel comprend en un regard où est la valeur de sa journée,
     sans aller lire l'écran Barème.

     La pastille est insérée dans le .stepper, entre le chiffre et les boutons.
     Deux raisons : le coin haut droit de la tuile est déjà pris par l'œil de
     visibilité, et cet espace-là était justement vide, ce qui donnait la
     sensation que les boutons flottaient loin du nombre.

     Rien n'est ajouté dans saisie.js : ces pastilles sont posées après coup et
     reposées si buildCards() reconstruit les cartes. */
  let enPose = false;
  function poserPastilles(){
    /* GARDE-FOU. Ces pastilles sont insérées DANS la grille, et c'est cette même
       grille qu'un MutationObserver surveille pour rafraîchir les onglets. Sans
       ce drapeau, poser une pastille déclencherait l'observateur, qui rappellerait
       cette fonction. Les comparaisons ci-dessous suffisent à faire converger la
       boucle en un tour, mais mieux vaut ne pas la laisser s'ouvrir du tout. */
    if(enPose) return;
    enPose = true;
    try { posePastilles(); } finally { enPose = false; }
  }
  function posePastilles(){
    $$('.metric[data-metric]').forEach(m => {
      const st = $('.stepper', m);
      if(!st) return;                      /* total calculé ou ligne d'événement */
      const cle = m.dataset.metric;
      const pts = pointsDuClic(cle);
      const pal = palierDe(pts);
      if(String(m.dataset.uxPalier) !== String(pal)) m.dataset.uxPalier = pal;
      let b = $('.ux-pts', st);
      if(!b){
        b = document.createElement('span');
        b.className = 'ux-pts';
        b.setAttribute('aria-hidden', 'true');   /* déjà dit par l'écran Barème */
        const champ = $('.metric-input', st);
        if(champ && champ.nextSibling) st.insertBefore(b, champ.nextSibling);
        else st.appendChild(b);
      }
      const txt = pts > 0 ? pts + (pts > 1 ? ' pts' : ' pt') : '';
      if(b.textContent !== txt) b.textContent = txt;
      b.hidden = !txt;
    });
  }

  /* ------------------------------------------- les deux blocs de lecture (v25)

     La maquette validée ne se contente pas de compter : elle donne à lire. Deux
     blocs, tous les deux calculés à partir de ce qui est DÉJÀ à l'écran, donc
     sans une requête de plus et sans rien ajouter à la base.

       l'entonnoir du jour        onglet des appels, colonne de droite
       d'où viennent les points   onglet du bilan

     Les autres blocs de la maquette qui manquent encore, l'histogramme des
     quatorze derniers jours, la série de saisie et l'anneau d'objectif, ont
     tous besoin de données que cet écran ne charge pas. Ils sont volontairement
     laissés de côté ici plutôt que remplis de chiffres inventés.

     RÈGLE D'ÉCRITURE, la même que pour les pastilles : on ne réécrit un bloc que
     si son contenu a changé. Ces blocs vivent dans la grille surveillée par
     l'observateur ; écrire à chaque passage relancerait l'observateur en boucle. */
  let boiteEntonnoir = null, boitePoints = null;
  let dernierEntonnoir = '', dernierPoints = '';

  function boite(titre, classe){
    const d = document.createElement('div');
    d.className = 'ux-box ' + classe;
    d.innerHTML = '<div class="ux-box-h"></div><div class="ux-box-b"></div>';
    $('.ux-box-h', d).textContent = titre;
    return d;
  }

  let colonneTotaux = null;

  function poserBlocs(id, pan){
    if(id === 'appels'){
      const col = document.createElement('div');
      col.className = 'ux-col';
      colonneTotaux = document.createElement('div');
      colonneTotaux.className = 'ux-tots';
      boiteEntonnoir = boite("L'entonnoir du jour", 'ux-box--funnel');
      col.appendChild(colonneTotaux);
      col.appendChild(boiteEntonnoir);
      pan.appendChild(col);
    }
    if(id === 'bilan') rangerBilan(pan);
  }

  /* Les totaux calculés quittent l'en-tête de leur étage pour la colonne de
     droite. Ils sont DÉPLACÉS : #total-calls_connected, #gauge-meetings_booked
     et l'œil de chacun gardent leur identifiant, donc saisie.js continue de les
     peindre sans savoir qu'ils ont changé de place.

     Appelée à chaque rafraîchissement et pas seulement au démarrage : si
     buildCards() reconstruit les cartes, les totaux repoussent dans leur
     en-tête et cette fonction les remet où il faut. Elle ne fait rien quand il
     n'y a rien à déplacer, donc elle ne coûte rien. */
  function deplacerTotaux(){
    if(!colonneTotaux) return;
    const restes = document.querySelectorAll('.etage-head > .etage-tot');
    if(!restes.length) return;
    restes.forEach(tot => {
      const cle = tot.dataset.metric;
      const pts = pointsDuClic(cle);
      if(pts > 0 && !$('.ux-pts', tot)){
        const b = document.createElement('span');
        b.className = 'ux-pts';
        b.setAttribute('aria-hidden', 'true');
        b.textContent = pts + (pts > 1 ? ' pts' : ' pt');
        tot.appendChild(b);
      }
      colonneTotaux.appendChild(tot);
    });
  }

  /* Le bilan reprend la disposition de la maquette : les taux en tuiles sur une
     rangée, puis deux colonnes, les points à gauche et la note à droite.

     TOUT EST DÉPLACÉ, RIEN N'EST RECRÉÉ. #kpi-connect, #kpi-engage, #kpi-meeting,
     #kpi-effort, #kpi-prev, #day-notes et #score-explain gardent leurs
     identifiants et leur place dans le document : saisie.js continue d'écrire
     dedans sans savoir que le décor a changé. C'est aussi pour cela qu'aucun taux
     n'est recalculé ici : il n'y a qu'un seul endroit qui les calcule. */
  function rangerBilan(pan){
    const corps = $('.card-body', pan);
    if(!corps || corps.dataset.uxRange) return;
    corps.dataset.uxRange = '1';

    const taux = ['#kpi-connect', '#kpi-engage', '#kpi-meeting', '#kpi-effort', '#kpi-prev']
      .map(sel => { const el = $(sel, corps); return el ? el.closest('.metric') : null; })
      .filter(Boolean);
    if(taux.length){
      const g = document.createElement('div');
      g.className = 'ux-rates';
      corps.insertBefore(g, corps.firstChild);
      taux.forEach(m => g.appendChild(m));
    }

    const deux = document.createElement('div');
    deux.className = 'ux-bilan-2';

    boitePoints = boite("D'où viennent les points", 'ux-box--points');
    deux.appendChild(boitePoints);

    const zone = $('#day-notes', corps);
    if(zone){
      const note = boite('📝 Note du jour', 'ux-box--note');
      const titre = zone.previousElementSibling;
      if(titre && titre.classList.contains('subcard-title')) titre.remove();
      $('.ux-box-b', note).appendChild(zone);
      deux.appendChild(note);
    }

    corps.appendChild(deux);
    /* Le « comment est calculé ce score ? » repasse en dernier : c'est un replié
       de référence, il n'a rien à faire entre les taux et la note. */
    const expl = $('#score-explain', corps);
    if(expl) corps.appendChild(expl);
  }

  /* L'entonnoir du jour. Quatre barres et trois taux, calculés sur les valeurs
     de l'écran. Il ne remplace pas les taux du bilan : ici on lit des VOLUMES qui
     se rétrécissent, là-bas des POURCENTAGES. La maquette montrait les deux, et
     c'est le dessin qui fait comprendre le métier en un coup d'œil. */
  function peindreEntonnoir(){
    if(!boiteEntonnoir) return;
    const dispo = !!document.getElementById('in-calls_made');
    if(boiteEntonnoir.hidden !== !dispo) boiteEntonnoir.hidden = !dispo;
    if(!dispo) return;

    const a = valeurDe('calls_made'), b = valeurDe('calls_connected'),
          e = valeurDe('calls_engaged'), r = valeurDe('meetings_booked');
    /* Largeurs rapportées aux appels passés, avec un plancher de 5 % : une barre
       de zéro pixel de large ne se lit pas comme un zéro, elle se lit comme un
       bogue d'affichage. Le nombre est de toute façon écrit à droite. */
    const max = Math.max(a, 1);
    const l = n => Math.max(5, Math.round(n / max * 100));
    const pc = (x, y) => y > 0 ? Math.round(x / y * 100) + ' %' : '–';
    const ligne = (lab, n, w, c) =>
      '<div class="ux-f-row"><span class="ux-f-lab">' + lab + '</span>'
      + '<span class="ux-f-track"><span class="ux-f-fill" style="width:' + w + '%;background:' + c + '">'
      + (n > 0 ? n : '') + '</span></span><span class="ux-f-n">' + n + '</span></div>';
    const inter = (g1, d1) => '<div class="ux-f-rate"><span>' + g1 + '</span><span>' + d1 + '</span></div>';

    const html =
      ligne('Appels passés', a, l(a), '#00A7E1')
      + inter('soit', '<b>' + pc(b, a) + '</b> de décrochés')
      + ligne('Décrochés', b, l(b), '#0ea5e9')
      + inter('dont', '<b>' + pc(e, b) + '</b> avec un vrai échange')
      + ligne('Avec échange', e, l(e), '#0284c7')
      + inter('qui donnent', '<b>' + pc(r, e) + '</b> de rendez-vous'
              + (r > 0 ? ' · ' + Math.round(a / r) + ' appels par rendez-vous' : ''))
      + ligne('Rendez-vous', r, l(r), '#10b981');

    if(html === dernierEntonnoir) return;
    dernierEntonnoir = html;
    $('.ux-box-b', boiteEntonnoir).innerHTML = html;
  }

  /* D'où viennent les points. Le barème vient de la base, les valeurs de
     l'écran : ce bloc dit donc toujours la vérité du jour, y compris après un
     réglage dans l'écran Barème.

     Le total affiché en bas est la somme des lignes, et non le score lu dans
     #day-score. Les deux doivent être égaux ; s'ils divergent un jour, c'est un
     écart réel entre le barème du navigateur et celui de la vue SQL, et il vaut
     mieux le voir que le masquer en recopiant le score. */
  function peindrePoints(){
    if(!boitePoints) return;
    const lignes = SCORE_WEIGHTS
      .map(w => ({ cle:w.key, icone:w.icon, label:w.label, poids:Number(w.w) || 0, v:valeurDe(w.key) }))
      .filter(x => x.poids > 0 && x.v > 0)
      .map(x => { x.pts = x.v * x.poids; return x; })
      .sort((x, y) => y.pts - x.pts);
    const total = lignes.reduce((t, x) => t + x.pts, 0);

    const html = lignes.length
      ? lignes.map(x => {
          const part = total > 0 ? Math.round(x.pts / total * 100) : 0;
          return '<div class="ux-sr" style="--ux-tc:' + couleurDe(x.cle) + '">'
            + '<span>' + echappe(x.icone) + '</span>'
            + '<span class="ux-sr-l">' + echappe(x.label) + '</span>'
            + '<span class="ux-sr-c">' + x.v + ' × ' + x.poids + '</span>'
            + '<span class="ux-sr-v">' + x.pts + ' pts</span>'
            + '<span class="ux-sr-share"><i style="width:' + part + '%"></i></span></div>';
        }).join('')
        + '<div class="ux-sr ux-sr--tot"><span>Σ</span><span class="ux-sr-l">Total du jour</span>'
        + '<span class="ux-sr-c"></span><span class="ux-sr-v">' + total + ' pts</span></div>'
      : '<p class="ux-vide">Rien de saisi pour le moment. Le premier appel du jour vaut déjà un point.</p>';

    if(html === dernierPoints) return;
    dernierPoints = html;
    $('.ux-box-b', boitePoints).innerHTML = html;
  }

  /* Les deux totaux de carte que cette couche reprend à sa charge.

     saisie.js écrit dans [data-total="prospection"] la somme des appels ET des
     e-mails, ce qui était juste quand les deux vivaient dans la même carte. Ils
     sont maintenant dans deux cartes et deux onglets : le nombre affiché en
     face de « Appels et rendez-vous » doit être celui des appels.

     On ne se bat pas avec saisie.js sur le même nœud : son total est masqué par
     la feuille de style et le nôtre est écrit à côté. Sinon la valeur clignoterait
     de 27 à 21 à chaque enregistrement. Sans le script, la feuille ne s'applique
     pas et le total d'origine réapparaît tel quel. */
  function peindreTotaux(){
    Object.keys(panneaux).forEach(k => {
      const conf = panneaux[k].conf;
      if(!conf.total) return;
      const src = $(conf.total.sel);
      if(!src) return;
      let mien = src.nextElementSibling;
      if(!mien || !mien.classList.contains('ux-total')){
        mien = document.createElement('span');
        mien.className = 'ux-total';
        src.parentNode.insertBefore(mien, src.nextSibling);
      }
      const txt = String(somme(conf.total.cles));
      if(mien.textContent !== txt) mien.textContent = txt;
    });
  }

  /* Chiffres des onglets, pastille « rien de saisi », score en miroir. */
  function rafraichir(){
    poserPastilles();
    deplacerTotaux();
    peindreTotaux();
    peindreEntonnoir();
    peindrePoints();
    const sc = lireScore();
    const n = $('#ux-score-n');
    if(n && n.textContent !== String(sc)) n.textContent = sc;
    Object.keys(panneaux).forEach(k => {
      const e = panneaux[k];
      /* Le nombre de l'onglet est la somme de SES compteurs, calculée ici. La
         v24 recopiait un total de carte, et l'onglet des appels annonçait la
         somme des appels et des e-mails. L'onglet du bilan, lui, n'a pas de
         compteur : il affiche le score. */
      const v = e.conf.compte ? somme(e.conf.compte) : sc;
      const cible = $('.ux-tab-num b', e.bouton);
      if(cible && cible.textContent !== String(v)) cible.textContent = v;
      /* Un onglet masqué par le métier reste masqué. */
      e.bouton.hidden = !e.cartes.some(c => !estMasquee(c));
      const manque = v === 0 && k !== 'bilan' && !e.bouton.hidden;
      let point = $('.ux-tab-todo', e.bouton);
      if(manque && !point){
        point = document.createElement('span');
        point.className = 'ux-tab-todo';
        point.title = 'Rien de saisi dans cette section';
        e.bouton.appendChild(point);
      } else if(!manque && point){ point.remove(); }
    });
    /* Si l'onglet actif vient d'être masqué, on bascule sur le premier visible. */
    if(actif && panneaux[actif] && panneaux[actif].bouton.hidden){
      const libre = Object.keys(panneaux).find(k => !panneaux[k].bouton.hidden);
      if(libre) montrer(libre);
    }
  }

  /* saisie.js construit les cartes après avoir chargé la journée : on attend
     que la grille soit peuplée, puis on observe pour rester à jour. */
  function demarrer(){
    if(construire()){
      const g = grille();
      const obs = new MutationObserver(() => { rafraichir(); });
      obs.observe(g, { childList:true, subtree:true, characterData:true, attributes:true,
        attributeFilter:['hidden', 'style', 'aria-hidden'] });
      const sc = $('#day-score');
      if(sc) new MutationObserver(() => { rafraichir(); })
        .observe(sc, { childList:true, characterData:true, subtree:true });
      window.addEventListener('resize', calerHauteur);
      return true;
    }
    return false;
  }

  let essais = 0;
  const attendre = () => {
    if(demarrer()) return;
    if(++essais > 60) return;           /* 15 secondes, puis on laisse la page telle quelle */
    setTimeout(attendre, 250);
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attendre);
  else attendre();
})();
