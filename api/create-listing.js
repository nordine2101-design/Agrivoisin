import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { sellerEmail, title, description, price, unit, category, imageUrl } = req.body;

    // 1. Retrouver le vendeur à partir de son e-mail
    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id')
      .eq('email', sellerEmail)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sellerError || !seller) {
      return res.status(400).json({ error: "Aucun compte vendeur trouvé pour cet e-mail. Créez d'abord votre compte de paiement." });
    }

    // 2. Créer l'annonce liée à ce vendeur
    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .insert({
        seller_id: seller.id,
        title,
        description,
        price,
        unit,
        category,
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
