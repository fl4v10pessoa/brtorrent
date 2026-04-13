const axios = require('axios');
const redis = require('redis');

// ===================== LOGGING =====================
const log = {
  info: (msg) => console.log(`ℹ️  [${new Date().toISOString()}] ${msg}`),
  warn: (msg) => console.warn(`⚠️  [${new Date().toISOString()}] ${msg}`),
  error: (msg, err) => console.error(`❌ [${new Date().toISOString()}] ${msg}`, err?.message || err || '')
};

// ===================== REDIS =====================
let redisClient;
let redisAvailable = false;

async function initRedis() {
  if (redisAvailable) return;
  try {
    const redisUrl = process.env.REDIS_URL || process.env.KV_REST_API_URL;
    if (!redisUrl) {
      log.warn('REDIS_URL não configurado');
      return;
    }
    redisClient = redis.createClient({ url: redisUrl });
    await redisClient.connect();
    redisAvailable = true;
    log.info('Redis conectado');
  } catch (err) {
    log.warn('Redis não disponível');
  }
}

const CACHE_TTL = 3600;

// ===================== SITES =====================
const SITES_BUSCA = [
  { nome: 'TorrentAPI', descricao: 'API pública de torrents' },
  { nome: '1337x', descricao: 'Site de torrents diversos' },
  { nome: 'Comando.la', descricao: 'Site brasileiro de torrents' }
];

// ===================== TORRENT API (PÚBLICA) =====================
async function fetchTorrentAPI(query) {
  try {
    log.info(`Buscando na API: ${query}`);
    
    // API 1: torrentapi.org (The Pirate Bay mirror)
    const { data } = await axios.get('https://torrentapi.org/pubapi_v2.php', {
      params: {
        get_torrents: 1,
        mode: 'search',
        search_string: query,
        format: 'json',
        app_id: 'brtorrent',
        limit: 30,
        ranked: 1
      },
      timeout: 10000,
      headers: { 'User-Agent': 'brtorrent/1.0' }
    });

    if (!data?.torrent_results?.length) {
      log.info('API retornou 0 resultados');
      return [];
    }

    log.info(`API retornou ${data.torrent_results.length} resultados`);

    return data.torrent_results.map(item => ({
      provedor: 'TorrentAPI',
      nome: item.title || item.torrent_title || 'Torrent',
      magnet: item.download || item.link || '',
      tamanho: item.size || 'N/A',
      seeds: item.seeders || 0
    }));
  } catch (err) {
    log.warn('TorrentAPI falhou:', err.message);
    return [];
  }
}

// ===================== 1337X API =====================
async function fetch1337x(query) {
  try {
    log.info(`Buscando 1337x: ${query}`);
    
    const { data } = await axios.get(`https://1337x.to/search/${encodeURIComponent(query)}/1/`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      maxRedirects: 5
    });

    const html = data;
    const results = [];

    // Extrair magnets
    const magnetRegex = /magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}[^&"]*/g;
    const magnets = html.match(magnetRegex) || [];

    // Extrair títulos
    const titleRegex = /<a[^>]*>([^<]*(?:(?:4K|2160p|1080p|720p|BluRay|WEB|BRRip|dublado|legendado)[^<]*))<\/a>/gi;
    const titles = [];
    let match;
    while ((match = titleRegex.exec(html)) !== null) {
      titles.push(match[1].trim());
    }

    // Extrair tamanhos
    const sizeRegex = /<td[^>]*>(\d+(?:\.\d+)?\s*(?:MB|GB|TB))<\/td>/gi;
    const sizes = html.match(sizeRegex) || [];

    // Combinar
    const maxLen = Math.max(titles.length, magnets.length);
    for (let i = 0; i < maxLen && i < 20; i++) {
      if (magnets[i]?.startsWith('magnet:')) {
        results.push({
          provedor: '1337x',
          nome: titles[i] || `Torrent ${i+1}`,
          magnet: magnets[i],
          tamanho: (sizes[i] || '').replace(/<\/?td[^>]*>/g, '') || 'N/A',
          seeds: 0
        });
      }
    }

    log.info(`1337x: ${results.length} resultados`);
    return results;
  } catch (err) {
    log.warn('1337x falhou:', err.message);
    return [];
  }
}

