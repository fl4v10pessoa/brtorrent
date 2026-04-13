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
  { nome: 'BTDigg', descricao: 'Motor de busca de torrents com magnets completos' },
  { nome: 'Snowfl', descricao: 'Agregador de torrents público' },
  { nome: 'Nyaa', descricao: 'API para anime e conteúdo asiático' }
];

// ===================== BTDIGG (SCRAPING LEVE) =====================
async function fetchBTDigg(query) {
  try {
    log.info(`Buscando BTDigg: ${query}`);
    
    const { data: html } = await axios.get(`https://btdig.com/search?q=${encodeURIComponent(query)}&order=0`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      maxRedirects: 5
    });

    const results = [];
    
    // Extrair magnet links completos
    const magnetRegex = /magnet:\?xt=urn:btih:([a-fA-F0-9]{40})[^&"]*/g;
    let magnetMatch;
    const magnets = [];
    while ((magnetMatch = magnetRegex.exec(html)) !== null) {
      magnets.push(magnetMatch[0]);
    }

    // Extrair títulos
    const titleRegex = /<div class="one_result">[\s\S]*?<a[^>]*>(.*?)<\/a>/gi;
    const titles = [];
    let titleMatch;
    while ((titleMatch = titleRegex.exec(html)) !== null) {
      // Limpar HTML
      const clean = titleMatch[1].replace(/<[^>]*>/g, '').trim();
      if (clean) titles.push(clean);
    }

    // Extrair tamanhos
    const sizeRegex = /<span class="td_size">[^<]*<span class="smaller">(.*?)<\/span>/gi;
    const sizes = [];
    let sizeMatch;
    while ((sizeMatch = sizeRegex.exec(html)) !== null) {
      sizes.push(sizeMatch[1]);
    }

    // Combinar resultados
    const maxLen = Math.max(magnets.length, titles.length);
    for (let i = 0; i < Math.min(maxLen, 20); i++) {
      if (magnets[i]) {
        results.push({
          provedor: 'BTDigg',
          nome: titles[i] || `Torrent ${i+1}`,
          magnet: magnets[i],
          tamanho: sizes[i] || 'N/A',
          seeds: 0
        });
      }
    }

    log.info(`BTDigg: ${results.length} resultados`);
    return results;
  } catch (err) {
    log.warn(`BTDigg falhou: ${err.message}`);
    return [];
  }
}

// ===================== SNOWFL (API ALTERNATIVA) =====================
async function fetchSnowfl(query) {
  try {
    log.info(`Buscando Snowfl: ${query}`);
    
    const { data: html } = await axios.get(`https://snowfl.com/?query=${encodeURIComponent(query)}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      maxRedirects: 5
    });

    const results = [];
    
    // Extrair magnet links
    const magnetRegex = /magnet:\?xt=urn:btih:([a-fA-F0-9]{32,40})[^&"]*/g;
    let magnetMatch;
    const magnets = [];
    while ((magnetMatch = magnetRegex.exec(html)) !== null) {
      magnets.push(magnetMatch[0]);
    }

    // Extrair títulos
    const titleRegex = /class="title">[^<]*<a[^>]*>([^<]+)<\/a>/gi;
    const titles = [];
    let titleMatch;
    while ((titleMatch = titleRegex.exec(html)) !== null) {
      titles.push(titleMatch[1].trim());
    }

    // Combinar
    for (let i = 0; i < Math.min(magnets.length, titles.length, 15); i++) {
      results.push({
        provedor: 'Snowfl',
        nome: titles[i],
        magnet: magnets[i],
        tamanho: 'N/A',
        seeds: 0
      });
    }

    log.info(`Snowfl: ${results.length} resultados`);
    return results;
  } catch (err) {
    log.warn(`Snowfl falhou: ${err.message}`);
    return [];
  }
}

// ===================== NYAA (ANIME) =====================
async function fetchNyaa(query) {
  try {
    log.info(`Buscando Nyaa: ${query}`);
    
    const { data: xml } = await axios.get('https://nyaa.si/?page=rss', {
      params: { q: query },
      timeout: 8000,
      headers: { 'User-Agent': 'brtorrent/1.0' }
    });

    const results = [];
    const xmlStr = typeof xml === 'string' ? xml : JSON.stringify(xml);

    // Parse items
    const itemRegex = /<item>[\s\S]*?<\/item>/gi;
    const items = xmlStr.match(itemRegex) || [];

    for (const item of items.slice(0, 15)) {
      const titleMatch = /<title><!\[CDATA\[(.*?)\]\]><\/title>/i.exec(item);
      const magnetMatch = item.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^&"\s]*/i);
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

    log.info(`Nyaa: ${results.length} resultados`);
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
    fetchBTDigg(query),
    fetchSnowfl(query),
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

  // Remover duplicatas pelo hash
  const seen = new Set();
  const unicos = [];
  
  for (const item of todos) {
    const hashMatch = item.magnet.match(/btih:([a-zA-Z0-9]+)/i);
    const hash = hashMatch ? hashMatch[1].toLowerCase() : '';
    
    if (hash && hash.length >= 32 && !seen.has(hash)) {
      seen.add(hash);
      unicos.push(item);
    }
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

    // Ordenar por qualidade
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
