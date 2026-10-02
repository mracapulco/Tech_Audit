import Link from 'next/link';
import { formatInt } from '@/lib/dashboard';

export interface BarItem {
  key: string;
  label: string;
  value: number;
  href?: string;
  // Texto menor abaixo do nome (ex.: servidor, empresa).
  sub?: string;
  mono?: boolean;
}

// Ranking em barras horizontais; o número fica sempre visível ao lado.
export function BarList({ items, empty }: { items: BarItem[]; empty: string }) {
  if (items.length === 0) return <p className="muted small">{empty}</p>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="bar-list">
      {items.map((i) => (
        <li key={i.key} title={i.sub ? `${i.label} · ${i.sub}` : i.label}>
          <div className="bar-row">
            <span className="bar-name">
              {i.href ? (
                <Link href={i.href} className={i.mono ? 'bar-label path' : 'bar-label'}>
                  {i.label}
                </Link>
              ) : (
                <span className={i.mono ? 'bar-label path' : 'bar-label'}>{i.label}</span>
              )}
              {i.sub && <span className="bar-sub">{i.sub}</span>}
            </span>
            <span className="bar-value">{formatInt(i.value)}</span>
          </div>
          <div className="bar-track" aria-hidden="true">
            <div className="bar-fill" style={{ width: `${Math.max((i.value / max) * 100, 1)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
