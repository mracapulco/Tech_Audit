'use client';

import { useActionState } from 'react';
import { LogoMark } from '@/components/logo';
import { login, type LoginState } from '../actions';

export function LoginForm({ notice }: { notice?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, undefined);
  return (
    <form action={action} className="login">
      <LogoMark size={48} className="login-mark" />
      <div>
        <h1>Entrar</h1>
        <p className="muted">Acesse o portal de auditoria da sua empresa.</p>
      </div>
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
      <button type="submit" className="login-submit" disabled={pending}>
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
      <p className="muted small">Esqueceu a senha? Fale com o administrador da sua empresa.</p>
    </form>
  );
}
