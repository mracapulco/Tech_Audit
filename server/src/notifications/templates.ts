// Texto e HTML dos e-mails (alertas, relatórios agendados e teste). HTML
// simples com estilos na própria tag, que é o que os leitores de e-mail aceitam.
import { formatDateTime } from '../reports/table.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const portalUrl = () => (process.env.PORTAL_URL ?? '').trim().replace(/\/$/, '');

function link(path: string, tenantId: string | null): string | null {
  const base = portalUrl();
  if (!base) return null;
  return `${base}${path}${tenantId ? `?cliente=${tenantId}` : ''}`;
}

// Moldura: faixa roxa com o nome, faixa tricolor da Tech Master e rodapé.
function frame(title: string, body: string, button: { label: string; href: string } | null): string {
  const btn = button
    ? `<p style="margin:24px 0 8px"><a href="${esc(button.href)}" style="background:#5f5aa0;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600">${esc(button.label)}</a></p>`
    : '';
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f2f7;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1f1a2b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2f7;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;overflow:hidden">
<tr><td style="background:#5f5aa0;color:#fff;padding:16px 24px;font-size:18px;font-weight:700">Tech Audit</td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="height:4px;font-size:0;background:#7a75b5">&nbsp;</td><td style="height:4px;font-size:0;background:#5cc6d0">&nbsp;</td><td style="height:4px;font-size:0;background:#a8cf45">&nbsp;</td></tr></table></td></tr>
<tr><td style="padding:24px">
<h1 style="font-size:18px;margin:0 0 16px">${esc(title)}</h1>
${body}
${btn}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e6e1ee;color:#6b6478;font-size:12px">Mensagem automática do Tech Audit, da Tech Master. Para mudar quem recebe ou o que é enviado, use a aba Alertas e e-mails do portal.</td></tr>
</table></td></tr></table></body></html>`;
}

const FOOT = '\n\n--\nMensagem automática do Tech Audit, da Tech Master. Para mudar quem recebe ou o que é enviado, use a aba Alertas e e-mails do portal.';

export interface AlertItem {
  severity: string;
  message: string;
  createdAt: Date;
}

const SEVERITY: Record<string, { label: string; color: string }> = {
  critical: { label: 'Crítico', color: '#c62828' },
  warning: { label: 'Atenção', color: '#b26a00' },
  info: { label: 'Informação', color: '#00799a' },
};

export function alertMail(tenant: { id: string; name: string }, alerts: AlertItem[]) {
  const n = alerts.length;
  const subject =
    n === 1 ? `[Tech Audit] ${tenant.name}: ${alerts[0].message}`.slice(0, 200) : `[Tech Audit] ${tenant.name}: ${n} alertas`;
  const rows = alerts
    .map((a) => {
      const s = SEVERITY[a.severity] ?? SEVERITY.info;
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap;color:#6b6478;font-size:13px">${esc(formatDateTime(a.createdAt.toISOString()).slice(0, 16))}</td>
<td style="padding:8px 8px;border-bottom:1px solid #eee;vertical-align:top"><span style="color:${s.color};font-weight:600;font-size:13px">${s.label}</span></td>
<td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px">${esc(a.message)}</td></tr>`;
    })
    .join('');
  const intro = `<p style="margin:0 0 12px">Empresa: <strong>${esc(tenant.name)}</strong></p>`;
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
  const href = link('/servidores', tenant.id);
  const html = frame(n === 1 ? 'Novo alerta' : `${n} novos alertas`, intro + table, href ? { label: 'Abrir no portal', href } : null);
  const text =
    `Empresa: ${tenant.name}\n\n` +
    alerts.map((a) => `${formatDateTime(a.createdAt.toISOString()).slice(0, 16)}  ${(SEVERITY[a.severity] ?? SEVERITY.info).label}: ${a.message}`).join('\n') +
    (href ? `\n\nAbrir no portal: ${href}` : '') +
    FOOT;
  return { subject, html, text };
}

export function reportMail(o: {
  tenant: { id: string; name: string };
  name: string;
  title: string;
  period: string;
  schedule: string;
  rows: number;
  truncated: boolean;
  filters: string[];
  attached: boolean;
}) {
  const subject = `[Tech Audit] ${o.name}: ${o.period}`.slice(0, 200);
  const lines = [
    ['Empresa', o.tenant.name],
    ['Relatório', o.title],
    ['Período', `${o.period} (horário de Brasília)`],
    ['Frequência', o.schedule],
    ['Linhas', o.rows.toLocaleString('pt-BR') + (o.truncated ? ' (limite atingido; o arquivo traz só as primeiras)' : '')],
    ...(o.filters.length ? [['Filtros', o.filters.join('; ')]] : []),
  ];
  const note = o.attached
    ? 'O relatório vai em anexo.'
    : 'O arquivo ficou grande demais para ir por e-mail. Gere o relatório no portal, com um período menor ou mais filtros.';
  const html = frame(
    o.name,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">${lines
      .map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#6b6478;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`)
      .join('')}</table><p style="margin:16px 0 0">${esc(note)}</p>`,
    link('/relatorios', o.tenant.id) ? { label: 'Abrir relatórios no portal', href: link('/relatorios', o.tenant.id)! } : null,
  );
  const text = lines.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\n${note}` + FOOT;
  return { subject, html, text };
}

export function testMail(tenant: { id: string; name: string }, by: string) {
  const subject = `[Tech Audit] ${tenant.name}: e-mail de teste`;
  const body = `<p style="margin:0">Este é um e-mail de teste dos alertas da empresa <strong>${esc(tenant.name)}</strong>, enviado por ${esc(by)}. Se chegou, os alertas e relatórios agendados também vão chegar.</p>`;
  const href = link('/alertas', tenant.id);
  return {
    subject,
    html: frame('E-mail de teste', body, href ? { label: 'Abrir no portal', href } : null),
    text: `Este é um e-mail de teste dos alertas da empresa ${tenant.name}, enviado por ${by}. Se chegou, os alertas e relatórios agendados também vão chegar.${href ? `\n\n${href}` : ''}${FOOT}`,
  };
}
