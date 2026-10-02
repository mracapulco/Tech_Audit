import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { agentPortOnly } from '../src/agent-port.js';

// Simula uma requisição chegando na porta local informada.
function run(localPort: number, path: string) {
  let status: number | undefined;
  let passed = false;
  const req = { socket: { localPort }, path } as unknown as Request;
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  agentPortOnly(3002)(req, res, (() => (passed = true)) as NextFunction);
  return { status, passed };
}

describe('porta dos agentes', () => {
  it('responde só /v1/* na porta dos agentes', () => {
    assert.deepEqual(run(3002, '/v1/events'), { status: undefined, passed: true });
    assert.deepEqual(run(3002, '/api/auth/login'), { status: 404, passed: false });
    assert.deepEqual(run(3002, '/api/admin/users'), { status: 404, passed: false });
    assert.deepEqual(run(3002, '/v1'), { status: 404, passed: false });
  });

  it('não muda nada na porta interna', () => {
    assert.deepEqual(run(3001, '/api/auth/login'), { status: undefined, passed: true });
    assert.deepEqual(run(3001, '/v1/events'), { status: undefined, passed: true });
  });
});
