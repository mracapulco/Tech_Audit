// Regras de exibição do painel e dos relatórios. Sem dependências, para
// testar com node --test.

export const HEALTH: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  ok: { label: 'Enviando', tone: 'ok' },
  late: { label: 'Sem envio recente', tone: 'warn' },
  stale: { label: 'Parado', tone: 'bad' },
  never: { label: 'Nunca enviou', tone: 'bad' },
  disabled: { label: 'Desativado', tone: 'neutral' },
};
export const health = (h: string) => HEALTH[h] ?? { label: h, tone: 'neutral' as const };

// "há 5 min", "há 3 h", "há 2 dias"
export function ago(iso: string | null, now = new Date()): string {
  if (!iso) return 'nunca';
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}

export const formatInt = (n: number | string | null | undefined) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('pt-BR'));

// Topo "redondo" do eixo e as marcas intermediárias (0, metade, topo).
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= max) return m * pow;
  return 10 * pow;
}

// Índices dos rótulos do eixo X: no máximo `max` rótulos, sempre o primeiro e o último.
export function labelIndexes(count: number, max = 8): number[] {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil((count - 1) / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < count - 1; i += step) out.push(i);
  if (count - 1 - out[out.length - 1] < step / 2) out.pop();
  out.push(count - 1);
  return out;
}

export const userText = (r: { user_domain?: string | null; user_name?: string | null }) =>
  r.user_name ? (r.user_domain ? `${r.user_domain}\\${r.user_name}` : r.user_name) : '(não identificado)';

export const REPORT_TYPES: { key: string; label: string; hint: string }[] = [
  { key: 'usuarios', label: 'Por usuário', hint: 'Quanto cada usuário mexeu, por tipo de ação.' },
  { key: 'pastas', label: 'Por pasta', hint: 'As pastas com mais atividade e quem mexeu nelas.' },
  { key: 'periodo', label: 'Por período', hint: 'A atividade hora a hora, dia a dia ou mês a mês.' },
  { key: 'eventos', label: 'Eventos detalhados', hint: 'Cada evento, com data, usuário, ação e caminho.' },
];

// Rótulo curto do eixo X: "01/10/2026" -> "01/10" quando o intervalo é o dia.
export const axisLabel = (label: string, bucket: string) => (bucket === 'day' ? label.slice(0, 5) : label);
