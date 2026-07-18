// ============================================================
// A4 CLUB - Motor de importacao
// 1) MAPEAR: percorre todo o Shared Drive e registra no banco
// 2) BAIXAR: em paralelo, Drive -> R2, com dedupe por MD5
// 3) RETOMAR: qualquer queda continua de onde parou (status no banco)
// 4) INCREMENTAL: rodar de novo so processa o que e novo/alterado
// ============================================================
const { PrismaClient } = require('@prisma/client');
const pLimit = require('p-limit');
const {
  listarTudoDoDrive,
  baixarArquivoStream,
} = require('./google');
const { enviarStream } = require('./storage');

const prisma = new PrismaClient();

const PASTA_MIME = 'application/vnd.google-apps.folder';
const PARALELISMO = Number(process.env.IMPORT_PARALELISMO || 4);
const MAX_TENTATIVAS = 3;

// Formatos nativos do Google (Docs/Sheets/Slides) nao sao arquivos
// binarios - marcamos como IGNORADO e registramos no log.
const MIME_GOOGLE_NATIVO = /^application\/vnd\.google-apps\./;

let jobAtivo = null; // apenas 1 importacao por vez nesta versao

async function log(jobId, nivel, mensagem) {
  console.log(`[${nivel}] ${mensagem}`);
  await prisma.importLog.create({ data: { jobId, nivel, mensagem } });
}

function extensaoDe(nome) {
  const i = nome.lastIndexOf('.');
  return i > 0 ? nome.slice(i + 1).toLowerCase() : null;
}

function limparNome(nome) {
  return nome.replace(/[^\p{L}\p{N} ._()\-]/gu, '_');
}

// ------------------------------------------------------------
// FASE 1 - Mapear o Drive inteiro para o banco
// ------------------------------------------------------------
async function mapearDrive(job, refreshToken) {
  const { empresaId, driveId } = job;
  const pastasDrive = new Map(); // driveFolderId -> {nome, paiDriveId}
  const arquivosDrive = [];

  await log(job.id, 'INFO', 'Mapeando estrutura do Shared Drive...');

  await listarTudoDoDrive(refreshToken, driveId, async (itens, total) => {
    for (const item of itens) {
      if (item.mimeType === PASTA_MIME) {
        pastasDrive.set(item.id, {
          nome: item.name,
          paiDriveId: item.parents ? item.parents[0] : null,
        });
      } else {
        arquivosDrive.push(item);
      }
    }
    await log(job.id, 'INFO', `Mapeados ${total} itens...`);
  });

  // Monta o caminho completo de cada pasta (ex: Kits/Safari/Meninos)
  function caminhoDa(folderId, visitados = new Set()) {
    const p = pastasDrive.get(folderId);
    if (!p || visitados.has(folderId)) return '';
    visitados.add(folderId);
    const acima = p.paiDriveId ? caminhoDa(p.paiDriveId, visitados) : '';
    return acima ? `${acima}/${p.nome}` : p.nome;
  }

  // Salva as pastas no banco (upsert = seguro rodar de novo)
  const pastaIdPorDriveId = new Map();
  for (const [driveFolderId, p] of pastasDrive) {
    const registro = await prisma.pasta.upsert({
      where: { empresaId_driveFolderId: { empresaId, driveFolderId } },
      update: { nome: p.nome, caminho: caminhoDa(driveFolderId) },
      create: {
        empresaId,
        driveFolderId,
        nome: p.nome,
        caminho: caminhoDa(driveFolderId),
      },
    });
    pastaIdPorDriveId.set(driveFolderId, registro.id);
  }
  // Segunda passada: liga pai <-> filha
  for (const [driveFolderId, p] of pastasDrive) {
    if (p.paiDriveId && pastaIdPorDriveId.has(p.paiDriveId)) {
      await prisma.pasta.update({
        where: { empresaId_driveFolderId: { empresaId, driveFolderId } },
        data: { paiId: pastaIdPorDriveId.get(p.paiDriveId) },
      });
    }
  }
  await log(job.id, 'INFO', `${pastasDrive.size} pastas registradas.`);

  // Salva/atualiza os arquivos no banco
  let novos = 0;
  let alterados = 0;
  let inalterados = 0;

  for (const f of arquivosDrive) {
    const paiDriveId = f.parents ? f.parents[0] : null;
    const pastaId = paiDriveId ? pastaIdPorDriveId.get(paiDriveId) || null : null;
    const nativoGoogle = MIME_GOOGLE_NATIVO.test(f.mimeType);

    const existente = await prisma.arquivo.findUnique({
      where: { empresaId_driveFileId: { empresaId, driveFileId: f.id } },
    });

    if (!existente) {
      await prisma.arquivo.create({
        data: {
          empresaId,
          driveFileId: f.id,
          nome: f.name,
          extensao: extensaoDe(f.name),
          mimeType: f.mimeType,
          tamanho: BigInt(f.size || 0),
          md5Hash: f.md5Checksum || null,
          driveModifiedTime: f.modifiedTime ? new Date(f.modifiedTime) : null,
          pastaId,
          status: nativoGoogle ? 'IGNORADO' : 'PENDENTE',
          erro: nativoGoogle ? 'Arquivo nativo Google (Docs/Sheets) - nao importado' : null,
        },
      });
      novos++;
    } else if (
      existente.status === 'CONCLUIDO' &&
      existente.md5Hash === (f.md5Checksum || null)
    ) {
      inalterados++; // dedupe: nada a fazer
    } else {
      // arquivo alterado no Drive OU tentativa anterior incompleta
      await prisma.arquivo.update({
        where: { id: existente.id },
        data: {
          nome: f.name,
          extensao: extensaoDe(f.name),
          mimeType: f.mimeType,
          tamanho: BigInt(f.size || 0),
          md5Hash: f.md5Checksum || null,
          driveModifiedTime: f.modifiedTime ? new Date(f.modifiedTime) : null,
          pastaId,
          status: nativoGoogle ? 'IGNORADO' : 'PENDENTE',
          tentativas: 0,
          erro: null,
        },
      });
      alterados++;
    }
  }

  await log(
    job.id,
    'INFO',
    `Arquivos: ${novos} novos, ${alterados} para atualizar, ${inalterados} ja em dia (dedupe por hash).`
  );
}

