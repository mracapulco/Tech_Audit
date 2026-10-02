import QRCode from 'qrcode';

// QR code do link otpauth:// em SVG, gerado no servidor do Next.js: o segredo
// não passa por nenhum serviço externo.
export async function qrDataUrl(otpauthUrl: string): Promise<string> {
  const svg = await QRCode.toString(otpauthUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export const otpauthUrl = (secret: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(`Tech Audit:${email}`)}?${new URLSearchParams({ secret, issuer: 'Tech Audit', algorithm: 'SHA1', digits: '6', period: '30' })}`;
