const express = require('express');
const cors = require('cors');
const axios = require('axios');
const redis = require('redis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===================== LOGGING =====================
const log = {
  info: (msg, ...args) => console.log(`ℹ️  [${new Date().toISOString()}] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`⚠️  [${new Date().toISOString()}] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`❌ [${new Date().toISOString()}] ${msg}`, ...args),
  success: (msg, ...args) => console.log(`✅ [${new Date().toISOString()}] ${msg}`, ...args)
};

// ===================== REDIS =====================
let redisClient;
let redisAvailable = false;

async function initRedis() {
  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = redis.createClient({ url: redisUrl });
    
    redisClient.on('error', (err) => {
      log.warn('Erro Redis:', err.message);
      redisAvailable = false;
    });

    redisClient.on('connect', () => {
      log.success('Redis conectado');
      redisAvailable = true;
    });

    await redisClient.connect();
  } catch (err) {
    log.warn('Redis não disponível, operando sem cache:', err.message);
    redisAvailable = false;
  }
}

const CACHE_TTL = 3600; // 1 hora

// ===================== JACKETT =====================
async function fetchJackett(query) {
  const jackettUrl = process.env.JACKETT_URL;
  const jackettApiKey = process.env.JACKETT_API_KEY;

  if (!jackettUrl || !jackettApiKey) {
    log.warn('Jackett não configurado. Defina JACKETT_URL e JACKETT_API_KEY no .env');
    return [];
  }

  try {
    log.info(`Buscando no Jackett: ${query}`);

    const { data } = await axios.get(`${jackettUrl}/api/v2.0/indexers/all/results`, {
      params: {
        apikey: jackettApiKey,
        Query: query,
        Category: 2000,
        limit: 50
      },
      timeout: 15000,
      headers: { 'User-Agent': 'TorrentsBR/1.0' }
    });

    if (!data?.Results?.length) {
      log.info('Jackett retornou 0 resultados');
      return [];
    }

    log.success(`Jackett: ${data.Results.length} resultados`);

    return data.Results.slice(0, 50).map(item => ({
      provedor: item.Tracker || 'Jackett',
      nome: item.Title || 'Torrent',
      magnet: item.MagnetUri || '',
      tamanho: formatBytes(item.Size),
      seeds: item.Seeders || 0
    })).filter(r => r.magnet && r.magnet.startsWith('magnet:'));
  } catch (err) {
    log.error(`Jackett falhou: ${err.message}`);
    return [];
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ===================== BUSCA COM CACHE =====================
async function getTorrents(query) {
  const normalizedQuery = query.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const cacheKey = `torrentsbr:${normalizedQuery}`;

  // Tentar cache
  if (redisAvailable) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        log.info(`Cache hit para: ${query}`);
        return JSON.parse(cached);
      }
    } catch (err) {
      log.warn('Erro ao ler cache:', err.message);
    }
  }

  log.info(`Buscando torrents para: ${query}`);

  // Buscar apenas do Jackett
  const torrents = await fetchJackett(query);

  // Remover duplicatas pelo hash
  const seen = new Set();
  const unicos = torrents.filter(item => {
    const hashMatch = item.magnet.match(/btih:([a-zA-Z0-9]+)/i);
    const hash = hashMatch ? hashMatch[1].toLowerCase() : '';
    if (!hash || seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });

  // Ordenar por seeds
  const resposta = unicos.sort((a, b) => b.seeds - a.seeds);

  log.success(`Total: ${resposta.length} torrents únicos`);

  // Salvar no cache
  if (redisAvailable) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(resposta), { EX: CACHE_TTL });
    } catch (err) {
      log.warn('Erro ao salvar cache:', err.message);
    }
  }

  return resposta;
}

// ===================== QUALIDADE =====================
function extrairQualidade(nome) {
  if (!nome) return 'SD';
  const cleanName = nome.replace(/[^a-zA-Z0-9\s\.]/g, ' ');
  const match = cleanName.match(/\b(2160p|1080p|720p|480p|360p)\b/i);
  if (match) return match[1].toUpperCase();
  if (cleanName.match(/\b(4K|UHD|2160)\b/i)) return '4K';
  if (cleanName.match(/\b(BRRip|BDRip|WEBRip)\b/i)) return '720P';
  if (cleanName.match(/\b(CAM|TS|TC|SCR)\b/i)) return 'CAM';
  return 'SD';
}

const prioridadeQualidade = {
  '4K': 6,
  '2160P': 5,
  '1080P': 4,
  '720P': 3,
  '480P': 2,
  '360P': 1,
  'CAM': 0,
  'SD': 1
};

