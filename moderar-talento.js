// Vercel Edge Function — Proxy seguro para moderação de talentos
// Arquivo: api/moderar-talento.js
// Deploy: adicione este arquivo na raiz do projeto Vercel ao lado de index.html
// A variável de ambiente ANTHROPIC_API_KEY deve ser configurada no painel Vercel:
//   Settings → Environment Variables → ANTHROPIC_API_KEY = sua_chave_aqui

export const config = { runtime: 'edge' };

// ── Rate limit simples por IP (em memória — reseta por instância da Edge Function) ──
// Para eventos maiores, substitua por Vercel KV: https://vercel.com/docs/storage/vercel-kv
const _hitMap = new Map();
const _RATE_LIMIT = 20;        // max requisições por janela
const _RATE_WINDOW_MS = 60000; // janela de 1 minuto

function _checkRateLimit(ip) {
  const now = Date.now();
  const entry = _hitMap.get(ip);
  if (!entry || now - entry.ts > _RATE_WINDOW_MS) {
    _hitMap.set(ip, { ts: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > _RATE_LIMIT) return false;
  return true;
}

function _jsonOk(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // ── Validação de Content-Type ──
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return _jsonOk({ aprovado: true, motivo: 'Content-Type inválido — aprovado automaticamente.' });
  }

  // ── Rate limit por IP ──
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (!_checkRateLimit(ip)) {
    console.warn('[moderar-talento] Rate limit atingido para IP:', ip);
    // Fail-open: não bloqueia o usuário, mas loga o abuso
    return _jsonOk({ aprovado: true, motivo: 'Limite de verificações atingido — aprovado automaticamente.' });
  }

  let valor = '';
  try {
    const body = await req.json();
    valor = String(body.valor || '').slice(0, 150).trim();
  } catch {
    return _jsonOk({ aprovado: true, motivo: 'Erro ao ler corpo da requisição.' });
  }

  if (!valor || valor.length < 3) {
    return _jsonOk({ aprovado: true, motivo: 'Campo vazio — aprovado automaticamente.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[moderar-talento] ANTHROPIC_API_KEY não configurada.');
    return _jsonOk({ aprovado: true, motivo: 'Moderação indisponível — aprovado automaticamente.' });
  }

  try {
    // ── Timeout de 10s para não travar o usuário ──
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system: [
          'Você é um moderador de inscrições para um Show de Talentos Infantil/Familiar.',
          'O evento é voltado para crianças e famílias. Apresentações devem ser adequadas para todos os públicos.',
          'Analise o tipo de apresentação informado e responda SOMENTE com JSON no formato:',
          '{"aprovado": true/false, "motivo": "string curta em português"}',
          'Aprove qualquer talento artístico, criativo ou esportivo adequado ao público familiar.',
          'Bloqueie apenas conteúdo: sexual, violento, de ódio, relacionado a drogas/álcool, palavrões, ou claramente ofensivo.',
          'Seja tolerante e inclusivo. Em caso de dúvida, aprove.',
          'Responda APENAS com o JSON, sem mais nada.'
        ].join(' '),
        messages: [{ role: 'user', content: `Tipo de apresentação: "${valor}"` }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!resp.ok) throw new Error(`Anthropic ${resp.status}`);

    const data = await resp.json();
    const raw = (data.content || []).map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      throw new Error('JSON inválido na resposta da API');
    }

    // ── Validação da estrutura da resposta ──
    if (!parsed || typeof parsed.aprovado !== 'boolean') {
      throw new Error('Formato de resposta inesperado');
    }

    return _jsonOk(parsed);

  } catch (e) {
    console.error('[moderar-talento] Erro:', e.message);
    // fail-open: não bloqueia o usuário em caso de falha da API
    return _jsonOk({ aprovado: true, motivo: 'Verificação temporariamente indisponível.' });
  }
}
