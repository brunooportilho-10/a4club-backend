// ============================================================
// A4 CLUB - Express Server
// Admin: OAuth, iniciar importacao, ver status/logs
// Publico: catálogo, busca, download (versão demo)
// ============================================================
const express = require('express');
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const {
  urlDeAutorizacao,
  trocarCodigoPorTokens,
  listarSharedDrives,
} = require('./google');
const { iniciarImportacao, sincronizacaoDiaria } = require('./importer');

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.static('public'));

// ============================================================
// MIDDLEWARE
// ============================================================
async function autentico(req, res, next) {
  const token = req.headers.authorization?.slice(7);
  if (token === process.env.ADMIN_TOKEN) {
    req.admin = true;
    next();
  } else {
    res.status(401).json({ erro: 'Nao autorizado' });
  }
}

// ============================================================
// ROTAS ADMIN (importacao)
// ============================================================

// 1. Inicia o fluxo OAuth
app.get('/admin/auth/google', autentico, (req, res) => {
  const url = urlDeAutorizacao();
  res.json({ url });
});

// 2. Recebe o callback do Google (user clica "autorizar")
app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Codigo nao recebido');

  try {
    const { tokens, email } = await trocarCodigoPorTokens(code);
    const empresaId = state || process.env.DEFAULT_EMPRESA_ID;

    // Salva a conta no banco (upsert)
    await prisma.contaGoogle.upsert({
      where: { empresaId_email: { empresaId, email } },
      update: { refreshToken: tokens.refresh_token },
      create: {
        empresaId,
        email,
        refreshToken: tokens.refresh_token,
      },
    });

    res.send(`
      <h2>Autorizado com sucesso! 🎉</h2>
      <p>Conta conectada: ${email}</p>
      <p>Voce pode fechar esta janela e voltar para o painel.</p>
    `);
  } catch (e) {
    res.status(500).send(`Erro: ${e.message}`);
  }
});

