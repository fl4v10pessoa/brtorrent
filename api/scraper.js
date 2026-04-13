const axios = require('axios');
const redis = require('redis');

// ===================== LOGGING =====================
const log = {
  info: (msg) => console.log(`ℹ️  [${new Date().toISOString()}] ${msg}`),
  warn: (msg) => console.warn(`⚠️  [${new Date().toISOString()}] ${msg}`),
  error: (msg, err) => console.error(`❌ [${new Date().toISOString()}] ${msg}`, err?.message || '')
};

// ===================== REDIS =====================
let redisClient;
let redisAvailable = false;

async function initRedis() {
  if (redisAvailable) return;
  try {
    const redisUrl = process.env.REDIS_URL || process.env.KV_REST_API_URL;
    if (!redisUrl) return;

    redisClient = redis.createClient({ url: redisUrl });
    redisClient.on('error', () => redisAvailable = false);
    await redisClient.connect();
    redisAvailable = true;
  } catch (err) {
    log.warn('Redis não disponível');
  }
}

const CACHE_TTL = 3600;

// ===================== SITES =====================
const SITES_BUSCA = [
  { nome: 'Comando.la', url: 'https://comando.la', descricao: 'Um dos maiores sites de torrents brasileiros' },
  { nome: 'BluDV1', url: 'https://bludv1.com', descricao: 'Especializado em alta qualidade' },
  { nome: 'HDRTorrent', url: 'https://hdrtorrent.com', descricao: 'Focado em conteúdo HDR' },
  { nome: 'RedeTorrent', url: 'https://redetorrent.com', descricao: 'Grande acervo de filmes e séries' },
  { nome: 'Torrents dos Filmes', url: 'https://torrentsdosfilmes1.com', descricao: 'Especializado em filmes dublados' }
];

// ===================== SCRAPER COM AXIOS =====================
async function scrapeWithAxios(siteName, searchUrl) {
  try {
    log.info(`Scraping ${siteName}...`);
    
    const response = await axios.get(searchUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      maxRedirects: 5
    });

    const html = response.data;
    const results = [];

    // Extrair links de magnet do HTML
    const magnetRegex = /magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"']*/gi;
    const magnets = html.match(magnetRegex) || [];

    // Extrair títulos
    const titleRegex = /<a[^>]*>([^<]*(?:4K|2160p|1080p|720p|480p|bluray|web|brrip|dub|dublado|legendado)[^<]*)<\/a>/gi;
    const titles = [];
    let match;
    while ((match = titleRegex.exec(html)) !== null) {
      titles.push(match[1].trim());
    }

    // Extrair tamanhos
    const sizeRegex = /(\d+(?:\.\d+)?\s*(?:MB|GB|TB))/gi;
    const sizes = html.match(sizeRegex) || [];

    // Combinar dados
    const maxLen = Math.min(titles.length, magnets.length);
    for (let i = 0; i < maxLen && i < 15; i++) {
      results.push({
        provedor: siteName,
        nome: titles[i] || `Torrent ${i + 1}`,
        magnet: magnets[i],
        tamanho: sizes[i] || 'N/A',
        seeds: 0
      });
    }

    log.info(`${siteName}: ${results.length} resultados`);
    return results;
  } catch (err) {
    log.warn(`${siteName} falhou: ${err.message}`);
    return [];
  }
}

// ===================== BUSCA =====================
async function getTorrents(query) {
  const normalizedQuery = query.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const cacheKey = `torrentsbr:${normalizedQuery}`;

  // Cache
  if (redisAvailable) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {}
  }

  log.info(`Buscando: ${query}`);

  const promises = [
    scrapeWithAxios('comando.la', `https://comando.la/?s=${encodeURIComponent(query)}`),
    scrapeWithAxios('bludv1.com', `https://bludv1.com/?s=${encodeURIComponent(query)}`),
    scrapeWithAxios('hdrtorrent.com', `https://hdrtorrent.com/?s=${encodeURIComponent(query)}`),
    scrapeWithAxios('redetorrent.com', `https://redetorrent.com/?s=${encodeURIComponent(query)}`),
    scrapeWithAxios('torrentsdosfilmes1.com', `https://torrentsdosfilmes1.com/?s=${encodeURIComponent(query)}`)
  ];

  const results = await Promise.allSettled(promises);
  let todos = [];
  results.forEach(r => {
    if (r.status === 'fulfilled') todos = todos.concat(r.value);
  });

  // Remover duplicatas
  const seen = new Set();
  const unicos = todos.filter(item => {
    const key = item.magnet?.substring(0, 40);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const resposta = unicos.sort((a, b) => b.seeds - a.seeds);

  // Cache
  if (redisAvailable) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(resposta), { EX: CACHE_TTL });
    } catch (err) {}
  }

  return resposta;
}

// ===================== QUALIDADE =====================
function extrairQualidade(nome) {
  if (!nome) return 'SD';
  const match = nome.match(/\b(2160p|1080p|720p|480p|360p)\b/i);
  if (match) return match[1].toUpperCase();
  if (nome.match(/\b(4K|UHD)\b/i)) return '4K';
  return 'SD';
}

const prioridadeQualidade = {
  '4K': 6, '2160P': 5, '1080P': 4, '720P': 3, '480P': 2, 'CAM': 0, 'SD': 1
};

// ===================== CINEMETA =====================
async function getCinemeta(type, id) {
  try {
    const { data } = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`,
      { timeout: 8000 }
    );
    return data?.meta || null;
  } catch (err) {
    log.warn(`Cinemeta falhou: ${err.message}`);
    return null;
  }
}

// ===================== STREAM HANDLER =====================
async function handleStream(type, id, season = null, episode = null) {
  try {
    await initRedis();

    log.info(`Stream: ${type}/${id}${season ? ` S${season}E${episode}` : ''}`);

    const meta = await getCinemeta(type, id);
    if (!meta) {
      return { streams: [] };
    }

    let query = meta.name || '';
    if (meta.releaseInfo) {
      const year = meta.releaseInfo.match(/\d{4}/)?.[0];
      if (year) query += ` ${year}`;
    }

    if ((type === 'series') && season && episode) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      query += ` S${s}E${e}`;
    }

    query += ' dublado';

    const torrents = await getTorrents(query);

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
        return {
          name: `[BR] ${r.provedor}`,
          title: `${r.nome.substring(0, 100)}\n${qualidade} • ${r.tamanho} • 🇧🇷 PT-BR`,
          url: r.magnet,
          behaviorHints: {
            notWebReady: true,
            filename: r.nome
          }
        };
      });

    log.info(`Retornando ${streams.length} streams`);
    return { streams };
  } catch (err) {
    log.error('Erro no handleStream:', err);
    return { streams: [] };
  }
}

// ===================== EXPORTS =====================
module.exports = {
  getTorrents,
  handleStream,
  extrairQualidade,
  SITES_BUSCA,
  initRedis
};
