# Deploy A4 CLUB Importador no Railway

Railway é a plataforma perfeita: mesma que você já usa pro AeroFuel GP.

## Pré-requisito

- Repo no GitHub (público ou privado)
- Conta Railway

## Passo a passo

### 1. Push para GitHub

```bash
cd /home/seu-usuario/a4club-importador
git init
git add .
git commit -m "Importador A4 CLUB inicial"
git remote add origin https://github.com/seu-usuario/a4club-importador
git push -u origin main
```

### 2. No Railway Dashboard

1. Clica **"New Project"**
2. Conecta sua conta GitHub
3. Seleciona o repo `a4club-importador`
4. Railway detecta automaticamente Node.js

### 3. Cria o banco PostgreSQL

Railway Dashboard → **Plugins** → **PostgreSQL**

Railway gera automaticamente `DATABASE_URL` e coloca em environment variables.

### 4. Configura variáveis de ambiente

Railway Dashboard → **Variables**

Adiciona tudo de `.env.example`:

```
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
STORAGE_ENDPOINT=https://xxx.r2.cloudflarestorage.com
STORAGE_ACCESS_KEY_ID=xxx
STORAGE_SECRET_ACCESS_KEY=xxx
STORAGE_BUCKET=a4club-arquivos
IMPORT_PARALELISMO=4
DEFAULT_EMPRESA_ID=a4digital-default
ADMIN_TOKEN=seu-token-secreto-aqui
```

(DATABASE_URL já vem do PostgreSQL plugin)

### 5. Deploy

Railway faz auto-deploy quando você faz push pra main.

Ou manual: Railway Dashboard → **Deploy**

### 6. Verifica

```bash
curl https://seu-projeto.railway.app/health
```

Se retornar `{"ok":true}`, está rodando.

## URLs de acesso

```
Produção: https://seu-projeto.railway.app
Health: https://seu-projeto.railway.app/health
Painel Admin: https://seu-projeto.railway.app/admin/stats
```

## Atualizações futuras

```bash
# Local
git add .
git commit -m "Adiciona processamento de ZIP"
git push origin main

# Railway auto-redeploy em 2-3 segundos
```

## Monitoramento

Railway Dashboard → **Logs** → vê tudo em real-time.

```
[INFO] Mapeando estrutura do Shared Drive...
[INFO] Mapeados 5000 itens...
[INFO] Iniciando download de 234 arquivos...
```

## Rollback (se der ruim)

Railway Dashboard → **Deployments** → clica em uma versão anterior.

Boom, volta ao que era.

## Escalabilidade

Railway já faz:
- ✅ Auto-replicação de banco
- ✅ Backups automáticos
- ✅ Connection pooling
- ✅ CDN nos logs

Tá bom pra 100K+ arquivos e 1000+ users simultâneos.

## Custos

- PostgreSQL: $7/mês
- Node.js server: $5/mês (0.5vCPU)
- Total: ~$12/mês

(Se crescer muito, escala automático.)

---

**Dúvida?** Manda msg que eu ajudo com deployment.
