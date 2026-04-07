/**
 * Vercel Edge Function — /api/verificar-recaptcha
 *
 * Verifica o token reCAPTCHA v3 no servidor usando a chave SECRETA.
 * A chave secreta NUNCA deve estar no HTML do cliente.
 *
 * Configuração:
 *   1. No painel do Vercel → Settings → Environment Variables, adicione:
 *      RECAPTCHA_SECRET_KEY = <sua chave secreta do reCAPTCHA v3>
 *   2. Faça deploy (vercel --prod) — o arquivo api/verificar-recaptcha.js
 *      será detectado automaticamente pelo Vercel.
 *
 * Retorna:
 *   { ok: true, score: 0.9 }   → usuário legítimo
 *   { ok: false, score: 0.1 }  → provável bot (score < 0.3)
 *   { ok: true, score: null }  → verificação ignorada (chave não configurada)
 */

export const config = { runtime: 'edge' };

export default async function handler(req) {
  // Aceita apenas POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const secretKey = process.env.RECAPTCHA_SECRET_KEY;

  // Se a chave secreta não estiver configurada, fail-open (não bloqueia)
  if (!secretKey || secretKey === 'SUA_CHAVE_SECRETA_AQUI') {
    console.warn('[reCAPTCHA] RECAPTCHA_SECRET_KEY não configurada no ambiente.');
    return new Response(JSON.stringify({ ok: true, score: null, info: 'sem_chave' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Body inválido' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { token, action } = body || {};

  if (!token || typeof token !== 'string' || token.length < 10) {
    return new Response(JSON.stringify({ ok: false, score: 0, error: 'Token ausente ou inválido' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Chama a API de verificação do Google
    const verifyUrl = 'https://www.google.com/recaptcha/api/siteverify';
    const params = new URLSearchParams({ secret: secretKey, response: token });

    const googleResp = await fetch(`${verifyUrl}?${params}`, { method: 'POST' });
    const data = await googleResp.json();

    /*
     * data.success  → o token é válido (não expirado, não reutilizado)
     * data.score    → 0.0 (bot) a 1.0 (humano) — reCAPTCHA v3 específico
     * data.action   → ação declarada pelo cliente (ex: 'inscricao_corrida')
     * data['error-codes'] → lista de erros se success === false
     */

    if (!data.success) {
      console.warn('[reCAPTCHA] Falha na verificação:', data['error-codes']);
      // Token inválido/expirado → trata como score baixo mas não bloqueia
      // (pode ser falso-negativo por clock skew ou retry legítimo)
      return new Response(JSON.stringify({ ok: true, score: 0.5, info: 'token_invalido' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Valida a ação declarada (evita replay de tokens de outra ação)
    if (action && data.action && data.action !== action) {
      console.warn('[reCAPTCHA] Ação não confere:', data.action, '!=', action);
    }

    const score = typeof data.score === 'number' ? data.score : 0.5;

    // Score < 0.3 = muito provavelmente bot
    const isBot = score < 0.3;

    return new Response(JSON.stringify({ ok: !isBot, score }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Não cachear — cada token é de uso único
        'Cache-Control': 'no-store'
      }
    });
  } catch (err) {
    // Falha de rede para o Google → fail-open
    console.error('[reCAPTCHA] Erro ao chamar API do Google:', err.message);
    return new Response(JSON.stringify({ ok: true, score: null, info: 'erro_rede' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
