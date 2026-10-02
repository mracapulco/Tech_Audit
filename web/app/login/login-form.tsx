'use client';

import { useActionState } from 'react';
import { login, type LoginState } from '../actions';

export function LoginForm({ notice }: { notice?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, undefined);
  return (
    <form action={action} className="card login">
      <h1>Tech Audit</h1>
      <p className="muted">Auditoria de servidores de arquivos</p>
      {notice && !state?.error && <p className="notice">{notice}</p>}
      {state?.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <label>
        E-mail
        <input name="email" type="email" autoComplete="username" required defaultValue={state?.email} autoFocus />
      </label>
      <label>
        Senha
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
