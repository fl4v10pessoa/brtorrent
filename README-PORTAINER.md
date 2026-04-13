# Torrents BR - Addon Stremio com Jackett

Addon para Stremio que usa Jackett como fonte principal de torrents brasileiros.

## 🚀 Deploy no Portainer

### Opção 1: Via Stack (Docker Compose) - Recomendado

1. Acesse o Portainer: `http://SEU_IP:9000`
2. Vá em **Stacks** → **Add stack**
3. Nome: `torrents-br`
4. Cole o conteúdo do `docker-compose.yml`
5. Clique em **Deploy**

### Opção 2: Build manual

```bash
# Copie os arquivos para o VPS
scp -r . user@vps:/opt/torrents-br-addon

# No VPS
cd /opt/torrents-br-addon
docker compose up -d --build
```

## 📋 Pré-requisitos

- ✅ Jackett instalado e rodando
- ✅ Portainer/Docker instalado

## ⚙️ Variáveis de Ambiente

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `JACKETT_URL` | URL do Jackett | `http://204.216.132.119:9117` |
| `JACKETT_API_KEY` | API Key do Jackett | `xk0n30nw3vsydqj40klwwqw1jjw227om` |
| `REDIS_URL` | URL do Redis (opcional) | `redis://redis:6379` |
| `PORT` | Porta do addon | `3000` |

## 🔗 Instalar no Stremio

Após deploy, acesse:

```
http://SEU_IP_VPS:3000/manifest.json
```

Ou clique em **INSTALAR NO STREMIO** na página inicial.

## 📊 Endpoints

| Endpoint | Descrição |
|----------|-----------|
| `/` | Página inicial |
| `/manifest.json` | Manifesto do addon |
| `/health` | Health check |
| `/search?q=filme` | Busca manual |

## 🏗️ Arquitetura

```
Stremio → Addon (porta 3000) → Jackett (porta 9117) → Trackers
                ↓
            Redis (cache)
```

## 🔄 Atualizar

No Portainer:
1. **Stacks** → `torrents-br` → **Update**
2. Ou rode: `docker compose pull && docker compose up -d`

## 🐛 Logs

```bash
docker logs -f torrents-br-addon
docker logs -f torrents-br-redis
```
