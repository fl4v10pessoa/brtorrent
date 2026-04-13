# Torrents BR - Addon Stremio (estilo Torrentio)

Addon para Stremio que busca torrents de forma automática usando **Jackett API** e múltiplos provedores DHT, com cache otimizado e ordenação inteligente.

## 🚀 Funcionalidades

- ✅ **Jackett API** - Busca em 50+ trackers simultaneamente
- ✅ **Fallback DHT** - BTDigg e Nyaa como backup
- ✅ **Cache Redis** - Performance otimizada
- ✅ **Ordenação inteligente** - Por qualidade e seeds
- ✅ **Suporte completo** - Filmes, séries e anime
- ✅ **Magnets válidos** - Links testados e completos
- ✅ **Health check** - Monitoramento em tempo real
- ✅ **Logs detalhados** - Debug facilitado

## 📋 Pré-requisitos

### Obrigatórios
- **Node.js** 18+
- **npm** ou **yarn**

### Recomendados
- **Redis** (cache) - Opcional mas recomendado
  ```bash
  docker run -d -p 6379:6379 --name redis redis:alpine
  ```

- **Jackett** (fonte principal de torrents) - Altamente recomendado
  ```bash
  # Docker (recomendado)
  docker run -d \
    --name=jackett \
    -p 9117:9117 \
    -e PUID=1000 \
    -e PGID=1000 \
    -e TZ=America/Sao_Paulo \
    --restart unless-stopped \
    linuxserver/jackett
  
  # Ou download direto: https://github.com/Jackett/Jackett/releases
  ```

## 🛠️ Instalação

### 1. Clone o repositório
```bash
git clone https://github.com/fl4v10pessoa/brtorrent.git
cd brtorrent
```

### 2. Instale as dependências
```bash
npm install
```

### 3. Configure o `.env`
```env
# Porta do servidor (local apenas)
PORT=3000

# Redis (opcional)
REDIS_URL=redis://localhost:6379

# Jackett (recomendado - fonte principal de torrents)
JACKETT_URL=http://localhost:9117
JACKETT_API_KEY=sua-chave-aqui

# Debug
DEBUG=false
```

## 🔧 Configurando o Jackett

### Passo a passo:

1. **Acesse o Jackett**:
   ```
   http://localhost:9117
   ```

2. **Adicione indexers (trackers)**:
   - Clique em **"+ Add indexer"**
   - Adicione trackers brasileiros:
     - `Comando.la`
     - `BluDV`
     - `RedeTorrent`
   - Adicione trackers internacionais:
     - `1337x`
     - `TorrentGalaxy`
     - `ThePirateBay`
     - `Nyaa` (para anime)

3. **Configure cada tracker**:
   - Clique no ícone 🔧 ao lado do indexer
   - Preencha credenciais se necessário
   - Clique em **"Test"** para verificar

4. **Copie a API Key**:
   - No canto superior direito, copie a **API Key**
   - Cole no `.env` como `JACKETT_API_KEY`

5. **Teste a API**:
   ```bash
   curl "http://localhost:9117/api/v2.0/indexers/all/results?apikey=SUA_KEY&Query=Matrix"
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

## 🌐 Deploy na Vercel

### Deploy Rápido

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/fl4v10pessoa/brtorrent)

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

### Configuração de Variáveis na Vercel

No dashboard da Vercel (**Settings > Environment Variables**), adicione:

| Variável | Valor | Obrigatório? | Descrição |
|----------|-------|--------------|-----------|
| `JACKETT_URL` | `http://seu-servidor:9117` | **Recomendado** | URL do seu servidor Jackett |
| `JACKETT_API_KEY` | `sua-chave-aqui` | **Recomendado** | API Key do Jackett |
| `REDIS_URL` | `redis://user:pass@host:port` | Opcional | URL do Redis para cache |
| `BASE_URL` | `brtorrent.vercel.app` | Opcional | URL do seu deploy |
| `DEBUG` | `true` ou `false` | Opcional | Logs detalhados |

### ⚠️ Arquitetura Recomendada

```
Vercel (Serverless)
    ↓
Jackett (VPS/Servidor Dedicado)
    ↓
50+ Trackers de Torrent
```

**Importante**: O Jackett **precisa estar acessível publicamente** para a Vercel conectar. Use:
- **VPS** (DigitalOcean, Linode, AWS)
- **Raspberry Pi** com ngrok
- **Docker** em qualquer servidor

### Limitações da Vercel

