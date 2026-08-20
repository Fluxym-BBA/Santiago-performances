/* ==========================================================================
   UI.JS — Helpers d'affichage, toasts, et graphiques SVG écrits à la main.
   Aucune librairie de charts : tout est du SVG généré ici.
   ========================================================================== */

import { showTip, moveTip, hideTip } from './tooltip.js';

/* --- Helpers courts ------------------------------------------------------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const nf = new Intl.NumberFormat('fr-FR');
export const fmtInt = v => nf.format(Math.round(Number(v) || 0));
export const fmtPct = v => (v === null || v === undefined || Number.isNaN(Number(v)))
    ? '–' : `${nf.format(Number(v))} %`;
export const fmtDec = (v, d = 1) => (v === null || v === undefined)
    ? '–' : Number(v).toFixed(d).replace('.', ',');

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --- Toasts --------------------------------------------------------------- */

function toastZone() {
    let z = document.querySelector('.toast-zone');
    if (!z) {
        z = document.createElement('div');
        z.className = 'toast-zone';
        z.setAttribute('aria-live', 'polite');
        document.body.appendChild(z);
    }
    return z;
}

export function toast(message, type = '', ms = 3200) {
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ` toast--${type}` : '');
    t.textContent = message;
    toastZone().appendChild(t);
    setTimeout(() => t.remove(), ms);
}

/* --- Deltas (comparaison entre deux jours) -------------------------------- */

/**
 * Renvoie { html, pct, dir } pour l'écart entre deux valeurs.
 * higherIsBetter permet d'inverser la couleur si un jour on suit un indicateur
 * où baisser est un progrès.
 */
export function delta(current, reference, { suffix = '', higherIsBetter = true } = {}) {
    const c = Number(current) || 0;
    const r = Number(reference) || 0;
    const diff = c - r;
    let pct = null;
    if (r !== 0) pct = Math.round((diff / Math.abs(r)) * 1000) / 10;

    let dir = 'flat';
    if (diff > 0) dir = higherIsBetter ? 'up' : 'down';
    else if (diff < 0) dir = higherIsBetter ? 'down' : 'up';

    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '=';
    const signed = `${diff > 0 ? '+' : ''}${fmtInt(diff)}${suffix}`;
    const label = pct === null
        ? (diff === 0 ? 'identique' : `${signed} (nouveau)`)
        : `${signed} · ${pct > 0 ? '+' : ''}${fmtDec(pct)} %`;

    return {
        dir, diff, pct,
        html: `<span class="delta delta--${dir}">${arrow} ${escapeHtml(label)}</span>`
    };
}

/* --------------------------------------------------------------------------
   Légendes
   Une légende est un composant, pas une phrase : pastille + libellé, et le
   libellé porte la vraie information (les dates de la période, l'unité).
   items : [{ color, label, shape?: 'box'|'line'|'dash', pair?: [c1, c2] }]
   Un item { head: 'texte' } insère un intitulé de section sur toute la largeur.
   -------------------------------------------------------------------------- */

export function legendHtml(items) {
    return `<div class="chart-legend">${items.map(it => {
        if (it.head) return `<span class="legend-head">${escapeHtml(it.head)}</span>`;
        if (it.periodStyle) {
            return `<span class="legend-period legend-period--${it.periodStyle}">
                <span class="legend-dot" style="background:${it.color}"></span>${escapeHtml(it.label)}</span>`;
        }
        if (it.pair) {
            return `<span class="legend-item"><span class="legend-pair">
                <span class="legend-dot" style="background:${it.pair[0]}"></span>
                <span class="legend-dot" style="background:${it.pair[1]}"></span></span>${escapeHtml(it.label)}</span>`;
        }
        const cls = it.shape === 'dash' ? 'legend-dash' : it.shape === 'line' ? 'legend-line' : 'legend-dot';
        const style = it.shape === 'dash' ? `color:${it.color}` : `background:${it.color}`;
        return `<span class="legend-item"><span class="${cls}" style="${style}"></span>${escapeHtml(it.label)}</span>`;
    }).join('')}</div>`;
}

/* ==========================================================================
   GRAPHIQUES SVG
   ========================================================================== */

const SVGNS = 'http://www.w3.org/2000/svg';
let uidSeq = 0;

