const { getTorrents } = require('./scraper');

module.exports = async (req, res) => {
  // Headers CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Parâmetro q é obrigatório' });
    }

    const resultados = await getTorrents(q);
    return res.status(200).json({
      busca: q,
      total: resultados.length,
      resultados
    });
  } catch (err) {
    console.error('Erro na busca:', err.message);
    return res.status(500).json({
      error: 'Erro na busca',
      detalhes: err.message
    });
  }
};
