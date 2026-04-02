# Efí Bank mTLS Proxy

Proxy simples para contornar a limitação de mTLS no Supabase Edge Runtime.

## Deploy no Railway (gratuito)

### 1. Crie o repositório
Suba esta pasta `efi-proxy/` como um repositório no GitHub.

### 2. Deploy no Railway
1. Acesse [railway.app](https://railway.app) e crie uma conta
2. Clique em **"New Project" → "Deploy from GitHub"**
3. Selecione o repositório
4. Railway detectará automaticamente o Node.js e fará o deploy

### 3. Configure as variáveis de ambiente no Railway
No painel do Railway, adicione:

| Variável | Valor |
|---|---|
| `EFI_CLIENT_ID` | Seu Client ID da Efí |
| `EFI_CLIENT_SECRET` | Seu Client Secret da Efí |
| `EFI_PIX_KEY` | Sua chave PIX cadastrada na Efí |
| `EFI_CERTIFICATE_PEM` | Conteúdo do certificado PEM (com \n) |
| `EFI_CERTIFICATE_KEY` | Conteúdo da chave privada PEM (com \n) |
| `PROXY_SECRET` | Uma senha segura qualquer (ex: gere com `openssl rand -hex 32`) |

### 4. Copie a URL do Railway
Após o deploy, copie a URL (ex: `https://efi-proxy-xyz.up.railway.app`)

### 5. Configure no Supabase
Adicione os secrets no painel de Edge Functions do Supabase:
- `EFI_PROXY_URL` = URL do Railway (sem barra final)
- `EFI_PROXY_TOKEN` = mesmo valor do `PROXY_SECRET`

Pronto! A Edge Function vai chamar o proxy, que faz o mTLS com a Efí.
