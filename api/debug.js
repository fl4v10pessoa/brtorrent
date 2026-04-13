const { getTorrents } = require('./scraper');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const { q } = req.query;
    const query = q || 'Matrix 1999';
    
    const torrents = await getTorrents(query);
    
    return res.status(200).json({
      query,
      total: torrents.length,
      torrents: torrents.slice(0, 5) // Mostrar apenas primeiros 5
    });
  } catch (err) {
    console.error('Erro no debug:', err);
    return res.status(500).json({
      error: err.message,
      stack: err.stack
    });
  }
};