- **Timeout máximo**: 60s (plano free: 10s)
- **Sem estado**: Browser/sessões não persistem
- **Functions efêmeras**: Cada request é isolado

**Recomendação**: Para melhor performance, considere **Railway**, **Render** ou **Fly.io**.

## 🚀 Instalação no Stremio

### Opção 1: Deploy na Vercel (Recomendado)

1. **Faça deploy na Vercel** (veja acima)
2. **Acesse seu deploy**: `https://brtorrent.vercel.app`
3. **Clique em "INSTALAR NO STREMIO"** ou copie o manifest
4. **Cole no Stremio**:
   - Abra o Stremio
   - Vá para **Add-ons**
   - Cole: `https://brtorrent.vercel.app/manifest.json`

### Opção 2: Local

1. Abra o Stremio
2. Vá para **Add-ons**
3. Cole: `http://localhost:3000/manifest.json`

> **Nota**: Para uso remoto, substitua `localhost` pelo IP/domínio do servidor.

## 📡 Endpoints

| Endpoint | Descrição |
|----------|-----------|
| `GET /` | Página inicial com informações |
| `GET /manifest.json` | Manifest para Stremio |
| `GET /health` | Health check |
| `GET /stream/movie/tt1234567.json` | Buscar streams de filme |
| `GET /stream/series/tt1234567/1/2.json` | Buscar streams de série (S1E2) |
| `GET /search?q=Matrix` | Busca manual (para teste) |
| `GET /debug?q=Matrix` | Debug do scraper |

## 🏗️ Arquitetura

```
Stremio → Addon → Cinemeta (metadados)
              → Redis (cache)
              → Jackett API (fonte principal)
                  → 50+ Trackers
              → BTDigg (fallback DHT)
              → Nyaa (anime)
```

## ⚙️ Otimizações

- **Cache TTL**: 1 hora (configurável)
- **Concorrência**: Buscas paralelas em múltiplas fontes
- **Deduplicação**: Remove torrents duplicados por hash
- **Ordenação**: Qualidade (4K > 1080p > 720p) + seeds
- **Validação**: Apenas magnets com hash válido (32-40 chars)

## 🐛 Troubleshooting

### Jackett não conecta
```bash
# Verifique se o Jackett está rodando
curl http://localhost:9117

# Verifique a API
curl "http://localhost:9117/api/v2.0/indexers/all/results?apikey=SUA_KEY&Query=test"

# Verifique se a URL está acessível publicamente (para Vercel)
curl http://seu-servidor:9117
```

### Redis não conecta
O addon funciona sem Redis, mas para melhor performance:
```bash
# Verificar se Redis está rodando
docker ps | grep redis

# Ou iniciar Redis local
redis-server
```

### Nenhum torrent encontrado
1. **Verifique os logs da Vercel**
2. **Teste o debug endpoint**: `/debug?q=Matrix`
3. **Verifique se Jackett está configurado**
4. **Adicione mais indexers no Jackett**

### Magnets inválidos ou truncados
- O addon filtra automaticamente magnets com hash < 32 chars
- Verifique se os trackers no Jackett retornam magnets completos
- Alguns trackers usam infohash, outros magnets completos

## 📝 Notas

- Este addon é para **uso pessoal e educacional**
- Os torrents são buscados de sites terceiros
- Não nos responsabilizamos pelo conteúdo dos torrents
- **Respeite as leis de direitos autorais** do seu país
- Recomendado usar com **Jackett** para melhores resultados

## 🔄 Changelog

### v2.2.0
- ✅ Suporte à Jackett API (fonte principal)
- ✅ 50+ trackers via Jackett
- ✅ Magnets completos e validados
- ✅ BTDigg como fallback DHT
- ✅ Nyaa para anime
- ✅ Ordenação por qualidade e seeds
- ✅ Cache Redis otimizado
- ✅ Health check endpoint
- ✅ Logs detalhados
- ✅ Página inicial profissional
- ✅ Deploy na Vercel

### v2.1.0
- Deploy na Vercel com serverless functions
- Página inicial com informações dos sites
- Botões INSTALAR NO STREMIO e COPIAR MANIFEST

### v2.0.0
- Versão inicial estilo Torrentio

## 📄 Licença

MIT

## 🤝 Contribuindo

1. Fork o projeto
2. Crie uma branch (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

## 📞 Suporte

- **Issues**: https://github.com/fl4v10pessoa/brtorrent/issues
- **Repositório**: https://github.com/fl4v10pessoa/brtorrent
