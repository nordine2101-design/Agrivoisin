import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  realtime: {
    params: {
      eventsPerSecond: 0,
    },
  },
});

const DAY_LABELS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Vérifie les horaires de retrait reçus du navigateur : on ne leur fait jamais confiance sur parole.
// Renvoie { rows } (horaires propres, prêts à ranger) ou { error }.
function validatePickupHours(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'Indiquez au moins un horaire de retrait pour publier votre annonce.' };
  }
  if (input.length > 14) {
    return { error: 'Trop de plages horaires : deux au maximum par jour.' };
  }

  const byDay = {};
  for (const h of input) {
    if (!h || typeof h !== 'object') {
      return { error: 'Horaire de retrait invalide.' };
    }
    if (!Number.isInteger(h.day_of_week) || h.day_of_week < 1 || h.day_of_week > 7) {
      return { error: 'Jour de retrait invalide.' };
    }
    const day = DAY_LABELS[h.day_of_week];
    if (h.slot !== 1 && h.slot !== 2) {
      return { error: day + ' : plage horaire invalide.' };
    }
    if (typeof h.start_time !== 'string' || typeof h.end_time !== 'string' || !TIME_RE.test(h.start_time) || !TIME_RE.test(h.end_time)) {
      return { error: day + ' : heure invalide.' };
    }
    if (h.end_time <= h.start_time) {
      return { error: day + " : l'heure de fin doit être après l'heure de début." };
    }
    byDay[h.day_of_week] = byDay[h.day_of_week] || {};
    if (byDay[h.day_of_week][h.slot]) {
      return { error: day + ' : la même plage est indiquée deux fois.' };
    }
    byDay[h.day_of_week][h.slot] = h;
  }

  for (const dayNumber of Object.keys(byDay)) {
    const first = byDay[dayNumber][1];
    const second = byDay[dayNumber][2];
    if (second && !first) {
      return { error: DAY_LABELS[dayNumber] + ' : la 2e plage suppose une 1re plage.' };
    }
    if (first && second && second.start_time < first.end_time) {
      return { error: DAY_LABELS[dayNumber] + ' : la 2e plage doit commencer après la fin de la 1re.' };
    }
  }

  // On ne garde que les champs attendus (rien d'autre ne passe)
  return {
    rows: input.map((h) => ({
      day_of_week: h.day_of_week,
      slot: h.slot,
      start_time: h.start_time,
      end_time: h.end_time,
    })),
  };
}

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
    const { title, description, price, unit, category, subcategory, harvestDate, imageUrl, pickupHours } = req.body;

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

    // 3. Les horaires de retrait de cette annonce sont obligatoires, et vérifiés ici
    const hours = validatePickupHours(pickupHours);
    if (hours.error) {
      return res.status(400).json({ error: hours.error });
    }

    // 4. Créer l'annonce liée à ce vendeur
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

    // 5. Ranger les horaires de retrait avec l'annonce
    const { error: hoursError } = await supabase
      .from('listing_pickup_hours')
      .insert(hours.rows.map((h) => ({ ...h, listing_id: listing.id })));

    if (hoursError) {
      console.error('Erreur Supabase (horaires de retrait) :', hoursError);

      // On retire l'annonce qui vient d'être créée : il ne doit jamais y en avoir une sans horaires
      const { error: rollbackError } = await supabase.from('listings').delete().eq('id', listing.id);
      if (rollbackError) {
        console.error("Impossible de retirer l'annonce incomplète :", rollbackError);
      }

      return res.status(500).json({
        error: "Votre annonce n'a pas pu être publiée avec ses horaires de retrait. Réessayez dans quelques instants.",
      });
    }

    res.status(200).json({ listing, pickupHours: hours.rows });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
