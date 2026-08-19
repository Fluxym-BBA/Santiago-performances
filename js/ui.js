/* ==========================================================================
   UI.JS — Helpers d'affichage, toasts, et graphiques SVG écrits à la main.
   Aucune librairie de charts : tout est du SVG généré ici.
   ========================================================================== */

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

/* ==========================================================================
   GRAPHIQUES SVG
   ========================================================================== */

const SVGNS = 'http://www.w3.org/2000/svg';

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
    container.innerHTML = `<div class="chart-empty">${escapeHtml(message)}</div>`;
}

function baseFrame(container, { width = 760, height = 260, pad }) {
    container.innerHTML = '';
    const svg = svgEl('svg', {
        class: 'chart-svg', viewBox: `0 0 ${width} ${height}`,
        role: 'img', preserveAspectRatio: 'xMidYMid meet'
    });
    container.appendChild(svg);
    return { svg, width, height, pad, plotW: width - pad.l - pad.r, plotH: height - pad.t - pad.b };
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
    const step = Math.max(1, Math.ceil(labels.length / 10));
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

/**
 * Courbes multi-séries.
 * series : [{ name, color, values:[n], dashed:bool, area:bool }]
 */
export function lineChart(container, { labels, series, height = 260 }) {
    if (!labels.length) return emptyState(container, 'Aucune donnée sur la période.');
    const pad = { l: 46, r: 16, t: 16, b: 30 };
    const f = baseFrame(container, { height, pad });

    const allVals = series.flatMap(s => s.values.filter(v => v !== null && v !== undefined));
    const max = niceMax(Math.max(1, ...allVals));
    drawGrid(f, max);

    const xAt = i => f.pad.l + (labels.length === 1 ? f.plotW / 2 : (f.plotW * i) / (labels.length - 1));
    const yAt = v => f.pad.t + f.plotH * (1 - (Number(v) || 0) / max);

    series.forEach(s => {
        const pts = s.values.map((v, i) => [xAt(i), yAt(v)]);

        if (s.area) {
            const d = `M ${pts[0][0]} ${f.pad.t + f.plotH} `
                + pts.map(p => `L ${p[0]} ${p[1]}`).join(' ')
                + ` L ${pts[pts.length - 1][0]} ${f.pad.t + f.plotH} Z`;
            f.svg.appendChild(svgEl('path', { d, fill: s.color, opacity: 0.1 }));
        }

        f.svg.appendChild(svgEl('polyline', {
            points: pts.map(p => p.join(',')).join(' '),
            fill: 'none', stroke: s.color, 'stroke-width': s.dashed ? 2 : 2.6,
            'stroke-linejoin': 'round', 'stroke-linecap': 'round',
            ...(s.dashed ? { 'stroke-dasharray': '5 5', opacity: 0.75 } : {})
        }));

        if (!s.dashed) {
            pts.forEach((p, i) => {
                const c = svgEl('circle', {
                    cx: p[0], cy: p[1], r: labels.length > 40 ? 2 : 3.4,
                    fill: '#fff', stroke: s.color, 'stroke-width': 2
                });
                const title = svgEl('title');
                title.textContent = `${labels[i]} · ${s.name} : ${fmtInt(s.values[i])}`;
                c.appendChild(title);
                f.svg.appendChild(c);
            });
        }
    });

    drawXLabels(f, labels);
}

/**
 * Barres groupées.
 * series : [{ name, color, values:[n] }]
 */
export function barChart(container, { labels, series, height = 260 }) {
    if (!labels.length) return emptyState(container, 'Aucune donnée sur la période.');
    const pad = { l: 46, r: 16, t: 16, b: 30 };
    const f = baseFrame(container, { height, pad });

    const max = niceMax(Math.max(1, ...series.flatMap(s => s.values.map(v => Number(v) || 0))));
    drawGrid(f, max);

    const slot = f.plotW / labels.length;
    const gap = Math.min(10, slot * 0.22);
    const bw = Math.max(2, (slot - gap) / series.length);

    labels.forEach((lab, i) => {
        series.forEach((s, j) => {
            const v = Number(s.values[i]) || 0;
            const h = (v / max) * f.plotH;
            const x = f.pad.l + slot * i + gap / 2 + bw * j;
            const r = svgEl('rect', {
                x, y: f.pad.t + f.plotH - h, width: Math.max(1, bw - 1.5),
                height: Math.max(v > 0 ? 2 : 0, h), fill: s.color,
                rx: Math.min(3, bw / 3), opacity: 0.92
            });
            const title = svgEl('title');
            title.textContent = `${lab} · ${s.name} : ${fmtInt(v)}`;
            r.appendChild(title);
            f.svg.appendChild(r);
        });
    });

    drawXLabels(f, labels);
}

/**
 * Barres horizontales comparant deux jours métrique par métrique.
 * rows : [{ label, a, b, color }]
 */
export function compareChart(container, { rows, labelA, labelB, height }) {
    if (!rows.length) return emptyState(container, 'Aucune donnée à comparer.');
    const rowH = 46;
    const pad = { l: 132, r: 46, t: 26, b: 12 };
    const H = height || pad.t + pad.b + rows.length * rowH;
    const f = baseFrame(container, { height: H, pad });

    const max = niceMax(Math.max(1, ...rows.flatMap(r => [Number(r.a) || 0, Number(r.b) || 0])));

    // Légende intégrée
    [[labelA, '#0B2046', 0], [labelB, '#9ca3af', 1]].forEach(([txt, col, k]) => {
        f.svg.appendChild(svgEl('rect', { x: f.pad.l + k * 150, y: 6, width: 10, height: 10, rx: 2, fill: col }));
        const t = svgEl('text', {
            x: f.pad.l + k * 150 + 16, y: 15, fill: '#4b5563',
            'font-size': 11.5, 'font-weight': 700
        });
        t.textContent = txt;
        f.svg.appendChild(t);
    });

    rows.forEach((r, i) => {
        const top = f.pad.t + i * rowH;

        const lab = svgEl('text', {
            x: f.pad.l - 12, y: top + rowH / 2 + 4, 'text-anchor': 'end',
            fill: '#111827', 'font-size': 12.5, 'font-weight': 700
        });
        lab.textContent = r.label;
        f.svg.appendChild(lab);

        [['a', 0, r.color || '#00A7E1'], ['b', 1, '#d1d5db']].forEach(([key, k, col]) => {
            const v = Number(r[key]) || 0;
            const w = (v / max) * f.plotW;
            const y = top + 6 + k * 16;
            f.svg.appendChild(svgEl('rect', {
                x: f.pad.l, y, width: f.plotW, height: 12, rx: 6, fill: '#f9fafb'
            }));
            const bar = svgEl('rect', {
                x: f.pad.l, y, width: Math.max(v > 0 ? 3 : 0, w), height: 12, rx: 6, fill: col
            });
            const title = svgEl('title');
            title.textContent = `${r.label} · ${k === 0 ? labelA : labelB} : ${fmtInt(v)}`;
            bar.appendChild(title);
            f.svg.appendChild(bar);

            const val = svgEl('text', {
                x: f.pad.l + f.plotW + 8, y: y + 10,
                fill: k === 0 ? '#111827' : '#9ca3af',
                'font-size': 11.5, 'font-weight': 800
            });
            val.textContent = fmtInt(v);
            f.svg.appendChild(val);
        });
    });
}

/**
 * Entonnoir HTML (pas SVG) : appels → aboutis → RDV.
 * steps : [{ label, value, color }]
 */
export function funnel(container, steps) {
    const base = Math.max(1, Number(steps[0]?.value) || 0);
    container.innerHTML = steps.map((s, i) => {
        const v = Number(s.value) || 0;
        const pctBase = Math.min(100, (v / base) * 100);
        const prev = i === 0 ? null : Number(steps[i - 1].value) || 0;
        const rate = i === 0 ? '100 %'
            : (prev > 0 ? `${fmtDec((v / prev) * 100)} %` : '–');
        return `
        <div class="funnel-step">
            <div class="funnel-label">${escapeHtml(s.label)}</div>
            <div class="funnel-bar-wrap">
                <div class="funnel-bar" style="width:${Math.max(pctBase, v > 0 ? 8 : 0)}%;background:${s.color}">
                    ${fmtInt(v)}
                </div>
            </div>
            <div class="funnel-rate">${rate}</div>
        </div>`;
    }).join('');
}

/* --- Voile de chargement -------------------------------------------------- */

export function hideVeil() {
    const v = document.querySelector('.loading-veil');
    if (!v) return;
    v.classList.add('loading-veil--hidden');
    setTimeout(() => v.remove(), 320);
}
