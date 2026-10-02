import { axisLabel, formatInt, labelIndexes, niceMax } from '@/lib/dashboard';

export interface TimelinePoint {
  key: string;
  label: string;
  total: number;
  sensitive: number;
  failures: number;
}

// Eventos por intervalo, em barras de uma cor só. Passar o mouse (ou o foco)
// numa coluna mostra os números daquele intervalo.
export function TimelineChart({ points, title, bucket }: { points: TimelinePoint[]; title: string; bucket: string }) {
  const W = 1100;
  const H = 260;
  const pad = { top: 12, right: 8, bottom: 26, left: 44 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...points.map((p) => p.total)));
  const slot = innerW / Math.max(points.length, 1);
  const bar = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const labels = new Set(labelIndexes(points.length, 8));

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.left - 6} y={y(t) + 4} className="axis" textAnchor="end">
              {formatInt(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = pad.left + i * slot + (slot - bar) / 2;
          const h = pad.top + innerH - y(p.total);
          return (
            <g key={p.key} className="col" tabIndex={0}>
              <title>{`${p.label}: ${formatInt(p.total)} eventos · ${formatInt(p.sensitive)} exclusões/permissões · ${formatInt(p.failures)} falhas`}</title>
              <rect x={pad.left + i * slot} y={pad.top} width={slot} height={innerH} className="hit" />
              {p.total > 0 && <path d={roundedTop(x, y(p.total), bar, Math.max(h, 1))} className="bar" />}
              {labels.has(i) && (
                <text x={pad.left + i * slot + slot / 2} y={H - 8} className="axis" textAnchor="middle">
                  {axisLabel(p.label, bucket)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

// Barra com cantos arredondados só no topo, presa à linha de base.
function roundedTop(x: number, top: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const bottom = top + h;
  return `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${bottom} Z`;
}
