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
    const { listingId, sellerEmail, title, description, price, unit, imageUrl } = req.body;

    if (!listingId || !sellerEmail) {
      return res.status(400).json({ error: 'Informations manquantes' });
    }

    // Vérifier que l'email correspond bien au vendeur propriétaire de l'annonce
    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id')
      .eq('email', sellerEmail)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sellerError || !seller) {
      return res.status(400).json({ error: 'Vendeur introuvable' });
    }

    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .select('seller_id')
      .eq('id', listingId)
      .single();

    if (listingError || !listing) {
      return res.status(404).json({ error: 'Annonce introuvable' });
    }

    if (listing.seller_id !== seller.id) {
      return res.status(403).json({ error: "Vous n'êtes pas autorisé à modifier cette annonce." });
    }

    const { error: updateError } = await supabase
      .from('listings')
      .update({
        title,
        description,
        price,
        unit,
        image_url: imageUrl,
      })
      .eq('id', listingId);

    if (updateError) throw updateError;

    res.status(200).json({ success: true });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