// ------------------------------------------------------------
// FASE 2 - Baixar pendentes em paralelo (Drive -> R2)
// ------------------------------------------------------------
async function baixarPendentes(job, refreshToken) {
  const { empresaId } = job;

  const pendentes = await prisma.arquivo.findMany({
    where: { empresaId, status: { in: ['PENDENTE', 'ERRO'] }, tentativas: { lt: MAX_TENTATIVAS } },
    include: { pasta: true },
    orderBy: { criadoEm: 'asc' },
  });

  const bytesTotal = pendentes.reduce((s, a) => s + a.tamanho, 0n);
  await prisma.importJob.update({
    where: { id: job.id },
    data: {
      status: 'BAIXANDO',
      totalArquivos: pendentes.length,
      bytesTotal,
      concluidos: 0,
      erros: 0,
      bytesConcluidos: 0n,
    },
  });
  await log(job.id, 'INFO', `Iniciando download de ${pendentes.length} arquivos (${PARALELISMO} em paralelo).`);

  const limite = pLimit(PARALELISMO);

  await Promise.all(
    pendentes.map((arq) =>
      limite(async () => {
        try {
          await prisma.arquivo.update({
            where: { id: arq.id },
            data: { status: 'BAIXANDO', tentativas: { increment: 1 } },
          });

          const caminho = arq.pasta ? arq.pasta.caminho : '_raiz';
          const chaveR2 = `${empresaId}/${caminho}/${limparNome(arq.nome)}`
            .replace(/\/+/g, '/');

          const stream = await baixarArquivoStream(refreshToken, arq.driveFileId);
          await enviarStream(chaveR2, stream, arq.mimeType);

          await prisma.arquivo.update({
            where: { id: arq.id },
            data: { status: 'CONCLUIDO', r2Key: chaveR2, erro: null },
          });
          await prisma.importJob.update({
            where: { id: job.id },
            data: {
              concluidos: { increment: 1 },
              bytesConcluidos: { increment: arq.tamanho },
            },
          });
        } catch (e) {
          const msg = (e && e.message) || 'erro desconhecido';
          await prisma.arquivo.update({
            where: { id: arq.id },
            data: { status: 'ERRO', erro: msg.slice(0, 500) },
          });
          await prisma.importJob.update({
            where: { id: job.id },
            data: { erros: { increment: 1 } },
          });
          await log(job.id, 'ERRO', `Falha em "${arq.nome}": ${msg}`);
        }
      })
    )
  );
}

// ------------------------------------------------------------
// Orquestrador do job (roda em segundo plano)
// ------------------------------------------------------------
async function executarImportacao(jobId) {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  const conta = await prisma.contaGoogle.findFirst({
    where: { empresaId: job.empresaId },
    orderBy: { criadoEm: 'desc' },
  });
  if (!conta) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'ERRO', finalizadoEm: new Date() },
    });
    await log(jobId, 'ERRO', 'Nenhuma conta Google conectada.');
    return;
  }

  jobAtivo = jobId;
  try {
    await mapearDrive(job, conta.refreshToken);
    await baixarPendentes(job, conta.refreshToken);

    const restantes = await prisma.arquivo.count({
      where: { empresaId: job.empresaId, status: { in: ['PENDENTE', 'BAIXANDO', 'ERRO'] } },
    });
    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: restantes === 0 ? 'CONCLUIDO' : 'ERRO',
        finalizadoEm: new Date(),
      },
    });
    await log(
      jobId,
      restantes === 0 ? 'INFO' : 'AVISO',
      restantes === 0
        ? 'Importacao concluida com sucesso. Biblioteca 100% independente do Google Drive.'
        : `Importacao finalizada com ${restantes} arquivo(s) pendente(s)/com erro. Rode novamente para retomar.`
    );
  } catch (e) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'ERRO', finalizadoEm: new Date() },
    });
    await log(jobId, 'ERRO', `Falha geral: ${(e && e.message) || e}`);
  } finally {
    jobAtivo = null;
  }
}

// Cria o job e dispara em segundo plano
async function iniciarImportacao(empresaId, driveId, driveNome, incremental = false) {
  if (jobAtivo) {
    throw new Error('Ja existe uma importacao em andamento. Aguarde terminar.');
  }
  const job = await prisma.importJob.create({
    data: { empresaId, driveId, driveNome, incremental },
  });
  // fire-and-forget: roda em segundo plano
  executarImportacao(job.id).catch(console.error);
  return job;
}

// Sincronizacao diaria: reaproveita o mesmo fluxo (dedupe faz o resto)
async function sincronizacaoDiaria() {
  if (jobAtivo) return;
  const ultimo = await prisma.importJob.findFirst({
    where: { status: 'CONCLUIDO' },
    orderBy: { finalizadoEm: 'desc' },
  });
  if (!ultimo) return;
  console.log('[SYNC] Iniciando sincronizacao diaria...');
  await iniciarImportacao(ultimo.empresaId, ultimo.driveId, ultimo.driveNome, true);
}

module.exports = { iniciarImportacao, sincronizacaoDiaria, prisma };
