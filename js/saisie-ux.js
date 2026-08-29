/* v24.2 — Les points d'un clic sont connus AVANT le clic.

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
import { METRICS, SCORE_WEIGHTS } from './api.js';

(() => {
  'use strict';

  /* Un seul feu d'artifice toutes six secondes. Au-delà, un rendez-vous
     déclenche le palier intermédiaire. Sans ce plafond, quatre rendez-vous
     saisis d'affilée donnent quatre feux d'artifice, et l'effet devient une
     gêne au lieu d'une récompense. Mettre 0 pour n'en plafonner aucun. */
  const FX_BIG_COOLDOWN_MS = 6000;
  const SEUIL_PALIER_2 = 5;   /* points : en dessous, effet discret */
  const SEUIL_PALIER_3 = 16;  /* points : à partir de là, feu d'artifice */
  const CLE_ONGLET = 'cockpit_saisie_onglet';

  const reduced = window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  let dernierFeu = 0;

  /* Définition des onglets. L'ordre compte, il suit le déroulé de la journée.
     Un onglet dont toutes les cartes sont masquées par saisie.js (selon le
     métier de la personne) disparaît de lui-même : un BDR voit trois onglets,
     un commercial en voit quatre. */
  const ONGLETS = [
    { id:'pros',  ico:'📞', couleur:'#00A7E1', titre:'Prospection',
      sous:'Appels, issues, rendez-vous, e-mails', unite:'actions',
      cartes:['[data-card="prospection"]'], total:'[data-total="prospection"]' },
    { id:'crm',   ico:'🗂️', couleur:'#6366f1', titre:'Enrichissement du CRM',
      sous:'Entreprises et contacts créés', unite:'fiches',
      cartes:['[data-card="crm"]'], total:'[data-total="crm"]' },
    { id:'vente', ico:'🤝', couleur:'#10b981', titre:'Cycle de vente',
      sous:'Événements et sorties de pipeline', unite:'actions',
      cartes:['[data-card="pipeline"]','[data-card="outcome"]'], total:'[data-total="pipeline"]' },
    { id:'bilan', ico:'⚡', couleur:'#0ea5e9', titre:'Ce que la journée dit',
      sous:'Taux, décomposition du score, note du jour', unite:'score',
      cartes:[], total:'#day-score' }
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

  /* La récompense dépend des points réellement gagnés, pas du compteur touché. */
  /* ON NE TOUCHE PLUS AU NOMBRE. app.css animait déjà le champ via flash(),
     appelée par onBump() dès le clic. Ajouter la nôtre par dessus faisait bouger
     le nombre une seconde fois, avec un décalage. Le retour immédiat sur le
     nombre est laissé à flash(), et nos effets portent sur la tuile, la bulle de
     points, le score et les confettis. */
  function celebre(points, x, y, metric){
    if(points <= 0){
      anime(metric, 'fx-p0', 400);
      return;
    }
    if(points < SEUIL_PALIER_2){
      anime(metric, 'fx-p1', 500);
      bulle(x, y, '+' + points + ' pt' + (points > 1 ? 's' : ''), 'ux-fx-pop--s');
      return;
    }
    const feuPossible = FX_BIG_COOLDOWN_MS === 0 || (Date.now() - dernierFeu) > FX_BIG_COOLDOWN_MS;
    if(points < SEUIL_PALIER_3 || !feuPossible){
      anime(metric, 'fx-p2', 700);
      bulle(x, y, '+' + points + ' pts', 'ux-fx-pop--m');
      salve(x, y, 14, { haut:true, vitesse:3.4, pousse:1.6, taille:4, vie:46,
        couleurs:['#00A7E1', '#0ea5e9', '#6ee7b7', '#a5f3fc'] });
      return;
    }
    /* Palier 3 : le jalon de la journée. */
    dernierFeu = Date.now();
    anime(metric, 'fx-p3', 1100);
    anime($('.ux-score'), 'ux-score--boom', 900);
    bulle(x, y, '🎉 +' + points + ' points', 'ux-fx-pop--l');
    const P = ['#fbbf24', '#f59e0b', '#10b981', '#00A7E1', '#6366f1', '#f472b6', '#ffffff'];
    const W = window.innerWidth, H = window.innerHeight;
    salve(x, y, 46, { haut:true, vitesse:6.2, pousse:3.4, taille:6, vie:80, carre:true, couleurs:P });
    setTimeout(() => salve(W * .24, H * .42, 40, { vitesse:5.4, taille:5, vie:78, carre:true, couleurs:P }), 160);
    setTimeout(() => salve(W * .76, H * .40, 40, { vitesse:5.4, taille:5, vie:78, carre:true, couleurs:P }), 300);
    setTimeout(() => salve(W * .50, H * .28, 52, { vitesse:6.8, taille:6, vie:88, carre:true, couleurs:P }), 440);
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
    celebre(pointsDuClic(cle), ev.clientX, ev.clientY, metric);
  }, true);

  /* Saisie directe au clavier. Un seul nombre tapé peut valoir plusieurs
     incréments : les points sont multipliés par l'écart réellement saisi. */
  document.addEventListener('change', ev => {
    const champ = ev.target.closest && ev.target.closest('.metric-input');
    if(!champ) return;
    const avant = nombre(champ.dataset.uxAvant);
    const apres = nombre(champ.value);
    champ.dataset.uxAvant = apres;
    if(apres <= avant) return;
    const r = champ.getBoundingClientRect();
    celebre(pointsDuClic(champ.dataset.key) * (apres - avant),
      r.left + r.width / 2, r.top, champ.closest('.metric'));
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
      pan.className = 'ux-panel';
      pan.dataset.ux = p.o.id;
      pan.setAttribute('role', 'tabpanel');
      g.appendChild(pan);
      p.cartes.forEach(c => pan.appendChild(c)); /* déplacement, pas recréation */
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

  /* Chiffres des onglets, pastille « rien de saisi », score en miroir. */
  function rafraichir(){
    poserPastilles();
    const sc = lireScore();
    const n = $('#ux-score-n');
    if(n && n.textContent !== String(sc)) n.textContent = sc;
    Object.keys(panneaux).forEach(k => {
      const e = panneaux[k];
      const src = e.conf.total ? $(e.conf.total) : null;
      const v = src ? nombre(src.textContent) : 0;
      const cible = $('.ux-tab-num b', e.bouton);
      if(cible) cible.textContent = v;
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
