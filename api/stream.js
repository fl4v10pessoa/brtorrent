const { handleStream } = require('./scraper');

const streamHandler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { type, id, season, episode } = req.query;

    if (!type || !id) {
      return res.status(400).json({ error: 'Parâmetros type e id são obrigatórios' });
    }

    const result = await handleStream(
      type,
      id,
      season ? parseInt(season) : null,
      episode ? parseInt(episode) : null
    );

    return res.status(200).json(result);
  } catch (err) {
    console.error('Erro no stream handler:', err.message);
    return res.status(500).json({ 
      streams: [], 
      error: 'Erro interno do servidor' 
    });
  }
};

module.exports = streamHandler;
