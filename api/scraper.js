const axios = require('axios');
const redis = require('redis');

// ===================== LOGGING =====================
const log = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  warn: (msg) => console.warn(`⚠️  ${msg}`),
  error: (msg, err) => console.error(`❌ ${msg}`, err?.message || err || '')
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
    await redisClient.connect();
    redisAvailable = true;
  } catch (err) {
    redisAvailable = false;
  }
}

const CACHE_TTL = 3600;

// ===================== SITES =====================
const SITES_BUSCA = [
  { nome: 'BitSearch', descricao: 'API pública de busca de torrents' },
  { nome: 'TorrentGalaxy', descricao: 'Torrents diversos' },
  { nome: 'Nyaa', descricao: 'API para anime e conteúdo asiático' }
];

// ===================== BITSEARCH API (PÚBLICA E GRATUITA) =====================
async function fetchBitSearch(query) {
  try {
    log.info(`Buscando BitSearch: ${query}`);
    
    const { data } = await axios.get('https://bitsearch.to/api/v1/search', {
      params: {
        q: query,
        sort: 'seeders',
        page: 1
      },
      timeout: 10000,
      headers: { 'User-Agent': 'brtorrent/1.0' }
    });

    if (!data?.results?.length) {
      log.info('BitSearch retornou 0 resultados');
      return [];
    }

    log.info(`BitSearch retornou ${data.results.length} resultados`);

    return data.results.slice(0, 20).map(item => {
      // Tentar extrair hash de múltiplos campos
      const infoHash = item.info_hash || item.hash || item.torrent_hash || item.id || '';
      const name = item.name || item.title || 'Torrent';
      const size = item.size || item.filesize || 'N/A';
      const seeders = parseInt(item.seeders || item.peers || item.leechers || '0') || 0;
      
      // Construir magnet link
      let magnet = '';
      if (infoHash && infoHash.length >= 32) {
        magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.tracker.cl:1337/announce&tr=udp://tracker.openbittorrent.com:6969/announce`;
      } else {
        log.warn(`Hash inválido para ${name}: ${infoHash}`);
      }
      
      return {
        provedor: 'BitSearch',
        nome: name,
        magnet: magnet,
        tamanho: typeof size === 'number' ? formatSize(size) : size,
        seeds: seeders
      };
    });
  } catch (err) {
    log.warn(`BitSearch falhou: ${err.message}`);
    return [];
  }
}

function formatSize(bytes) {
  if (!bytes) return 'N/A';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

// ===================== TORRENT GALAXY (API NÃO OFICIAL) =====================
async function fetchTorrentGalaxy(query) {
  try {
    log.info(`Buscando TorrentGalaxy: ${query}`);
    
    const { data } = await axios.get('https://torrentgalaxy.to/getresults', {
      params: {
        search: query
      },
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://torrentgalaxy.to/'
      }
    });

    // HTML parsing
    const html = typeof data === 'string' ? data : JSON.stringify(data);
    const results = [];

    // Extrair info_hash e titles
    const magnetRegex = /magnet:\?xt=urn:btih:([a-f0-9]{40})/gi;
    let match;
    const hashes = [];
    while ((match = magnetRegex.exec(html)) !== null) {
      hashes.push(match[1]);
    }

    const titleRegex = /title="([^"]*(?:4K|2160p|1080p|720p|dublado|legendado)[^"]*)"/gi;
    const titles = [];
    while ((match = titleRegex.exec(html)) !== null) {
      titles.push(match[1]);
    }

    for (let i = 0; i < Math.min(hashes.length, titles.length, 15); i++) {
      results.push({
        provedor: 'TorrentGalaxy',
        nome: titles[i],
        magnet: `magnet:?xt=urn:btih:${hashes[i]}&dn=${encodeURIComponent(titles[i])}&tr=udp://tracker.opentrackr.org:1337/announce`,
        tamanho: 'N/A',
        seeds: 0
      });
    }

    return results;
  } catch (err) {
    log.warn(`TorrentGalaxy falhou: ${err.message}`);
    return [];
  }
}

// ===================== NYAA API (ANIME) =====================
async function fetchNyaa(query) {
  try {
    log.info(`Buscando Nyaa: ${query}`);
    
    const { data } = await axios.get('https://nyaa.si/?page=rss', {
      params: { q: query },
      timeout: 8000,
      headers: { 'User-Agent': 'brtorrent/1.0' }
    });

    const xml = typeof data === 'string' ? data : '';
    const results = [];

    // Parse XML RSS
    const itemRegex = /<item>[\s\S]*?<\/item>/gi;
    const items = xml.match(itemRegex) || [];

    for (const item of items.slice(0, 15)) {
      const titleMatch = /<title><!\[CDATA\[(.*?)\]\]><\/title>/i.exec(item);
      const magnetMatch = item.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^&"\s]*/i);
      const sizeMatch = /nyaa:infoHash\s*>\s*([a-f0-9]+)/i.exec(item);
      const title = titleMatch?.[1] || '';

      if (title && magnetMatch) {
        results.push({
          provedor: 'Nyaa',
          nome: title,
          magnet: magnetMatch[0],
          tamanho: 'N/A',
          seeds: 0
        });
      }
    }

    return results;
  } catch (err) {
    log.warn(`Nyaa falhou: ${err.message}`);
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

  // Buscar em todas as fontes
  const promises = [
    fetchBitSearch(query),
    fetchTorrentGalaxy(query),
    fetchNyaa(query)
  ];

  const results = await Promise.allSettled(promises);
  let todos = [];
  
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value?.length) {
      todos = todos.concat(r.value);
      log.info(`Fonte ${idx} retornou ${r.value.length} resultados`);
    }
  });

  if (!todos.length) {
    log.warn('Nenhum torrent encontrado');
    return [];
  }

  // Remover duplicatas - usar info_hash como chave
  const seen = new Set();
  const unicos = [];
  
  for (const item of todos) {
    // Extrair hash do magnet
    const hashMatch = item.magnet.match(/btih:([a-zA-Z0-9]+)/i);
    const hash = hashMatch ? hashMatch[1].toLowerCase() : '';
    
    if (hash && !seen.has(hash)) {
      seen.add(hash);
      unicos.push(item);
    }
    // Não adicionar torrents sem hash/magnet
  }

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
    log.info(`Stream: ${type}/${id}${season ? ` S${season}E${episode}` : ''}`);

    const meta = await getCinemeta(type, id);
    if (!meta) {
      log.warn('Meta não encontrada');
      return { streams: [], error: 'Meta não encontrada' };
    }

    let query = meta.name || '';
    if (meta.releaseInfo) {
      const year = meta.releaseInfo.match(/\d{4}/)?.[0];
      if (year) query += ` ${year}`;
    }

    if (type === 'series' && season && episode) {
      query += ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    }

    query += ' dublado legendado português';

    const torrents = await getTorrents(query);

    // Ordenar
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
        const title = [
          r.nome.substring(0, 100),
          qualidade,
          r.tamanho !== 'N/A' ? `📦 ${r.tamanho}` : '',
          r.seeds > 0 ? `👥 ${r.seeds}` : '',
          '🇧🇷'
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

    log.info(`✅ Retornando ${streams.length} streams`);
    return { streams };
  } catch (err) {
    log.error('Erro handleStream:', err);
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
