// ============================================================
// A4 CLUB - Conexao com Google (OAuth + Drive somente leitura)
// ============================================================
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function criarOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/google/callback`
  );
}

// URL para o administrador autorizar o acesso
function urlDeAutorizacao() {
  const oauth = criarOAuthClient();
  return oauth.generateAuthUrl({
    access_type: 'offline', // garante refresh_token
    prompt: 'consent',
    scope: SCOPES,
  });
}

// Troca o codigo do callback por tokens
async function trocarCodigoPorTokens(code) {
  const oauth = criarOAuthClient();
  const { tokens } = await oauth.getToken(code);
  oauth.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth });
  const { data: perfil } = await oauth2.userinfo.get().catch(() => ({ data: {} }));
  return { tokens, email: perfil.email || 'conta-google' };
}

// Cria um cliente Drive autenticado a partir do refresh token salvo
function driveClient(refreshToken) {
  const oauth = criarOAuthClient();
  oauth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth: oauth });
}

// Lista os Shared Drives disponiveis para a conta
async function listarSharedDrives(refreshToken) {
  const drive = driveClient(refreshToken);
  const drives = [];
  let pageToken;
  do {
    const { data } = await drive.drives.list({ pageSize: 100, pageToken });
    drives.push(...(data.drives || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return drives;
}

// Percorre TODO o Shared Drive (arquivos + pastas) com paginacao.
// Muito mais rapido que recursao pasta a pasta.
async function listarTudoDoDrive(refreshToken, driveId, aoReceberPagina) {
  const drive = driveClient(refreshToken);
  let pageToken;
  let total = 0;
  do {
    const { data } = await drive.files.list({
      corpora: 'drive',
      driveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 1000,
      q: 'trashed = false',
      fields:
        'nextPageToken, files(id, name, mimeType, size, md5Checksum, parents, modifiedTime)',
      pageToken,
    });
    const itens = data.files || [];
    total += itens.length;
    await aoReceberPagina(itens, total);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return total;
}

// Stream de download do conteudo de um arquivo
async function baixarArquivoStream(refreshToken, fileId) {
  const drive = driveClient(refreshToken);
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  return res.data;
}

module.exports = {
  urlDeAutorizacao,
  trocarCodigoPorTokens,
  listarSharedDrives,
  listarTudoDoDrive,
  baixarArquivoStream,
};
