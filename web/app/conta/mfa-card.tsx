'use client';

import { useActionState, useState } from 'react';
import { confirmMfa, disableMfa, startMfa, type MfaState } from './actions';

// Ativar ou desativar a verificação em duas etapas em "Minha conta".
export function MfaCard({ enabled, required }: { enabled: boolean; required: boolean }) {
  const [setup, setSetup] = useState<MfaState>(undefined);
  const [loading, setLoading] = useState(false);
  const [confirmState, confirm, confirming] = useActionState(confirmMfa, undefined);
  const [disableState, disable, disabling] = useActionState(disableMfa, undefined);

  if (enabled) {
    return (
      <>
        <p>
          <span className="pill ok">Ativa</span> O login pede o código do aplicativo autenticador além da senha.
        </p>
        {confirmState?.ok && <p className="ok-msg">{confirmState.ok}</p>}
        {required ? (
          <p className="muted small">Obrigatória para o seu perfil. Se trocar de celular, peça ao administrador para redefinir.</p>
        ) : (
          <form action={disable} className="grid-form">
            <label>
              Senha atual, para desativar
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <div className="form-actions">
              <button type="submit" className="secondary" disabled={disabling}>
                {disabling ? 'Aguarde…' : 'Desativar'}
              </button>
              {disableState?.error && <span className="error inline">{disableState.error}</span>}
            </div>
          </form>
        )}
      </>
    );
  }

  return (
    <>
      <p>
        <span className="pill neutral">Desativada</span> Com ela, quem descobrir a sua senha ainda precisa do seu celular para entrar.
      </p>
      {disableState?.ok && <p className="ok-msg">{disableState.ok}</p>}
      {!setup?.qr ? (
        <div className="form-actions">
          <button
            type="button"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              setSetup(await startMfa());
              setLoading(false);
            }}
          >
            {loading ? 'Aguarde…' : 'Ativar'}
          </button>
          {setup?.error && <span className="error inline">{setup.error}</span>}
        </div>
      ) : (
        <form action={confirm} className="login">
          <ol className="mfa-steps">
            <li>Instale o Google Authenticator (ou Microsoft Authenticator) no celular.</li>
            <li>
              No aplicativo, toque em <strong>+</strong> e leia o QR code:
              <img src={setup.qr} alt="QR code para o aplicativo autenticador" width={180} height={180} className="mfa-qr" />
              <span className="muted small">
                Sem câmera? Digite a chave <code className="mfa-key">{setup.secret?.replace(/(.{4})/g, '$1 ').trim()}</code>
              </span>
            </li>
            <li>Digite abaixo o código que aparecer.</li>
          </ol>
          <label>
            Código
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} placeholder="000000" required className="mfa-code" />
          </label>
          <div className="form-actions">
            <button type="submit" disabled={confirming}>
              {confirming ? 'Conferindo…' : 'Confirmar'}
            </button>
            {confirmState?.error && <span className="error inline">{confirmState.error}</span>}
          </div>
        </form>
      )}
    </>
  );
}
