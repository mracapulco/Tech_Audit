'use client';

import { useState } from 'react';

export interface PurgeOption {
  id: string;
  name: string;
  retention_days: number | null;
  agents: { id: string; hostname: string; disabled: boolean }[];
}

export interface PurgeQuery {
  tenant_id?: string;
  agent_id?: string;
  mode?: string;
  from?: string;
  to?: string;
}

// Filtros da limpeza. Envia por GET para a própria página, que mostra a
// prévia; nada é apagado aqui.
export function PurgeFilters({ tenants, initial }: { tenants: PurgeOption[]; initial: PurgeQuery }) {
  const [tenantId, setTenantId] = useState(initial.tenant_id ?? '');
  const [mode, setMode] = useState(initial.mode === 'retention' ? 'retention' : 'manual');
  const tenant = tenants.find((t) => t.id === tenantId);

  return (
    <form method="get" className="card grid-form">
      <label>
        Empresa
        <select name="tenant_id" value={tenantId} onChange={(e) => setTenantId(e.target.value)} required>
          <option value="">Escolha a empresa</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Servidor
        <select name="agent_id" defaultValue={initial.agent_id ?? ''} key={tenantId} disabled={!tenant}>
          <option value="">Todos os servidores</option>
          {tenant?.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.hostname}
              {a.disabled ? ' (desativado)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        O que apagar
        <select name="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="manual">Eventos de um período</option>
          <option value="retention">
            O que passou da retenção da licença{tenant?.retention_days ? ` (${tenant.retention_days} dias)` : ''}
          </option>
        </select>
      </label>
      {mode === 'manual' ? (
        <>
          <label>
            De (opcional)
            <input type="date" name="from" defaultValue={initial.from ?? ''} />
          </label>
          <label>
            Até
            <input type="date" name="to" defaultValue={initial.to ?? ''} required />
          </label>
        </>
      ) : (
        tenant && (
          <p className="muted small">
            {tenant.retention_days
              ? `Mantém os últimos ${tenant.retention_days} dias e apaga o que for mais antigo.`
              : 'Esta empresa não tem licença vigente; use um período.'}
          </p>
        )
      )}
      <div className="form-actions">
        <button type="submit">Conferir quantos eventos</button>
      </div>
    </form>
  );
}
