import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canEditNotifications, deliveryKind, deliveryStatus, HOURS } from '../lib/notifications.ts';

describe('alertas e e-mails', () => {
  it('situação do envio', () => {
    assert.deepEqual(deliveryStatus('sent'), { label: 'Enviado', tone: 'ok' });
    assert.equal(deliveryStatus('skipped').label, 'Não enviado');
    assert.equal(deliveryStatus(null).label, 'Ainda não enviado');
    assert.equal(deliveryKind('report'), 'Relatório agendado');
  });

  it('horas e perfis', () => {
    assert.equal(HOURS.length, 24);
    assert.deepEqual(HOURS[7], [7, '07:00']);
    assert.equal(canEditNotifications('tenant_admin'), true);
    assert.equal(canEditNotifications('tenant_auditor'), false);
  });
});
