# Torrents BR - Addon Stremio (estilo Torrentio)

Addon para Stremio que busca torrents em sites brasileiros de forma automática, com cache otimizado e múltiplos provedores.

## 🚀 Funcionalidades

- ✅ Busca automática em múltiplos sites brasileiros
- ✅ Cache com Redis para performance
- ✅ Ordenação por qualidade e seeds
- ✅ Suporte a filmes e séries
- ✅ Tratamento de erros robusto
- ✅ Rate limiting para evitar bloqueios
- ✅ Health check para monitoramento
- ✅ Logs detalhados para debug

## 📋 Pré-requisitos

### Obrigatórios
- **Node.js** 16+ 
- **npm** ou **yarn**

### Recomendados
- **Redis** (para cache - opcional mas recomendado)
  - Sem Redis, o addon funciona mas sem cache, o que pode causar lentidão
  - Instale via [Redis oficial](https://redis.io/docs/install/install-redis/) ou use Docker:
    ```bash
    docker run -d -p 6379:6379 --name redis redis:alpine
    ```

## 🛠️ Instalação

1. Clone ou baixe o repositório:
   ```bash
   cd api-torrents-br-puppeteer
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

3. Configure o arquivo `.env` (opcional):
   ```env
   PORT=3000
   REDIS_URL=redis://localhost:6379
   DEBUG=false
   ```

## ▶️ Como rodar

### Desenvolvimento
```bash
npm run dev
```

### Produção
```bash
npm start
```

O addon estará disponível em: `http://localhost:3000`

## 🚀 Instalação no Stremio

### Opção 1: Deploy na Vercel (Recomendado)

1. **Faça deploy na Vercel:**
   ```bash
   # Instale a CLI da Vercel
   npm i -g vercel

   # Faça login
   vercel login

   # Deploy
   vercel
   ```

2. **Configure as variáveis de ambiente:**
   - No dashboard da Vercel, vá em **Settings > Environment Variables**
   - Adicione `REDIS_URL` (opcional mas recomendado)

3. **Adicione ao Stremio:**
   - Acesse seu deploy: `https://seu-app.vercel.app`
   - Clique em **INSTALAR NO STREMIO**
   - Ou copie o manifest: `https://seu-app.vercel.app/manifest.json`

### Opção 2: Local

1. Abra o Stremio
2. Vá para **Add-ons**
3. Cole o URL do manifest:
   ```
   http://localhost:3000/manifest.json
   ```
4. Clique em **Add**

> **Nota:** Para uso remoto, substitua `localhost` pelo IP/domínio do seu servidor.

## 📡 Endpoints

| Endpoint | Descrição |
|----------|-----------|
| `GET /` | Página inicial com informações |
| `GET /manifest.json` | Manifest para Stremio |
| `GET /health` | Health check |
| `GET /stream/movie/tt1234567.json` | Buscar streams de filme |
| `GET /stream/series/tt1234567/1/2.json` | Buscar streams de série (S1E2) |
| `GET /search?q=Matrix` | Busca manual (para teste) |

## 🌐 Deploy na Vercel

### Deploy Rápido

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/seu-usuario/api-torrents-br-puppeteer)

### Passo a Passo

1. **Instale a CLI da Vercel:**
   ```bash
   npm i -g vercel
   ```

2. **Faça login:**
   ```bash
   vercel login
   ```

3. **Deploy:**
   ```bash
   vercel
   ```

4. **Deploy para produção:**
   ```bash
   vercel --prod
   ```

### Configuração de Variáveis de Ambiente

No dashboard da Vercel (**Settings > Environment Variables**), adicione:

| Variável | Valor | Obrigatório? |
|----------|-------|--------------|
| `REDIS_URL` | `redis://user:pass@host:port` | Não (recomendado) |
| `BASE_URL` | `torrents-br.vercel.app` | Não |
| `DEBUG` | `true` ou `false` | Não |

### Limitações da Vercel

⚠️ **Importante:** A Vercel é uma plataforma serverless com limitações:

- **Timeout máximo**: 60 segundos (plano free: 10s)
- **Puppeteer**: Pode ser lento em serverless
- **Sem estado**: Não há browser persistente

**Recomendações:**
- Use **Redis externo** (Upstash, Redis Cloud)
- Considere **Railway**, **Render** ou **Fly.io** para melhor performance
- Para uso pesado, use um **VPS** dedicado

## 🏗️ Arquitetura

```
Stremio → Addon → Cinemeta (metadados)
              → Redis (cache)
              → Puppeteer (scraping)
                → comando.la
                → bludv1.com
                → hdrtorrent.com
                → redetorrent.com
                → torrentsdosfilmes1.com
```

## ⚙️ Otimizações

- **Cache TTL**: 1 hora (configurável)
- **Rate Limiting**: 1 segundo entre requests por site
- **Concorrência**: Máximo 2 scrapes simultâneos
- **Retry**: 3 tentativas para scraping falho
- **Browser**: Reutiliza instância do Puppeteer
- **Limpeza automática**: Fecha páginas órfãs a cada 5 min

## 🐛 Troubleshooting

### Redis não conecta
O addon funciona sem Redis, mas para melhor performance:
```bash
# Verificar se Redis está rodando
docker ps | grep redis

# Ou iniciar Redis local
redis-server
```

### Puppeteer falha ao iniciar
```bash
# Linux: instalar dependências do Chrome
sudo apt-get install -y gconf-service libxext6 libxfixes3 libxi6 libxrandr2 \
  libxrender1 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
  libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 \
  libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 \
  libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxss1 \
  libxtst6 libappindicator1 libnss3 libasound2 libatk1.0-0 libc6 ca-certificates \
  fonts-liberation lsb-release xdg-utils wget
```

### Sites não retornam resultados
- Sites podem estar offline ou mudaram estrutura
- Verifique os logs para erros específicos
- Ative `DEBUG=true` para logs detalhados

## 📝 Notas

- Este addon é para uso pessoal e educacional
- Os torrents são buscados de sites terceiros
- Não nos responsabilizamos pelo conteúdo dos torrents
- Respeite as leis de direitos autorais do seu país

## 🔄 Changelog

### v2.1.0
- ✅ Deploy na Vercel com serverless functions
- ✅ Página inicial com informações dos sites
- ✅ Botão INSTALAR NO STREMIO
- ✅ Botão COPIAR MANIFEST
- ✅ Tratamento de erros robusto
- ✅ Health check endpoint
- ✅ Logs detalhados
- ✅ Rate limiting
- ✅ Retry automático
- ✅ Prevenção de memory leaks
- ✅ Validação de magnets
- ✅ Performance otimizada

### v2.0.0
- Versão inicial estilo Torrentio

## 📄 Licença

MIT
