/* ==========================================================================
   TOOLTIP.JS — Moteur d'info-bulles.

   Pourquoi un module dédié plutôt que les <title> du SVG : le <title> natif
   est rendu par le navigateur, avec son délai d'apparition (~1 s), son style
   système, et il ne peut porter qu'une seule ligne de texte. Ici l'info-bulle
   est un élément HTML que l'on maîtrise : elle apparaît immédiatement, elle
   suit la souris, et elle peut contenir toutes les séries du point survolé
   ainsi que la comparaison avec la période de référence.

   Un seul élément DOM est créé pour toute la page et réutilisé : rien n'est
   ajouté ni supprimé au survol, seul le contenu et la position changent.
   Le contenu n'est réécrit que lorsque la clé change (mémoïsation), et le
   déplacement passe par `transform`, qui ne provoque pas de recalcul de mise
   en page.
   ========================================================================== */

/* escapeHtml est redéfini ici plutôt qu'importé de ui.js : ui.js importe ce
   module, et une dépendance circulaire entre deux modules ES, même légale,
   est un piège inutile pour la prochaine personne qui lira ce code. */
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let el = null;            // l'unique bulle
let lastKey = null;       // clé du contenu affiché, pour éviter de réécrire
let raf = 0;              // frame en attente
let pending = null;       // dernière position reçue
let shown = false;

function node() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'tip';
    el.setAttribute('role', 'tooltip');
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    return el;
}

/* --------------------------------------------------------------------------
   Rendu du modèle

   model = {
     title, meta?,
     sections: [{ head?, accent?: 'a'|'b', badge?: 'A'|'B',
                  rows: [{ color?, shape?: 'dot'|'line'|'dash',
                           label, value, sub?, em?: bool, muted?: bool }] }],
     deltas?: [{ label, html }],
     foot?
   }
   -------------------------------------------------------------------------- */

function rowHtml(r) {
    const swatch = r.color
        ? `<span class="tip-${r.shape === 'dash' ? 'dash' : r.shape === 'line' ? 'line' : 'dot'}"
                 style="${r.shape === 'dash' ? 'color' : 'background'}:${r.color}"></span>`
        : '<span class="tip-nodot"></span>';
    return `<div class="tip-row${r.em ? ' tip-row--em' : ''}${r.muted ? ' tip-row--muted' : ''}">
        ${swatch}
        <span class="tip-label">${escapeHtml(r.label)}${r.sub ? `<em>${escapeHtml(r.sub)}</em>` : ''}</span>
        <span class="tip-val">${r.value == null ? '–' : escapeHtml(String(r.value))}</span>
    </div>`;
}

export function tipHtml(m) {
    if (typeof m === 'string') return m;
    const secs = (m.sections || []).filter(s => s && (s.rows || []).length).map(s => `
        <div class="tip-sec${s.accent ? ` tip-sec--${s.accent}` : ''}">
            ${s.head ? `<div class="tip-sec-head">
                ${s.badge ? `<span class="tip-badge tip-badge--${s.accent || 'a'}">${escapeHtml(s.badge)}</span>` : ''}
                <span>${escapeHtml(s.head)}</span></div>` : ''}
            ${s.rows.map(rowHtml).join('')}
        </div>`).join('');

    const deltas = (m.deltas || []).length ? `<div class="tip-deltas">${m.deltas.map(d =>
        `<div class="tip-delta"><span>${escapeHtml(d.label)}</span>${d.html}</div>`).join('')}</div>` : '';

    return `<div class="tip-head">
            <div class="tip-title">${escapeHtml(m.title || '')}</div>
            ${m.meta ? `<div class="tip-meta">${escapeHtml(m.meta)}</div>` : ''}
        </div>${secs}${deltas}${m.foot ? `<div class="tip-foot">${m.foot}</div>` : ''}`;
}

/* --------------------------------------------------------------------------
   Position

   La bulle se place à droite du curseur, et bascule à gauche si elle sortirait
   de la fenêtre. Elle est centrée verticalement sur le curseur puis ramenée
   dans l'écran. On utilise les coordonnées écran de l'événement, ce qui évite
   toute conversion depuis le repère du SVG.
   -------------------------------------------------------------------------- */

const GAP = 16;

function place() {
    raf = 0;
    if (!pending || !el) return;
    const { x, y } = pending;
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;

    let left = x + GAP;
    if (left + w > vw - 8) left = x - GAP - w;
    if (left < 8) left = Math.min(8, vw - w - 8);

    let top = y - h / 2;
    top = Math.max(8, Math.min(top, vh - h - 8));

    el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function schedule(x, y) {
    pending = { x, y };
    if (!raf) raf = requestAnimationFrame(place);
}

/* --------------------------------------------------------------------------
   API
   -------------------------------------------------------------------------- */

/** Affiche (ou met à jour) la bulle. `key` évite de réécrire le HTML à chaque pixel. */
export function showTip(model, ev, key = null) {
    const n = node();
    const k = key ?? JSON.stringify(model);
    if (k !== lastKey) {
        n.innerHTML = tipHtml(model);
        lastKey = k;
    }
    if (!shown) {
        n.classList.add('tip--on');
        n.setAttribute('aria-hidden', 'false');
        shown = true;
    }
    // Première position posée sans attendre la frame suivante : la bulle ne
    // doit jamais apparaître une fraction de seconde à l'ancien endroit.
    pending = { x: ev.clientX, y: ev.clientY };
    place();
}

export function moveTip(ev) {
    if (shown) schedule(ev.clientX, ev.clientY);
}

export function hideTip() {
    if (!el || !shown) return;
    el.classList.remove('tip--on');
    el.setAttribute('aria-hidden', 'true');
    shown = false;
    lastKey = null;
}

// Sécurités : un défilement ou un changement d'onglet ne doit pas laisser une
// bulle orpheline à l'écran.
// Capture activée : le défilement peut venir d'un conteneur interne (la fenêtre
// d'agrandissement), qui ne fait pas remonter l'événement jusqu'à window.
window.addEventListener('scroll', hideTip, { capture: true, passive: true });
window.addEventListener('blur', hideTip);

// Tactile : il n'y a pas de « sortie du curseur ». Une pression ailleurs que sur
// un graphique referme la bulle. La phase de capture passe avant les zones de
// survol, qui rouvriront donc la bulle si la pression a bien lieu sur elles.
document.addEventListener('pointerdown', e => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function' || !t.closest('svg, .funnel-step')) hideTip();
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