// 3. Lista Shared Drives disponiveis
app.get('/admin/drives', autentico, async (req, res) => {
  try {
    const conta = await prisma.contaGoogle.findFirst({
      where: { empresaId: process.env.DEFAULT_EMPRESA_ID },
      orderBy: { criadoEm: 'desc' },
    });
    if (!conta) return res.status(400).json({ erro: 'Nenhuma conta Google conectada' });

    const drives = await listarSharedDrives(conta.refreshToken);
    res.json({ drives });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// 4. Inicia a importacao de um Shared Drive
app.post('/admin/importar', autentico, async (req, res) => {
  const { driveId, driveNome, incremental } = req.body;
  if (!driveId) return res.status(400).json({ erro: 'driveId obrigatorio' });

  try {
    const job = await iniciarImportacao(
      process.env.DEFAULT_EMPRESA_ID,
      driveId,
      driveNome,
      incremental || false
    );
    res.json({
      jobId: job.id,
      status: job.status,
      mensagem: 'Importacao iniciada em segundo plano.',
    });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// 5. Status de um job de importacao
app.get('/admin/job/:jobId', autentico, async (req, res) => {
  const job = await prisma.importJob.findUnique({
    where: { id: req.params.jobId },
    include: { logs: { orderBy: { criadoEm: 'desc' }, take: 100 } },
  });
  if (!job) return res.status(404).json({ erro: 'Job nao encontrado' });

  const pct = job.totalArquivos
    ? Math.round((job.concluidos / job.totalArquivos) * 100)
    : 0;
  res.json({ ...job, percentualConcluido: pct });
});

// 6. Pausa um job (voltar depois)
app.post('/admin/job/:jobId/pausar', autentico, async (req, res) => {
  const job = await prisma.importJob.findUnique({
    where: { id: req.params.jobId },
  });
  if (!job) return res.status(404).json({ erro: 'Job nao encontrado' });
  if (job.status === 'CONCLUIDO') {
    return res.status(400).json({ erro: 'Job ja foi concluido' });
  }
  await prisma.importJob.update({
    where: { id: req.params.jobId },
    data: { status: 'PAUSADO' },
  });
  res.json({ mensagem: 'Job pausado. Rode /admin/job/:jobId/retomar para continuar.' });
});

// 7. Retoma um job pausado
app.post('/admin/job/:jobId/retomar', autentico, async (req, res) => {
  const job = await prisma.importJob.findUnique({
    where: { id: req.params.jobId },
  });
  if (!job) return res.status(404).json({ erro: 'Job nao encontrado' });
  if (job.status !== 'PAUSADO') {
    return res.status(400).json({ erro: 'Job nao esta pausado' });
  }
  // Dispara a importacao de novo (se houver pendentes)
  const { iniciarImportacao: init } = require('./importer');
  try {
    await init(job.empresaId, job.driveId, job.driveNome, job.incremental);
    res.json({ mensagem: 'Job retomado.' });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// ============================================================
// ROTAS PUBLICAS (catálogo para usuarios)
// ============================================================

// 1. Home: categorias + novidades + mais baixados
app.get('/api/catalogo/home', async (req, res) => {
  try {
    const empresaId = process.env.DEFAULT_EMPRESA_ID;

    // Top 8 categorias por arquivo concluido
    const categorias = await prisma.pasta.findMany({
      where: { empresaId },
      include: {
        _count: { select: { arquivos: { where: { status: 'CONCLUIDO' } } } },
      },
      orderBy: { _count: { arquivos: 'desc' } },
      take: 8,
    });

    // 8 novidades (arquivos CONCLUIDO mais recentes)
    const novidades = await prisma.arquivo.findMany({
      where: { empresaId, status: 'CONCLUIDO' },
      orderBy: { criadoEm: 'desc' },
      take: 8,
      select: {
        id: true,
        nome: true,
        extensao: true,
        tamanho: true,
        pasta: { select: { caminho: true } },
      },
    });

    res.json({ categorias, novidades });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// 2. Busca por nome, pasta, extensao
app.get('/api/catalogo/buscar', async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ erro: 'q obrigatorio' });

  try {
    const empresaId = process.env.DEFAULT_EMPRESA_ID;
    const termos = q.trim().toLowerCase().split(/\s+/);

    // Busca CONCLUIDOS com termo em nome OU extensao OU pasta
    const arquivos = await prisma.arquivo.findMany({
      where: {
        empresaId,
        status: 'CONCLUIDO',
        OR: [
          ...termos.map((t) => ({ nome: { contains: t, mode: 'insensitive' } })),
          ...termos.map((t) => ({ extensao: { contains: t, mode: 'insensitive' } })),
          ...termos.map((t) => ({
            pasta: { caminho: { contains: t, mode: 'insensitive' } },
          })),
        ],
      },
      include: { pasta: { select: { caminho: true } } },
      take: parseInt(limit),
    });

    res.json({ total: arquivos.length, arquivos });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// 3. Detalhe de um arquivo (+ meta para front fazer preview)
app.get('/api/catalogo/arquivo/:id', async (req, res) => {
  try {
    const arquivo = await prisma.arquivo.findUnique({
      where: { id: req.params.id },
      include: { pasta: true },
    });
    if (!arquivo) return res.status(404).json({ erro: 'Arquivo nao encontrado' });
    if (arquivo.status !== 'CONCLUIDO') {
      return res.status(403).json({ erro: 'Arquivo ainda nao disponivel' });
    }
    // Nao exponha a chave R2 diretamente; front solicita download via endpoint separado
    res.json({
      id: arquivo.id,
      nome: arquivo.nome,
      extensao: arquivo.extensao,
      tamanho: arquivo.tamanho.toString(),
      pasta: arquivo.pasta?.caminho || '(raiz)',
      criadoEm: arquivo.criadoEm,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// 4. Gera URL temporaria de download (assinada, expire em 1h)
// Nota: na versao real, integrar com CloudFlare Worker para gerar presigned URL
app.post('/api/catalogo/arquivo/:id/download', async (req, res) => {
  const { userId } = req.body; // no futuro: validar assinatura do usuario
  try {
    const arquivo = await prisma.arquivo.findUnique({
      where: { id: req.params.id },
    });
    if (!arquivo || arquivo.status !== 'CONCLUIDO') {
      return res.status(404).json({ erro: 'Arquivo nao disponivel' });
    }

    // PLACEHOLDER: versao real gera presigned URL via boto3/AWS SDK
    // Por enquanto, retorna um objeto com instruções de como o frontend
    // deveria requerer a URL via CloudFlare Worker
    res.json({
      downloadUrl: `https://r2-downloads.a4club.com.br/${arquivo.r2Key}?expires=3600`,
      nome: arquivo.nome,
      mensagem: '(Esta eh uma URL de exemplo. Setup real exige presigned URLs do R2)',
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ============================================================
// MONITORAMENTO / STATUS
// ============================================================

app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/admin/stats', autentico, async (req, res) => {
  try {
    const empresaId = process.env.DEFAULT_EMPRESA_ID;
    const stats = await prisma.arquivo.groupBy({
      by: ['status'],
      where: { empresaId },
      _count: true,
      _sum: { tamanho: true },
    });
    const jobAtivo = await prisma.importJob.findFirst({
      where: { empresaId, status: { in: ['MAPEANDO', 'BAIXANDO'] } },
    });
    res.json({
      ultimaVerificacao: new Date(),
      stats,
      importacaoEmAndamento: jobAtivo || null,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ============================================================
// INICIALIZACAO
// ============================================================

async function inicializar() {
  // Cria a empresa padrao se nao existir
  const empresaPadrao = process.env.DEFAULT_EMPRESA_ID || 'a4digital-default';
  await prisma.empresa.upsert({
    where: { id: empresaPadrao },
    update: {},
    create: { id: empresaPadrao, nome: 'A4 Digital', slug: 'a4digital' },
  });

  // Sincronizacao diaria: todo dia 02:00
  cron.schedule('0 2 * * *', async () => {
    console.log('[CRON] Sincronizacao diaria iniciada...');
    await sincronizacaoDiaria();
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[A4 CLUB] Servidor rodando em http://localhost:${PORT}`);
    console.log(`[A4 CLUB] Documentacao: GET /health, GET /admin/stats`);
  });
}

inicializar().catch((e) => {
  console.error('Falha ao inicializar:', e);
  process.exit(1);
});