// ===================== SCRAPER AXIOS (Sites BR) =====================
async function scrapeSiteAxios(siteName, searchUrl) {
  try {
    log.info(`Scraping ${siteName}...`);
    
    const { data: html } = await axios.get(searchUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      maxRedirects: 5
    });

    const results = [];
    
    // Extrair todos os magnets
    const magnetRegex = /magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"'\s]*/gi;
    const magnets = html.match(magnetRegex) || [];

    // Extrair títulos próximos aos magnets
    const titleRegex = /(?:title|name|nome)[^>]*>[^<]*((?:4K|2160p|1080p|720p|480p|dublado|legendado|bluray|web)[^<]*)/gi;
    const titles = [];
    let match;
    while ((match = titleRegex.exec(html)) !== null) {
      titles.push(match[1].trim());
    }

    // Extrair tamanhos
    const sizeRegex = /(\d+(?:\.\d+)?\s*(?:MB|GB))/gi;
    const sizes = html.match(sizeRegex) || [];

    // Combinar
    for (let i = 0; i < magnets.length && i < 15; i++) {
      results.push({
        provedor: siteName,
        nome: titles[i] || `Torrent ${i+1}`,
        magnet: magnets[i],
        tamanho: sizes[i] || 'N/A',
        seeds: 0
      });
    }

    log.info(`${siteName}: ${results.length} resultados`);
    return results;
  } catch (err) {
    log.warn(`${siteName} falhou:`, err.message);
    return [];
  }
}

// ===================== BUSCA COMBINADA =====================
async function getTorrents(query) {
  await initRedis();

  const normalizedQuery = query.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const cacheKey = `torrentsbr:${normalizedQuery}`;

  // Cache
  if (redisAvailable) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        log.info(`Cache hit: ${query}`);
        return JSON.parse(cached);
      }
    } catch (err) {}
  }

  log.info(`Buscando torrents: ${query}`);

  // Buscar em todas as fontes simultaneamente
  const promises = [
    fetchTorrentAPI(query),
    fetch1337x(query),
    scrapeSiteAxios('Comando.la', `https://comando.la/?s=${encodeURIComponent(query)}`),
    scrapeSiteAxios('BluDV1', `https://bludv1.com/?s=${encodeURIComponent(query)}`)
  ];

  const results = await Promise.allSettled(promises);
  let todos = [];
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value?.length) {
      todos = todos.concat(r.value);
    }
  });

  if (!todos.length) {
    log.warn('Nenhum torrent encontrado');
    return [];
  }

  // Remover duplicatas
  const seen = new Set();
  const unicos = todos.filter(item => {
    const key = item.magnet?.substring(0, 40);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Ordenar por seeds
  const resposta = unicos.sort((a, b) => b.seeds - a.seeds);

  log.info(`Total: ${resposta.length} torrents únicos`);

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
  if (nome.match(/\b(4K|UHD|2160)\b/i)) return '4K';
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
    log.info(`Stream request: ${type}/${id}${season ? ` S${season}E${episode}` : ''}`);

    const meta = await getCinemeta(type, id);
    if (!meta) {
      log.warn('Meta não encontrada');
      return { streams: [] };
    }

    let query = meta.name || '';
    if (meta.releaseInfo) {
      const year = meta.releaseInfo.match(/\d{4}/)?.[0];
      if (year) query += ` ${year}`;
    }

    if (type === 'series' && season && episode) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      query += ` S${s}E${e}`;
    }

    // Adicionar termos em português
    query += ' dublado legendado';

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
      .map((r, idx) => {
        const qualidade = extrairQualidade(r.nome);
        const title = [
          r.nome.substring(0, 100),
          qualidade,
          r.tamanho !== 'N/A' ? `📦 ${r.tamanho}` : '',
          r.seeds > 0 ? `👥 ${r.seeds}` : '',
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

    log.info(`Retornando ${streams.length} streams`);
    return { streams };
  } catch (err) {
    log.error('Erro no handleStream:', err);
    return { streams: [], error: err.message };
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
