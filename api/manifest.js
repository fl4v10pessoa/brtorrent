const manifestHandler = async (req, res) => {
  const baseUrl = process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}`
    : process.env.BASE_URL || 'http://localhost:3000';

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  res.status(200).json({
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
};

module.exports = manifestHandler;
