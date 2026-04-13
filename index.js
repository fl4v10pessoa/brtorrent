const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const redis = require('redis');
const axios = require('axios');
require('dotenv').config();

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// ===================== LOGGING =====================
const log = {
  info: (msg, ...args) => console.log(`ℹ️  [${new Date().toISOString()}] INFO: ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`⚠️  [${new Date().toISOString()}] WARN: ${msg}`, ...args),
  error: (msg, ...args) => console.error(`❌ [${new Date().toISOString()}] ERROR: ${msg}`, ...args),
  success: (msg, ...args) => console.log(`✅ [${new Date().toISOString()}] SUCCESS: ${msg}`, ...args),
  debug: (msg, ...args) => process.env.DEBUG && console.log(`🔍 [${new Date().toISOString()}] DEBUG: ${msg}`, ...args)
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
  try {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
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
  } catch (err) {
    log.warn('Redis não disponível, operando sem cache:', err.message);
    redisAvailable = false;
  }
}

const CACHE_TTL = 3600; // 1 hora em segundos

// Rate limiting simples para não sobrecarregar os sites
const requestTimestamps = {};
const RATE_LIMIT_WINDOW = 1000; // 1 segundo entre requests por site
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

// ===================== SCRAPER MELHORADO =====================
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

    // Bloquear recursos desnecessários para performance
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

    // Aguardar conteúdo carregar
    await new Promise(resolve => setTimeout(resolve, 2000));

    const results = await page.evaluate((sel) => {
      const items = [];
      const itemElements = document.querySelectorAll(sel.items);

      itemElements.forEach(el => {
        const titleEl = el.querySelector(sel.title);
        let title = titleEl ? (titleEl.textContent || '').trim() : '';
        let detailLink = titleEl ? (titleEl.href || '') : '';

        // Limpar título
        title = title.replace(/\s+/g, ' ').trim();

        let magnet = '';
        const magnetEl = el.querySelector(sel.magnet);
        if (magnetEl) {
          magnet = magnetEl.href || '';
        }

        // Se não encontrou magnet no item, pode estar no link de detalhes
        if (!magnet && detailLink) {
          // Tenta extrair do onclick ou data attributes
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

    // Buscar magnets nos detalhes se necessário
    const finalResults = [];
    for (const item of results) {
      if (item.magnet && item.magnet.startsWith('magnet:')) {
        finalResults.push(item);
        continue;
      }

      // Tentar pegar magnet da página de detalhes
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
            finalResults.push(item); // Mantém mesmo sem magnet
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

    // Retry com delay
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

  // Scraping com controle de concorrência
  const siteNames = Object.keys(SITE_CONFIGS);
  const results = [];

  // Processar em lotes para não sobrecarregar
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

  // Remover duplicatas
  const seen = new Set();
  const unicos = results.filter(item => {
    const key = `${item.nome}|${item.tamanho}|${item.magnet?.substring(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Ordenar por seeds
  const resposta = unicos.sort((a, b) => b.seeds - a.seeds);

  log.success(`Total: ${resposta.length} torrents únicos encontrados`);

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
    browser: browser?.isConnected() ? 'connected' : 'disconnected',
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
  log.info('Iniciando Addon Torrents BR...');

  // Inicializar Redis
  await initRedis();

  // Inicializar browser
  try {
    await getBrowser();
  } catch (err) {
    log.error('Falha crítica ao iniciar browser:', err.message);
    log.warn('Addon iniciará sem capacidade de scraping');
  }

  app.listen(PORT, () => {
    log.success(`Addon rodando em http://localhost:${PORT}`);
    log.info(`Manifest: http://localhost:${PORT}/manifest.json`);
    log.info(`Health: http://localhost:${PORT}/health`);
  });
}

start().catch(err => {
  log.error('Erro fatal ao iniciar:', err.message);
  process.exit(1);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  log.info(`${signal} recebido, encerrando...`);

  if (browser?.isConnected()) {
    await browser.close().catch(() => {});
    log.info('Browser fechado');
  }

  if (redisAvailable) {
    await redisClient.quit().catch(() => {});
    log.info('Redis desconectado');
  }

  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Prevenir memory leaks do Puppeteer
setInterval(async () => {
  try {
    if (browser?.isConnected()) {
      const pages = await browser.pages();
      if (pages.length > 5) {
        log.warn(`Fechando ${pages.length - 1} páginas órfãs`);
        for (let i = 1; i < pages.length; i++) {
          await pages[i].close().catch(() => {});
        }
      }
    }
  } catch (err) {
    log.debug('Erro na limpeza de páginas:', err.message);
  }
}, 300000); // A cada 5 minutos
