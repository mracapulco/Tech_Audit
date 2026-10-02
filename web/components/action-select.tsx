import { actionGroups } from '@/lib/filters';

// Filtro de ação usado na pesquisa e nos relatórios.
export function ActionSelect({ value }: { value: string }) {
  return (
    <label>
      Ação
      <select name="acao" defaultValue={value}>
        <option value="">Todas</option>
        {actionGroups(value).map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
