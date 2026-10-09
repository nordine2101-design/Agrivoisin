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
      .select('id, title, description, price, unit, category, subcategory, harvest_date, image_url, created_at, quantity_available, listing_pickup_hours(day_of_week, slot, start_time, end_time), sellers(city, latitude, longitude, stripe_account_id)')
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    // Une annonce n'apparaît sur le site que si la ville de son vendeur est connue
    // et reconnue sur la carte (la distance doit toujours pouvoir être calculée)
    // Une annonce épuisée (stock à 0) disparaît tout de suite de la liste.
    // Une quantité vide veut dire « sans limite » : c'est le cas des anciennes annonces.
    const visibleListings = (listings || []).filter(
      (item) =>
        item.sellers &&
        item.sellers.city &&
        item.sellers.latitude != null &&
        item.sellers.longitude != null &&
        (item.quantity_available == null || Number(item.quantity_available) > 0)
    );

    res.status(200).json({ listings: visibleListings });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
