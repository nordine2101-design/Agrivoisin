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
    const { data: listings, error } = await supabase
      .from('listings')
      .select('id, title, description, price, unit, category, subcategory, harvest_date, image_url, created_at, sellers(email, city, stripe_account_id)')
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    res.status(200).json({ listings });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}

