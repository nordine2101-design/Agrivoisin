import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  realtime: {
    params: {
      eventsPerSecond: 0,
    },
  },
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: 'E-mail manquant' });
    }

    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sellerError || !seller) {
      return res.status(400).json({ error: "Aucun compte vendeur trouvé pour cet e-mail." });
    }

    const { data: listings, error: listingsError } = await supabase
      .from('listings')
      .select('id, title, description, price, unit, category, subcategory, harvest_date, image_url, created_at')
      .eq('seller_id', seller.id)
      .order('created_at', { ascending: false });

    if (listingsError) throw listingsError;

    res.status(200).json({ listings });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
