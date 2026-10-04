import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  realtime: {
    params: {
      eventsPerSecond: 0,
    },
  },
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Vous devez être connecté pour publier une annonce.' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    if (userError || !userData.user) {
      return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
    }

    const userId = userData.user.id;
    const { title, description, price, unit, category, subcategory, harvestDate, imageUrl } = req.body;

    // 1. Retrouver le vendeur lié à ce compte connecté
    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id, city, latitude, longitude')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sellerError || !seller) {
      return res.status(400).json({ error: "Aucun compte vendeur trouvé pour ce compte. Devenez d'abord vendeur." });
    }

    // 2. Une annonce n'est publiée que si la ville du vendeur est connue et reconnue sur la carte
    //    (c'est ce qui permet de calculer la distance avec les acheteurs)
    if (!seller.city || seller.latitude == null || seller.longitude == null) {
      return res.status(400).json({
        error: "Votre ville n'est pas encore reconnue sur la carte, votre annonce ne peut donc pas être publiée. Renseignez votre ville et votre code postal sur la page « Devenir vendeur » (vendre.html).",
      });
    }

    // 3. Créer l'annonce liée à ce vendeur
    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .insert({
        seller_id: seller.id,
        title,
        description,
        price,
        unit,
        category,
        subcategory,
        harvest_date: harvestDate,
        image_url: imageUrl,
      })
      .select()
      .single();

    if (listingError) {
      throw listingError;
    }

    res.status(200).json({ listing });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
