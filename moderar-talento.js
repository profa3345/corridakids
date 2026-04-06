// Vercel Edge Function — Proxy seguro para moderação de talentos
// Arquivo: api/moderar-talento.js
// Deploy: adicione este arquivo na raiz do projeto Vercel ao lado de index.html
// A variável de ambiente ANTHROPIC_API_KEY deve ser configurada no painel Vercel:
//   Settings → Environment Variables → ANTHROPIC_API_KEY = sua_chave_aqui

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let valor = '';
  try {
    const body = await req.json();
    valor = String(body.valor || '').slice(0, 200).trim();
  } catch {
    return new Response(JSON.stringify({ aprovado: true, motivo: 'Erro ao ler corpo da requisição.' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!valor || valor.length < 3) {
    return new Response(JSON.stringify({ aprovado: true, motivo: 'Campo vazio — aprovado automaticamente.' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Sem chave configurada: aprova (fail-open) e loga warning
    console.warn('[moderar-talento] ANTHROPIC_API_KEY não configurada.');
    return new Response(JSON.stringify({ aprovado: true, motivo: 'Moderação indisponível — aprovado automaticamente.' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
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
      })
    });

    if (!resp.ok) throw new Error(`Anthropic ${resp.status}`);
    const data = await resp.json();
    const raw = (data.content || []).map(b => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return new Response(JSON.stringify(parsed), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[moderar-talento] Erro:', e.message);
    // fail-open: não bloqueia o usuário em caso de falha da API
    return new Response(JSON.stringify({ aprovado: true, motivo: 'Verificação temporariamente indisponível.' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
}