function svgEl(name, attrs = {}) {
    const n = document.createElementNS(SVGNS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
}

function niceMax(v) {
    if (v <= 5) return 5;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const steps = [1, 2, 2.5, 5, 10];
    for (const s of steps) if (v <= s * pow) return s * pow;
    return 10 * pow;
}

function emptyState(container, message) {
    hideTip();
    container.innerHTML = `<div class="chart-empty">${escapeHtml(message)}</div>`;
}

/**
 * Cadre d'un graphique, dimensionné sur la place réellement disponible.
 *
 * Le viewBox était figé à 760 unités de large. Comme le SVG occupe 100 % de son
 * conteneur, sur un téléphone de 375 pixels tout était mis à l'échelle 0,49 :
 * un texte déclaré à 11 pixels s'affichait à 5, donc illisible. En calant la
 * largeur du viewBox sur celle du conteneur, une unité SVG vaut un pixel écran
 * et les tailles de texte sont respectées à toutes les tailles d'écran.
 *
 * La hauteur est bornée par celle de la fenêtre, ce qui règle le cas du
 * téléphone en paysage : il n'y reste qu'environ 350 pixels utiles, et un
 * graphique de 320 y remplirait tout l'écran.
 */
/** Largeur réellement disponible pour un graphique, en pixels. */
function availWidth(container) {
    const w = Math.round(container.getBoundingClientRect().width);
    return Math.max(300, Math.min(w || 760, 1100));
}

function frameSize(container, height) {
    const width = availWidth(container);
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 900;
    const maxH = Math.max(150, Math.round(vh * 0.62));
    // Sous 420 pixels de large, on gagne aussi un peu de hauteur : les
    // graphiques doivent rester lisibles sans occuper tout le défilement.
    const wanted = width < 420 ? Math.round(height * 0.88) : height;
    return { width, height: Math.min(wanted, maxH) };
}

function baseFrame(container, { width: forced = null, height = 260, pad, clampHeight = true }) {
    // Un nouveau rendu invalide la bulle en cours : sans cela, changer de période
    // pendant que la souris est sur un graphique laisserait affichées les valeurs
    // de l'ancienne période.
    hideTip();
    container.innerHTML = '';

    // clampHeight = false pour les graphiques dont la hauteur est une somme de
    // lignes : les rogner couperait la dernière ligne au lieu de la comprimer.
    const width = forced || availWidth(container);
    if (clampHeight) height = frameSize(container, height).height;

    // Marges resserrées sur petit écran, mais seulement quand la marge gauche
    // sert à un axe numérique. Une marge large porte des libellés de texte :
    // la réduire les tronquerait, ce qui est exactement ce qu'on veut éviter.
    const p = width < 480 && pad.l < 60
        ? { ...pad, l: Math.min(pad.l, 34), r: Math.min(pad.r, 34) }
        : pad;

    const svg = svgEl('svg', {
        class: 'chart-svg', viewBox: `0 0 ${width} ${height}`,
        role: 'img', preserveAspectRatio: 'xMidYMid meet'
    });
    container.appendChild(svg);
    return {
        svg, width, height, pad: p, uid: `c${++uidSeq}`,
        plotW: width - p.l - p.r, plotH: height - p.t - p.b,
        narrow: width < 480
    };
}

function drawGrid(f, max, ticks = 4) {
    for (let i = 0; i <= ticks; i++) {
        const v = (max / ticks) * i;
        const y = f.pad.t + f.plotH * (1 - i / ticks);
        f.svg.appendChild(svgEl('line', {
            x1: f.pad.l, x2: f.pad.l + f.plotW, y1: y, y2: y,
            stroke: i === 0 ? '#d1d5db' : '#f3f4f6', 'stroke-width': 1
        }));
        const t = svgEl('text', {
            x: f.pad.l - 10, y: y + 4, 'text-anchor': 'end',
            fill: '#9ca3af', 'font-size': 11, 'font-weight': 600
        });
        t.textContent = nf.format(Math.round(v));
        f.svg.appendChild(t);
    }
}

function drawXLabels(f, labels) {
    // Le nombre d'étiquettes dépend de la place : une étiquette a besoin d'au
    // moins 58 pixels pour ne pas chevaucher sa voisine.
    const room = Math.max(2, Math.floor(f.plotW / 58));
    const step = Math.max(1, Math.ceil(labels.length / room));
    labels.forEach((lab, i) => {
        if (i % step !== 0 && i !== labels.length - 1) return;
        const x = f.pad.l + (labels.length === 1 ? f.plotW / 2 : (f.plotW * i) / (labels.length - 1));
        const t = svgEl('text', {
            x, y: f.height - 10, 'text-anchor': 'middle',
            fill: '#9ca3af', 'font-size': 11, 'font-weight': 600
        });
        t.textContent = lab;
        f.svg.appendChild(t);
    });
}

/* --------------------------------------------------------------------------
   Couche de survol

   Le principe qui rend la lecture immédiate : on ne survole pas un point, on
   survole une COLONNE. Une bande invisible couvre toute la hauteur du graphique
   au-dessus de chaque position en abscisse ; il suffit donc de passer la souris
   quelque part au-dessus d'un jour, à n'importe quelle hauteur, pour obtenir
   l'ensemble des valeurs de ce jour. Viser un point de 3 pixels n'est plus
   nécessaire, et une courbe de tendance ou une ligne de référence répond au
   même endroit que la courbe principale.

   bandAt(i) → { x, y, width, height } dans le repère du SVG. Les bandes étant
   des éléments SVG, elles suivent automatiquement la mise à l'échelle du
   viewBox : aucune conversion de coordonnées à faire.
   -------------------------------------------------------------------------- */

function installHover(f, { count, bandAt, build, onEnter = null, onLeave = null, keyOf = null }) {
    if (!build || !count) return;
    const layer = svgEl('g', { class: 'hover-layer' });

    let active = -1;
    const enter = (i, ev) => {
        if (i !== active) {
            active = i;
            if (onEnter) onEnter(i);
        }
        showTip(build(i), ev, keyOf ? keyOf(i) : `${f.uid}:${i}`);
    };
    const leave = () => {
        active = -1;
        hideTip();
        if (onLeave) onLeave();
    };

    for (let i = 0; i < count; i++) {
        const b = bandAt(i);
        const band = svgEl('rect', {
            x: b.x, y: b.y, width: Math.max(1, b.width), height: Math.max(1, b.height),
            fill: 'transparent', 'pointer-events': 'all'
        });
        band.addEventListener('pointerenter', e => enter(i, e));
        band.addEventListener('pointermove', e => { if (active !== i) enter(i, e); else moveTip(e); });
        band.addEventListener('pointerdown', e => enter(i, e));   // tactile
        layer.appendChild(band);
    }

    f.svg.addEventListener('pointerleave', leave);
    f.svg.addEventListener('pointercancel', leave);
    f.svg.appendChild(layer);
    return layer;
}

/**
 * Courbes multi-séries.
 * series : [{ name, color, values:[n], dashed:bool, area:bool }]
 * tip    : (i) => modèle d'info-bulle (voir tooltip.js). Facultatif.
 */
export function lineChart(container, { labels, series, height = 260, yMax = null, refLines = [], tip = null }) {
    if (!labels.length) return emptyState(container, 'Aucune donnée sur la période.');
    const pad = { l: 46, r: refLines.length ? 58 : 16, t: 16, b: 30 };
    const f = baseFrame(container, { height, pad });

    const allVals = series.flatMap(s => s.values.filter(v => v !== null && v !== undefined))
        .concat(refLines.map(r => Number(r.value) || 0));
    const max = yMax || niceMax(Math.max(1, ...allVals));
    drawGrid(f, max);

    const xAt = i => f.pad.l + (labels.length === 1 ? f.plotW / 2 : (f.plotW * i) / (labels.length - 1));
    const yAt = v => f.pad.t + f.plotH * (1 - (Number(v) || 0) / max);

    // Niveau de référence : la valeur de la période de comparaison, tracée en
    // travers du graphique. On lit immédiatement si la courbe passe au-dessus.
    refLines.forEach(r => {
        const y = yAt(r.value);
        f.svg.appendChild(svgEl('line', {
            x1: f.pad.l, x2: f.pad.l + f.plotW, y1: y, y2: y,
            stroke: r.color, 'stroke-width': 2, 'stroke-dasharray': '7 5', opacity: 0.9
        }));
        const t = svgEl('text', {
            x: f.pad.l + f.plotW + 6, y: y + 4,
            fill: r.color, 'font-size': 11, 'font-weight': 800
        });
        t.textContent = r.short ?? fmtInt(r.value);
        f.svg.appendChild(t);
    });

    series.forEach(s => {
        // Les valeurs null créent une rupture de courbe (période plus courte,
        // ou jour sans donnée) : on ne les remplace jamais par un zéro trompeur.
        const pts = s.values.map((v, i) =>
            (v === null || v === undefined) ? null : [xAt(i), yAt(v)]);

        const segments = [];
        let run = [];
        pts.forEach(p => {
            if (p) { run.push(p); }
            else if (run.length) { segments.push(run); run = []; }
        });
        if (run.length) segments.push(run);

        segments.forEach(seg => {
            if (s.area && seg.length > 1) {
                const d = `M ${seg[0][0]} ${f.pad.t + f.plotH} `
                    + seg.map(p => `L ${p[0]} ${p[1]}`).join(' ')
                    + ` L ${seg[seg.length - 1][0]} ${f.pad.t + f.plotH} Z`;
                f.svg.appendChild(svgEl('path', { d, fill: s.color, opacity: 0.1 }));
            }
            if (seg.length > 1) {
                f.svg.appendChild(svgEl('polyline', {
                    points: seg.map(p => p.join(',')).join(' '),
                    fill: 'none', stroke: s.color, 'stroke-width': s.dashed ? 2 : 2.6,
                    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
                    ...(s.dashed ? { 'stroke-dasharray': '5 5', opacity: 0.8 } : {})
                }));
            }
        });

        if (!s.dashed) {
            const r = labels.length > 40 ? 2 : labels.length > 20 ? 2.8 : 3.6;
            pts.forEach(p => {
                if (!p) return;
                f.svg.appendChild(svgEl('circle', {
                    cx: p[0], cy: p[1], r, fill: '#fff', stroke: s.color, 'stroke-width': 2
                }));
            });
        }
    });

    drawXLabels(f, labels);

    /* --- Survol : trait de repère vertical + pastille sur chaque série ----- */
    if (tip) {
        const guide = svgEl('line', {
            y1: f.pad.t, y2: f.pad.t + f.plotH, stroke: '#0B2046',
            'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0
        });
        f.svg.appendChild(guide);

        // Une pastille par série (courbes) et un losange par ligne de référence :
        // l'oeil voit tout de suite quelles valeurs l'info-bulle est en train de lire.
        const dots = series.map(s => {
            const c = svgEl('circle', { r: 5, fill: s.color, stroke: '#fff', 'stroke-width': 2.5, opacity: 0 });
            f.svg.appendChild(c);
            return c;
        });
        const refDots = refLines.map(r => {
            const c = svgEl('rect', {
                width: 8, height: 8, fill: r.color, stroke: '#fff', 'stroke-width': 2,
                opacity: 0, transform: 'rotate(45)'
            });
            f.svg.appendChild(c);
            return c;
        });

        const slot = labels.length > 1 ? f.plotW / (labels.length - 1) : f.plotW;
        installHover(f, {
            count: labels.length,
            // La bande est centrée sur le point et bornée à la zone de tracé.
            // Les bandes voisines se chevauchent d'une demi-largeur ; la dernière
            // déclarée gagne, ce qui donne exactement le point le plus proche.
            bandAt: i => {
                const x0 = Math.max(f.pad.l, xAt(i) - slot / 2);
                const x1 = Math.min(f.pad.l + f.plotW, xAt(i) + slot / 2);
                return { x: x0, y: f.pad.t, width: Math.max(1, x1 - x0), height: f.plotH };
            },
            build: tip,
            onEnter: i => {
                const x = xAt(i);
                guide.setAttribute('x1', x);
                guide.setAttribute('x2', x);
                guide.setAttribute('opacity', 0.35);
                series.forEach((s, k) => {
                    const v = s.values[i];
                    if (v === null || v === undefined) { dots[k].setAttribute('opacity', 0); return; }
                    dots[k].setAttribute('cx', x);
                    dots[k].setAttribute('cy', yAt(v));
                    dots[k].setAttribute('opacity', 1);
                });
                refLines.forEach((r, k) => {
                    // rotate(45) tourne autour de l'origine : on positionne donc
                    // le losange via son propre repère plutôt qu'avec x / y.
                    refDots[k].setAttribute('transform',
                        `translate(${x} ${yAt(r.value)}) rotate(45) translate(-4 -4)`);
                    refDots[k].setAttribute('opacity', 1);
                });
            },
            onLeave: () => {
                guide.setAttribute('opacity', 0);
                dots.forEach(d => d.setAttribute('opacity', 0));
                refDots.forEach(d => d.setAttribute('opacity', 0));
            }
        });
    }
}

/**
 * Barres groupées.
 * series : [{ name, color, values:[n] }]
 * tip    : (i) => modèle d'info-bulle. Le survol porte sur le GROUPE entier,
 *          donc survoler n'importe quelle barre donne les trois séries.
 */
export function barChart(container, { labels, series, height = 260, yMax = null, tip = null }) {
    if (!labels.length) return emptyState(container, 'Aucune donnée sur la période.');
    const pad = { l: 46, r: 16, t: 16, b: 30 };
    const f = baseFrame(container, { height, pad });

    // yMax imposé : indispensable pour que deux panneaux empilés soient comparables.
    const max = yMax || niceMax(Math.max(1, ...series.flatMap(s => s.values.map(v => Number(v) || 0))));
    drawGrid(f, max);

    const slot = f.plotW / labels.length;
    const gap = Math.min(10, slot * 0.22);
    const bw = Math.max(2, (slot - gap) / series.length);

    // Surbrillance du groupe survolé, créée avant les barres pour rester derrière.
    const hl = svgEl('rect', {
        y: f.pad.t, height: f.plotH, width: slot, fill: '#0B2046', opacity: 0, rx: 4
    });
    if (tip) f.svg.appendChild(hl);

    labels.forEach((lab, i) => {
        series.forEach((s, j) => {
            const v = Number(s.values[i]) || 0;
            const h = (v / max) * f.plotH;
            const x = f.pad.l + slot * i + gap / 2 + bw * j;
            f.svg.appendChild(svgEl('rect', {
                x, y: f.pad.t + f.plotH - h, width: Math.max(1, bw - 1.5),
                height: Math.max(v > 0 ? 2 : 0, h), fill: s.color,
                rx: Math.min(3, bw / 3), opacity: 0.92
            }));
        });
    });

    drawXLabels(f, labels);

    if (tip) {
        installHover(f, {
            count: labels.length,
            bandAt: i => ({ x: f.pad.l + slot * i, y: f.pad.t, width: slot, height: f.plotH }),
            build: tip,
            onEnter: i => {
                hl.setAttribute('x', f.pad.l + slot * i);
                hl.setAttribute('opacity', 0.05);
            },
            onLeave: () => hl.setAttribute('opacity', 0)
        });
    }
}

/**
 * Barres horizontales comparant deux périodes métrique par métrique.
 * rows : [{ label, a, b, colorA, colorB }]
 * tip  : (i) => modèle d'info-bulle. Le survol porte sur la LIGNE entière.
 */
export function compareChart(container, { rows, labelA, labelB, height, fmt = fmtInt, tip = null }) {
    if (!rows.length) return emptyState(container, 'Aucune donnée à comparer.');
    // Les libellés de métrique occupent la marge gauche : sur un écran étroit
    // on la réduit proportionnellement et on rapetisse la police, plutôt que de
    // couper « Rendez-vous » en « Rendez-... ».
    const avail = availWidth(container);
    const narrow = avail < 560;
    const rowH = narrow ? 48 : 54;
    const labelSize = narrow ? 11.5 : 13.5;
    const pad = narrow
        ? { l: Math.round(avail * 0.30), r: Math.round(avail * 0.17), t: 8, b: 10 }
        : { l: 138, r: 96, t: 8, b: 10 };
    const H = height || pad.t + pad.b + rows.length * rowH;
    const f = baseFrame(container, { height: H, pad, clampHeight: false });

    const max = niceMax(Math.max(1, ...rows.flatMap(r => [Number(r.a) || 0, Number(r.b) || 0])));

    const hl = svgEl('rect', {
        x: 4, width: f.width - 8, height: rowH - 4, fill: '#0B2046', opacity: 0, rx: 8
    });
    if (tip) f.svg.appendChild(hl);

    rows.forEach((r, i) => {
        const top = f.pad.t + i * rowH;

        const lab = svgEl('text', {
            x: f.pad.l - (narrow ? 8 : 14), y: top + rowH / 2 + 2, 'text-anchor': 'end',
            fill: '#111827', 'font-size': labelSize, 'font-weight': 800
        });
        lab.textContent = r.label;
        f.svg.appendChild(lab);

        [['a', 0, r.colorA], ['b', 1, r.colorB]].forEach(([key, k, col]) => {
            const v = Number(r[key]) || 0;
            const w = (v / max) * f.plotW;
            const y = top + (narrow ? 6 : 8) + k * (narrow ? 17 : 19);

            f.svg.appendChild(svgEl('rect', {
                x: f.pad.l, y, width: f.plotW, height: 15, rx: 7.5, fill: '#f3f4f6'
            }));
            f.svg.appendChild(svgEl('rect', {
                x: f.pad.l, y, width: Math.max(v > 0 ? 4 : 0, w), height: 15, rx: 7.5, fill: col
            }));

            // Valeur écrite en bout de barre, dans la couleur de sa période :
            // plus besoin de deviner quelle barre est laquelle.
            const val = svgEl('text', {
                x: f.pad.l + f.plotW + (narrow ? 6 : 10), y: y + 12,
                fill: col, 'font-size': narrow ? 11.5 : 12.5, 'font-weight': 900
            });
            val.textContent = fmt(v);
            f.svg.appendChild(val);
        });
    });

    if (tip) {
        installHover(f, {
            count: rows.length,
            bandAt: i => ({ x: 0, y: f.pad.t + i * rowH, width: f.width, height: rowH }),
            build: tip,
            onEnter: i => {
                hl.setAttribute('y', f.pad.t + i * rowH + 2);
                hl.setAttribute('opacity', 0.045);
            },
            onLeave: () => hl.setAttribute('opacity', 0)
        });
    }
}

/**
 * Entonnoir HTML (pas SVG) : appels → aboutis → RDV.
 * steps : [{ label, value, color }]
 * tip   : (i) => modèle d'info-bulle sur l'étape.
 */
export function funnel(container, steps, tip = null) {
    const base = Math.max(1, Number(steps[0]?.value) || 0);
    container.innerHTML = steps.map((s, i) => {
        const v = Number(s.value) || 0;
        const pctBase = Math.min(100, (v / base) * 100);
        const prev = i === 0 ? null : Number(steps[i - 1].value) || 0;
        const rate = i === 0 ? '100 %'
            : (prev > 0 ? `${fmtDec((v / prev) * 100)} %` : '–');
        return `
        <div class="funnel-step" data-i="${i}">
            <div class="funnel-label">${escapeHtml(s.label)}</div>
            <div class="funnel-bar-wrap">
                <div class="funnel-bar" style="width:${Math.max(pctBase, v > 0 ? 8 : 0)}%;background:${s.color}">
                    ${fmtInt(v)}
                </div>
            </div>
            <div class="funnel-rate">${rate}</div>
        </div>`;
    }).join('');

    if (!tip) return;
    container.querySelectorAll('.funnel-step').forEach(stepEl => {
        const i = Number(stepEl.dataset.i);
        stepEl.classList.add('funnel-step--hoverable');
        stepEl.addEventListener('pointerenter', e => showTip(tip(i), e, `${container.dataset.f || 'f'}:${i}`));
        stepEl.addEventListener('pointermove', moveTip);
        stepEl.addEventListener('pointerleave', hideTip);
    });
}

/* --------------------------------------------------------------------------
   Redimensionnement

   Les graphiques sont dessinés pour la largeur disponible au moment du rendu.
   Faire tourner un téléphone ou redimensionner une fenêtre change cette
   largeur, il faut donc redessiner. On ne réagit qu'aux variations réelles
   (plus de 40 pixels de large, ou un changement d'orientation) : sur mobile,
   le simple défilement fait varier la hauteur de la fenêtre à cause de la
   barre d'adresse, et redessiner à chaque pixel rendrait la page inutilisable.
   -------------------------------------------------------------------------- */

export function onResize(callback, delay = 220) {
    let w = window.innerWidth;
    let portrait = window.innerHeight >= window.innerWidth;
    let timer = null;

    const handler = () => {
        const nw = window.innerWidth;
        const np = window.innerHeight >= window.innerWidth;
        if (Math.abs(nw - w) < 40 && np === portrait) return;
        w = nw;
        portrait = np;
        clearTimeout(timer);
        timer = setTimeout(callback, delay);
    };

    window.addEventListener('resize', handler);
    window.addEventListener('orientationchange', handler);
    return () => {
        window.removeEventListener('resize', handler);
        window.removeEventListener('orientationchange', handler);
    };
}

/* --- Voile de chargement -------------------------------------------------- */

export function hideVeil() {
    const v = document.querySelector('.loading-veil');
    if (!v) return;
    v.classList.add('loading-veil--hidden');
    setTimeout(() => v.remove(), 320);
}
