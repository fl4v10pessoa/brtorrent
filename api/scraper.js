const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const redis = require('redis');
const axios = require('axios');

puppeteer.use(StealthPlugin());

// ===================== LOGGING =====================
const log = {
  info: (msg, ...args) => console.log(`ℹ️  [${new Date().toISOString()}] INFO: ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`⚠️  [${new Date().toISOString()}] WARN: ${msg}`, ...args),
  error: (msg, ...args) => console.error(`❌ [${new Date().toISOString()}] ERROR: ${msg}`, ...args),
  success: (msg, ...args) => console.log(`✅ [${new Date().toISOString()}] SUCCESS: ${msg}`, ...args),
  debug: (msg, ...args) => process.env.DEBUG === 'true' && console.log(`🔍 [${new Date().toISOString()}] DEBUG: ${msg}`, ...args)
};

// ===================== CONFIG =====================
let browser;
let browserLaunchRetries = 0;
const MAX_BROWSER_RETRIES = 3;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    while (browserLaunchRetries < MAX_BROWSER_RETRIES) {
      try {
        log.info(`Iniciando Puppeteer (tentativa ${browserLaunchRetries + 1}/${MAX_BROWSER_RETRIES})...`);
        browser = await puppeteer.launch({
          headless: 'new',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-extensions'
          ]
        });
        browserLaunchRetries = 0;
        log.success('Puppeteer iniciado com sucesso');
        break;
      } catch (err) {
        browserLaunchRetries++;
        log.error(`Falha ao iniciar Puppeteer (${browserLaunchRetries}/${MAX_BROWSER_RETRIES}):`, err.message);
        if (browserLaunchRetries >= MAX_BROWSER_RETRIES) {
          throw new Error(`Não foi possível iniciar o Puppeteer após ${MAX_BROWSER_RETRIES} tentativas`);
        }
        await new Promise(resolve => setTimeout(resolve, 2000 * browserLaunchRetries));
      }
    }
  }
  return browser;
}

// Redis com fallback
let redisClient;
let redisAvailable = false;

async function initRedis() {
  if (redisAvailable || redisClient) return;
  
  try {
    const redisUrl = process.env.REDIS_URL || process.env.KV_REST_API_URL;
    if (!redisUrl) {
      log.warn('REDIS_URL não configurado, operando sem cache');
      return;
    }

    redisClient = redis.createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) => {
          if (retries > 5) {
            log.warn('Redis não disponível, operando sem cache');
            redisAvailable = false;
            return new Error('Redis não disponível');
          }
          return Math.min(retries * 100, 3000);
        }
      }
    });

    redisClient.on('error', (err) => {
      log.warn('Erro Redis:', err.message);
      redisAvailable = false;
    });

    redisClient.on('connect', () => {
      log.success('Redis conectado');
      redisAvailable = true;
    });

    await redisClient.connect();
    redisAvailable = true;
  } catch (err) {
    log.warn('Redis não disponível, operando sem cache:', err.message);
    redisAvailable = false;
  }
}

const CACHE_TTL = 3600;

// Rate limiting
const requestTimestamps = {};
const RATE_LIMIT_WINDOW = 1000;
const MAX_CONCURRENT_SCRAPES = 2;

async function rateLimitCheck(siteName) {
  const now = Date.now();
  const lastRequest = requestTimestamps[siteName] || 0;
  const timeToWait = Math.max(0, RATE_LIMIT_WINDOW - (now - lastRequest));
  if (timeToWait > 0) {
    log.debug(`Rate limit: aguardando ${timeToWait}ms para ${siteName}`);
    await new Promise(resolve => setTimeout(resolve, timeToWait));
  }
  requestTimestamps[siteName] = Date.now();
}

// ===================== SITES DE BUSCA =====================
const SITES_BUSCA = [
  {
    nome: 'Comando.la',
    url: 'https://comando.la',
    descricao: 'Um dos maiores sites de torrents brasileiros com vasta coleção de filmes e séries'
  },
  {
    nome: 'BluDV1',
    url: 'https://bludv1.com',
    descricao: 'Site especializado em conteúdo em alta qualidade (BluRay, WEB-DL, etc)'
  },
  {
    nome: 'HDRTorrent',
    url: 'https://hdrtorrent.com',
    descricao: 'Focado em conteúdo HDR e alta qualidade'
  },
  {
    nome: 'RedeTorrent',
    url: 'https://redetorrent.com',
    descricao: 'Site brasileiro com grande acervo de filmes e séries nacionalizadas'
  },
  {
    nome: 'Torrents dos Filmes',
    url: 'https://torrentsdosfilmes1.com',
    descricao: 'Especializado em filmes dublados e legendados em português'
  }
];

// ===================== SCRAPER =====================
const SITE_CONFIGS = {
  'comando.la': {
    url: (q) => `https://comando.la/?s=${encodeURIComponent(q)}`,
    selectors: {
      items: 'article, .post, .entry, .result-item',
      title: 'h2 a, .title a, h2, .entry-title',
      magnet: 'a[href^="magnet:"], a[href*="magnet:"]',
      size: '.size, .tamanho, .filesize, .meta-size',
      seeds: '.seeds, .seeders, .seed, .meta-seed'
    }
  },
  'bludv1.com': {
    url: (q) => `https://bludv1.com/?s=${encodeURIComponent(q)}`,
    selectors: {
      items: 'article, .post, .item, .blog-item',
      title: 'h2 a, .title a, h3 a, .entry-title',
      magnet: 'a[href^="magnet:"], a[href*="magnet:"]',
      size: '.size, .tamanho, .filesize',
      seeds: '.seeds, .seeders, .seed'
    }
  },
  'hdrtorrent.com': {
    url: (q) => `https://hdrtorrent.com/?s=${encodeURIComponent(q)}`,
    selectors: {
      items: 'tr, .torrent-row, .torrent, table tr',
      title: 'td a, .torrent-name a, a[href*="torrent"]',
      magnet: 'a[href^="magnet:"], a[href*="magnet:"]',
      size: 'td.size, .tamanho, .size',
      seeds: 'td.seeds, .seeders, .seed'
    }
  },
  'redetorrent.com': {
    url: (q) => `https://redetorrent.com/?s=${encodeURIComponent(q)}`,
    selectors: {
      items: 'article, .post, .item, .movie-item',
      title: 'h2 a, .title a, h3, .entry-title',
      magnet: 'a[href^="magnet:"], a[href*="magnet:"]',
      size: '.size, .tamanho, .filesize',
      seeds: '.seeds, .seeders, .seed'
    }
  },
  'torrentsdosfilmes1.com': {
    url: (q) => `https://torrentsdosfilmes1.com/?s=${encodeURIComponent(q)}`,
    selectors: {
      items: 'article, .post, .item, .torrent-item',
      title: 'h2 a, .title a, h3 a, .entry-title',
      magnet: 'a[href^="magnet:"], a[href*="magnet:"]',
      size: '.size, .tamanho, .filesize',
      seeds: '.seeds, .seeders, .seed'
    }
  }
};