// ===================== CINEMETA =====================
async function getCinemeta(type, id) {
  try {
    const { data } = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`,
      { timeout: 10000, validateStatus: (status) => status < 500 }
    );
    return data?.meta || null;
  } catch (err) {
    log.error(`Erro ao buscar Cinemeta (${type}/${id}):`, err.message);
    return null;
  }
}

// ===================== STREAM HANDLER =====================
async function handleStream(type, id, season = null, episode = null) {
  try {
    log.info(`HandleStream: ${type}/${id}${season ? ` S${season}E${episode}` : ''}`);

    const meta = await getCinemeta(type, id);
    if (!meta) {
      log.warn(`Meta não encontrada para ${type}/${id}`);
      return { streams: [] };
    }

    let query = meta.name || '';

    // Adicionar ano se disponível
    if (meta.releaseInfo) {
      const year = meta.releaseInfo.match(/\d{4}/)?.[0];
      if (year) query += ` ${year}`;
    }

    // Adicionar temporada e episódio para séries
    if ((type === 'series' || type === 'anime') && season && episode) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      query += ` S${s}E${e}`;
    }

    log.info(`Query para Jackett: ${query}`);

    const torrents = await getTorrents(query);

    log.info(`Torrents retornados: ${torrents.length}`);

    // Ordenar por qualidade e seeds
    torrents.sort((a, b) => {
      const qa = prioridadeQualidade[extrairQualidade(a.nome)] || 0;
      const qb = prioridadeQualidade[extrairQualidade(b.nome)] || 0;
      if (qa !== qb) return qb - qa;
      return b.seeds - a.seeds;
    });

    const streams = torrents
      .filter(r => r.magnet && r.magnet.startsWith('magnet:'))
      .map(r => {
        const qualidade = extrairQualidade(r.nome);
        const sizeFormatted = r.tamanho !== 'N/A' ? `📦 ${r.tamanho}` : '';
        const seedsFormatted = r.seeds > 0 ? `👥 ${r.seeds} seeds` : '';
        const title = [
          `${r.nome.substring(0, 80)}${r.nome.length > 80 ? '...' : ''}`,
          qualidade,
          sizeFormatted,
          seedsFormatted,
          '🇧🇷 PT-BR'
        ].filter(Boolean).join(' • ');

        return {
          name: `[BR] ${r.provedor}`,
          title: title,
          url: r.magnet,
          behaviorHints: {
            notWebReady: true,
            filename: r.nome
          }
        };
      });

    log.success(`Retornando ${streams.length} streams para ${type}/${id}`);
    return { streams };
  } catch (err) {
    log.error(`Erro no handleStream:`, err.message);
    return { streams: [], error: err.message };
  }
}

// ===================== APP =====================
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    redis: redisAvailable ? 'connected' : 'disconnected',
    jackett: process.env.JACKETT_URL ? 'configured' : 'not configured',
    timestamp: new Date().toISOString()
  };
  res.json(health);
});

// Manifest
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.torrentsbr.addon',
    name: 'Torrents BR',
    version: '2.1.0',
    description: 'Addon estilo Torrentio para sites brasileiros de torrents. Busca automática em múltiplos sites com cache otimizado.',
    logo: 'https://i.imgur.com/Yq5p4xX.png',
    background: 'https://i.imgur.com/8fZfZfZ.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  });
});

// Stream routes
app.get('/stream/:type/:id.json', async (req, res) => {
  try {
    const { type, id } = req.params;
    const result = await handleStream(type, id);
    res.json(result);
  } catch (err) {
    log.error('Erro no /stream:', err.message);
    res.status(500).json({ streams: [], error: 'Erro interno do servidor' });
  }
});

app.get('/stream/:type/:id/:season/:episode.json', async (req, res) => {
  try {
    const { type, id, season, episode } = req.params;
    const result = await handleStream(type, id, parseInt(season), parseInt(episode));
    res.json(result);
  } catch (err) {
    log.error('Erro no /stream series:', err.message);
    res.status(500).json({ streams: [], error: 'Erro interno do servidor' });
  }
});

// Teste no navegador
app.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ erro: 'Informe o parâmetro q' });

    log.info(`Busca manual: ${q}`);
    const resultados = await getTorrents(q);
    res.json({
      busca: q,
      total: resultados.length,
      resultados
    });
  } catch (err) {
    log.error('Erro na busca manual:', err.message);
    res.status(500).json({ erro: 'Erro na busca', detalhes: err.message });
  }
});

// Página inicial
app.get('/', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Torrents BR - Addon Stremio</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container { max-width: 800px; width: 100%; text-align: center; }
    .logo {
      width: 120px; height: 120px; margin: 0 auto 30px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 24px; display: flex; align-items: center; justify-content: center;
      font-size: 48px; font-weight: 800;
      box-shadow: 0 10px 40px rgba(102, 126, 234, 0.3);
    }
    h1 {
      font-size: 3rem; font-weight: 800; margin-bottom: 10px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    }
    .subtitle { font-size: 1.2rem; color: rgba(255,255,255,0.7); margin-bottom: 40px; }
    .info-box {
      background: rgba(255,255,255,0.05); backdrop-filter: blur(10px);
      border-radius: 16px; padding: 30px; margin-bottom: 40px;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .info-box h2 { font-size: 1.5rem; margin-bottom: 15px; color: #667eea; }
    .info-box p { color: rgba(255,255,255,0.6); line-height: 1.6; }
    .info-box code {
      background: rgba(255,255,255,0.1); padding: 2px 8px; border-radius: 4px;
      font-family: monospace; color: #667eea;
    }
    .buttons { display: flex; gap: 15px; justify-content: center; flex-wrap: wrap; }
    .btn {
      padding: 16px 32px; border-radius: 12px; font-size: 1rem; font-weight: 600;
      cursor: pointer; border: none; transition: all 0.3s; text-decoration: none;
      display: inline-flex; align-items: center; gap: 10px;
    }
    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff;
      box-shadow: 0 4px 20px rgba(102, 126, 234, 0.3);
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 6px 30px rgba(102, 126, 234, 0.4); }
    .btn-secondary {
      background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.2);
    }
    .btn-secondary:hover { background: rgba(255,255,255,0.15); border-color: #667eea; }
    .btn-secondary.copied { background: rgba(72,187,120,0.2); border-color: #48bb78; }
    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; margin-top: 40px; }
    .feature { padding: 20px; background: rgba(255,255,255,0.05); border-radius: 12px; }
    .feature-icon { font-size: 2rem; margin-bottom: 10px; }
    .feature h3 { font-size: 0.9rem; margin-bottom: 5px; }
    .feature p { font-size: 0.8rem; color: rgba(255,255,255,0.6); }
    footer { margin-top: 50px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 0.85rem; color: rgba(255,255,255,0.5); }
    @media (max-width: 600px) {
      h1 { font-size: 2rem; }
      .buttons { flex-direction: column; }
      .btn { width: 100%; justify-content: center; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🇧🇷</div>
    <h1>Torrents BR</h1>
    <p class="subtitle">Addon Stremio com Jackett - Torrents brasileiros</p>

    <div class="info-box">
      <h2>⚙️ Configuração</h2>
      <p>Este addon usa <strong>Jackett</strong> como fonte de torrents.</p>
      <p style="margin-top: 10px;">Jackett URL: <code>${process.env.JACKETT_URL || 'não configurado'}</code></p>
      <p style="margin-top: 5px;">Status: ${process.env.JACKETT_URL ? '✅ Conectado' : '❌ Não configurado'}</p>
    </div>

    <div class="buttons">
      <a href="stremio://${baseUrl}/manifest.json" class="btn btn-primary" id="installBtn">
        🚀 INSTALAR NO STREMIO
      </a>
      <button class="btn btn-secondary" id="copyBtn" onclick="copyManifest()">
        📋 COPIAR URL DO MANIFEST
      </button>
    </div>

    <div class="features">
      <div class="feature">
        <div class="feature-icon">⚡</div>
        <h3>Cache Redis</h3>
        <p>Buscas otimizadas</p>
      </div>
      <div class="feature">
        <div class="feature-icon">🎬</div>
        <h3>HD/4K</h3>
        <p>Ordenado por qualidade</p>
      </div>
      <div class="feature">
        <div class="feature-icon">👥</div>
        <h3>Seeds</h3>
        <p>Maior seeds primeiro</p>
      </div>
      <div class="feature">
        <div class="feature-icon">🇧🇷</div>
        <h3>PT-BR</h3>
        <p>Conteúdo brasileiro</p>
      </div>
    </div>

    <footer>
      <p>© 2026 Torrents BR - Addon Stremio via Jackett</p>
      <p style="margin-top: 5px;">Versão 2.1.0</p>
    </footer>
  </div>

  <script>
    const manifestUrl = '${baseUrl}/manifest.json';

    async function copyManifest() {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(manifestUrl);
        } else {
          const textArea = document.createElement('textarea');
          textArea.value = manifestUrl;
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
        }
        const btn = document.getElementById('copyBtn');
        btn.classList.add('copied');
        btn.innerHTML = '✅ COPIADO!';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '📋 COPIAR URL DO MANIFEST';
        }, 2000);
      } catch (err) {
        alert('Copie manualmente: ' + manifestUrl);
      }
    }

    document.getElementById('installBtn').addEventListener('click', function(e) {
      const manifestHttpUrl = manifestUrl.replace('stremio://', 'http://');
      window.location.href = manifestHttpUrl;
    });
  </script>
</body>
</html>`);
});

// ===================== START =====================
async function start() {
  log.info('Iniciando Addon Torrents BR com Jackett...');

  // Inicializar Redis
  await initRedis();

  app.listen(PORT, () => {
    log.success(`Addon rodando em http://localhost:${PORT}`);
    log.info(`Manifest: http://localhost:${PORT}/manifest.json`);
    log.info(`Health: http://localhost:${PORT}/health`);
    log.info(`Jackett: ${process.env.JACKETT_URL || 'não configurado'}`);
  });
}

start().catch(err => {
  log.error('Erro fatal ao iniciar:', err.message);
  process.exit(1);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  log.info(`${signal} recebido, encerrando...`);

  if (redisAvailable && redisClient) {
    await redisClient.quit().catch(() => {});
    log.info('Redis desconectado');
  }

  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
