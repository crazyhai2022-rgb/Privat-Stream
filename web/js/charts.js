// Tiny dependency-free SVG charts (the CSP forbids third-party scripts).
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k) el.append(k);
  return el;
};
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

/**
 * Bar or line chart.
 * series: [{ name, color, values: number[] }], labels: string[], fmt: (n) => string
 * Hover/focus any column to read exact values (a <title> on each column also serves screen readers).
 */
export function chart({ type = 'bar', labels, series, fmt = String, height = 200, stacked = false }) {
  const W = Math.max(280, Math.min(640, (window.innerWidth || 640) - 56)), H = height, L = 46, R = 18, T = 10, B = 24;
  const n = labels.length;
  const totals = labels.map((_, i) => (stacked ? series.reduce((a, x) => a + (x.values[i] || 0), 0) : Math.max(...series.map((x) => x.values[i] || 0))));
  const max = niceMax(Math.max(0, ...totals));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const step = (W - L - R) / Math.max(1, n);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', preserveAspectRatio: 'none' });
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }));
    const t = s('text', { x: L - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }); t.textContent = fmt(v); svg.append(t);
  }
  const every = Math.ceil(n / (W < 400 ? 4 : 7));
  labels.forEach((lab, i) => {
    if (i % every && i !== n - 1) return;
    const t = s('text', { x: L + step * (i + 0.5), y: H - 6, class: 'axis', 'text-anchor': 'middle' }); t.textContent = lab; svg.append(t);
  });
  if (type === 'bar') {
    const bw = Math.min(36, Math.max(2, step * (stacked ? 0.7 : 0.7 / series.length)));
    labels.forEach((lab, i) => {
      const g = s('g', { class: 'col', tabindex: 0 });
      let acc = 0;
      series.forEach((ser, k) => {
        const v = ser.values[i] || 0;
        const x = L + step * i + (step - bw * (stacked ? 1 : series.length)) / 2 + (stacked ? 0 : bw * k);
        const top = stacked ? y(acc + v) : y(v);
        const hgt = stacked ? y(acc) - y(acc + v) : y(0) - y(v);
        if (v > 0) g.append(s('rect', { x, y: top, width: bw, height: Math.max(1, hgt), fill: ser.color, rx: 1.5 }));
        acc += v;
      });
      g.append(s('rect', { x: L + step * i, y: T, width: step, height: H - T - B, fill: 'transparent' }));
      const tip = s('title'); tip.textContent = `${lab}\n${series.map((x) => `${x.name}: ${fmt(x.values[i] || 0)}`).join('\n')}`; g.append(tip);
      svg.append(g);
    });
  } else {
    series.forEach((ser) => {
      const pts = ser.values.map((v, i) => `${L + step * (i + 0.5)},${y(v || 0)}`);
      svg.append(s('polyline', { points: pts.join(' '), fill: 'none', stroke: ser.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    });
    labels.forEach((lab, i) => {
      const g = s('g', { class: 'col', tabindex: 0 });
      g.append(s('rect', { x: L + step * i, y: T, width: step, height: H - T - B, fill: 'transparent' }));
      const tip = s('title'); tip.textContent = `${lab}\n${series.map((x) => `${x.name}: ${fmt(x.values[i] || 0)}`).join('\n')}`; g.append(tip);
      svg.append(g);
    });
  }
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  const legend = document.createElement('div');
  legend.className = 'legend';
  for (const ser of series) {
    const i = document.createElement('span');
    i.innerHTML = '<i></i>'; i.firstChild.style.background = ser.color;
    i.append(ser.name); legend.append(i);
  }
  wrap.append(legend, svg);
  return wrap;
}