async function scrapeSite(siteName, searchUrl, selectors, retries = 2) {
  await rateLimitCheck(siteName);

  let browserInstance;
  let page;

  try {
    browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    log.info(`Scraping ${siteName}...`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const results = await page.evaluate((sel) => {
      const items = [];
      const itemElements = document.querySelectorAll(sel.items);

      itemElements.forEach(el => {
        const titleEl = el.querySelector(sel.title);
        let title = titleEl ? (titleEl.textContent || '').trim() : '';
        let detailLink = titleEl ? (titleEl.href || '') : '';

        title = title.replace(/\s+/g, ' ').trim();

        let magnet = '';
        const magnetEl = el.querySelector(sel.magnet);
        if (magnetEl) {
          magnet = magnetEl.href || '';
        }

        if (!magnet && detailLink) {
          const onclickAttr = el.getAttribute('onclick') || '';
          const dataMagnet = el.getAttribute('data-magnet') || '';
          magnet = dataMagnet || (onclickAttr.includes('magnet') ? onclickAttr.match(/magnet:[^"]*/)?.[0] || '' : '');
        }

        const sizeEl = el.querySelector(sel.size);
        const size = sizeEl ? (sizeEl.textContent || '').trim() : 'N/A';

        const seedsEl = el.querySelector(sel.seeds);
        const seedsText = seedsEl ? (seedsEl.textContent || '').trim() : '0';
        const seeds = parseInt(seedsText.replace(/\D/g, '')) || 0;

        if (title && title.length > 5) {
          items.push({ title, detailLink, magnet, size, seeds });
        }
      });

      return items.slice(0, 20);
    }, selectors);

    const finalResults = [];
    for (const item of results) {
      if (item.magnet && item.magnet.startsWith('magnet:')) {
        finalResults.push(item);
        continue;
      }

      if (item.detailLink && item.detailLink.startsWith('http')) {
        try {
          const detailPage = await browserInstance.newPage();
          await detailPage.setRequestInterception(true);
          detailPage.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
              req.abort();
            } else {
              req.continue();
            }
          });

          await detailPage.goto(item.detailLink, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await new Promise(resolve => setTimeout(resolve, 1500));

          const magnet = await detailPage.evaluate(() => {
            const magnetEl = document.querySelector('a[href^="magnet:"], a[href*="magnet:"]');
            return magnetEl ? magnetEl.href : '';
          });

          await detailPage.close().catch(() => {});

          if (magnet && magnet.startsWith('magnet:')) {
            finalResults.push({ ...item, magnet });
          } else {
            finalResults.push(item);
          }
        } catch (err) {
          log.debug(`Erro ao buscar magnet em ${item.detailLink}: ${err.message}`);
          finalResults.push(item);
        }
      } else {
        finalResults.push(item);
      }
    }

    await page.close().catch(() => {});

    log.success(`${siteName}: ${finalResults.length} resultados encontrados`);

    return finalResults
      .filter(r => r.magnet && r.magnet.startsWith('magnet:'))
      .map(r => ({
        provedor: siteName,
        nome: r.nome || r.title,
        tamanho: r.size || 'N/A',
        seeds: r.seeds || 0,
        magnet: r.magnet
      }));
  } catch (e) {
    log.error(`${siteName} falhou:`, e.message);

    if (retries > 0) {
      log.info(`Tentando novamente ${siteName} (${retries} retries restantes)...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return scrapeSite(siteName, searchUrl, selectors, retries - 1);
    }

    await page?.close().catch(() => {});
    return [];
  }
}

// ===================== BUSCA COM CACHE =====================
async function getTorrents(query) {
  const normalizedQuery = query.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const cacheKey = `torrentsbr:${normalizedQuery}`;

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

  const siteNames = Object.keys(SITE_CONFIGS);
  const results = [];

  for (let i = 0; i < siteNames.length; i += MAX_CONCURRENT_SCRAPES) {
    const batch = siteNames.slice(i, i + MAX_CONCURRENT_SCRAPES);
    const promises = batch.map(async (siteName) => {
      const config = SITE_CONFIGS[siteName];
      try {
        return await scrapeSite(siteName, config.url(query), config.selectors);
      } catch (err) {
        log.error(`Erro em ${siteName}:`, err.message);
        return [];
      }
    });

    const batchResults = await Promise.allSettled(promises);
    batchResults.forEach(r => {
      if (r.status === 'fulfilled' && r.value?.length) {
        results.push(...r.value);
      }
    });
  }

  const seen = new Set();
  const unicos = results.filter(item => {
    const key = `${item.nome}|${item.tamanho}|${item.magnet?.substring(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const resposta = unicos.sort((a, b) => b.seeds - a.seeds);

  log.success(`Total: ${resposta.length} torrents únicos encontrados`);

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

    if (meta.releaseInfo) {
      const year = meta.releaseInfo.match(/\d{4}/)?.[0];
      if (year) query += ` ${year}`;
    }

    if ((type === 'series' || type === 'anime') && season && episode) {
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

// Exportar para uso nas serverless functions
module.exports = {
  getBrowser,
  initRedis,
  getTorrents,
  handleStream,
  extrairQualidade,
  SITES_BUSCA,
  log
};
