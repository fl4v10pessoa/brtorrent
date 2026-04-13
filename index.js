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
    log.info(`HandleStream: ${type}/${id}${season && episode ? ` S${season}E${episode}` : ''}`);

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

    // Adicionar "dublado" ou "legendado" para busca em sites BR
    query += ' dublado';

    const torrents = await getTorrents(query);

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
    return { streams: [] };
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

// Status
app.get('/', (req, res) => {
  res.json({
    status: '🚀 Addon Torrents BR rodando!',
    version: '2.1.0',
    manifest: '/manifest.json',
    health: '/health',
    search: '/search?q=filme',
    install: 'Adicione este URL no Stremio: http://localhost:3000/manifest.json'
  });
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
