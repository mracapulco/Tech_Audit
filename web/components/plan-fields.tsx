'use client';

import { useState } from 'react';
import { PLAN_NAMES, PLANS, planSummary } from '@/lib/plans';

// Plano e retenção da licença: trocar o plano preenche a retenção padrão,
// que ainda pode ser alterada à mão.
export function PlanFields({ plan: initialPlan, retentionDays }: { plan?: string; retentionDays?: number }) {
  const start = initialPlan ?? PLAN_NAMES[0];
  const [plan, setPlan] = useState(start);
  const [retention, setRetention] = useState(String(retentionDays ?? PLANS[start]?.retentionDays ?? 365));
  const names = PLAN_NAMES.includes(start) ? PLAN_NAMES : [start, ...PLAN_NAMES];
  return (
    <>
      <label>
        Plano
        <select
          name="plan"
          value={plan}
          onChange={(e) => {
            setPlan(e.target.value);
            const p = PLANS[e.target.value];
            if (p) setRetention(String(p.retentionDays));
          }}
        >
          {names.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <span className="muted small">{planSummary(plan)}</span>
      </label>
      <label>
        Retenção (dias)
        <input name="retention_days" type="number" min={1} max={36500} value={retention} onChange={(e) => setRetention(e.target.value)} required />
      </label>
    </>
  );
}
