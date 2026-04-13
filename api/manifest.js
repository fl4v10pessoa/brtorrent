module.exports = async (req, res) => {
  // Headers CORS essenciais para Stremio
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const manifest = {
    id: 'org.fl4v10.brtorrent',
    version: '2.1.0',
    name: 'Torrents BR',
    description: 'Addon estilo Torrentio para sites brasileiros de torrents. Busca automática em múltiplos sites com cache otimizado.',
    logo: 'https://img.icons8.com/color/96/torrent.png',
    background: 'https://img.icons8.com/color/416/torrent.png',
    resources: [
      {
        name: 'stream',
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'kitsu']
      }
    ],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };

  return res.status(200).json(manifest);
};
