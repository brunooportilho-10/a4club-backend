// ============================================================
// A4 CLUB - Armazenamento definitivo (Cloudflare R2)
// Usa protocolo S3: trocar para Amazon S3 / Backblaze / Wasabi
// exige apenas mudar as variaveis de ambiente, sem tocar codigo.
// ============================================================
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const s3 = new S3Client({
  region: process.env.STORAGE_REGION || 'auto',
  endpoint: process.env.STORAGE_ENDPOINT, // ex: https://<account_id>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.STORAGE_BUCKET;

// Envia um stream direto para o bucket (sem salvar em disco)
async function enviarStream(chave, stream, mimeType) {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: chave,
      Body: stream,
      ContentType: mimeType || 'application/octet-stream',
    },
    queueSize: 3,
    partSize: 8 * 1024 * 1024, // partes de 8MB
  });
  await upload.done();
  return chave;
}

// Verifica se um objeto ja existe no bucket
async function objetoExiste(chave) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: chave }));
    return true;
  } catch {
    return false;
  }
}

module.exports = { enviarStream, objetoExiste };
