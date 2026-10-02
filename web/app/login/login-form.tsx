'use client';

import { useActionState } from 'react';
import { LogoMark } from '@/components/logo';
import { login, type LoginState } from '../actions';

export function LoginForm({ notice }: { notice?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, undefined);
  const error = state?.error && (
    <p className="error" role="alert">
      {state.error}
    </p>
  );

  // Segunda etapa: código do autenticador (e, no primeiro acesso, o cadastro).
  if (state?.step && state.challenge) {
    const setup = state.step === 'setup';
    return (
      <form action={action} className="login" key={state.challenge}>
        <LogoMark size={48} className="login-mark" />
        <div>
          <h1>{setup ? 'Ative a verificação' : 'Verificação'}</h1>
          <p className="muted">
            {setup
              ? 'Sua conta exige um código do celular além da senha.'
              : 'Digite o código de 6 dígitos do aplicativo autenticador.'}
          </p>
        </div>
        {error}
        {setup && state.qr && state.secret && (
          <ol className="mfa-steps">
            <li>Instale o Google Authenticator (ou Microsoft Authenticator) no celular.</li>
            <li>
              No aplicativo, toque em <strong>+</strong> e leia o QR code:
              <img src={state.qr} alt="QR code para o aplicativo autenticador" width={180} height={180} className="mfa-qr" />
              <span className="muted small">
                Sem câmera? Digite a chave <code className="mfa-key">{groupKey(state.secret)}</code>
              </span>
            </li>
            <li>Digite abaixo o código que aparecer.</li>
          </ol>
        )}
        <input type="hidden" name="challenge" value={state.challenge} />
        <input type="hidden" name="email" value={state.email ?? ''} />
        {setup && <input type="hidden" name="secret" value={state.secret ?? ''} />}
        <label>
          Código
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            placeholder="000000"
            required
            autoFocus
            className="mfa-code"
          />
        </label>
        <button type="submit" className="login-submit" disabled={pending}>
          {pending ? 'Conferindo…' : setup ? 'Ativar e entrar' : 'Entrar'}
        </button>
        <p className="muted small">
          Perdeu o celular? Fale com o administrador do portal. <a href="/login">Voltar</a>
        </p>
      </form>
    );
  }

  return (
    <form action={action} className="login">
      <LogoMark size={48} className="login-mark" />
      <div>
        <h1>Entrar</h1>
        <p className="muted">Acesse o portal de auditoria da sua empresa.</p>
      </div>
      {notice && !state?.error && <p className="notice">{notice}</p>}
      {error}
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

const groupKey = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();
