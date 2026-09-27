export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { city } = req.query;

  if (!city) {
    return res.status(400).json({ error: 'Ville manquante' });
  }

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city + ', France')}&format=json&limit=1`,
      { headers: { 'User-Agent': 'Agrivoisin/1.0' } }
    );
    const results = await response.json();

    if (results && results.length > 0) {
      return res.status(200).json({
        latitude: parseFloat(results[0].lat),
        longitude: parseFloat(results[0].lon),
      });
    }

    return res.status(404).json({ error: 'Ville introuvable' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
