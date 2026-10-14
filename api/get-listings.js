import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  realtime: {
    params: {
      eventsPerSecond: 0,
    },
  },
});

// Moyenne des notes (1 à 4 fraises) de chaque vendeur : { average, count }.
// Les avis sont lus par paquets de 1000 (limite de la base) pour que la moyenne soit toujours exacte.
async function loadSellerRatings(sellerIds) {
  const totals = new Map();
  if (sellerIds.length === 0) return totals;

  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('reviews')
      .select('seller_id, rating')
      .in('seller_id', sellerIds)
      .order('seller_id', { ascending: true })
      .order('order_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;

    (data || []).forEach((row) => {
      const rating = Number(row.rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 4) return;
      const total = totals.get(row.seller_id) || { sum: 0, count: 0 };
      total.sum += rating;
      total.count += 1;
      totals.set(row.seller_id, total);
    });

    if (!data || data.length < PAGE_SIZE) break;
  }

  const ratings = new Map();
  totals.forEach((total, sellerId) => {
    ratings.set(sellerId, { average: total.sum / total.count, count: total.count });
  });
  return ratings;
}

// Les 5 derniers commentaires visibles d'un vendeur (jamais le nom ni l'identifiant de l'acheteur).
// Un commentaire masqué (hidden = true) ou vide n'est jamais envoyé.
const MIN_REVIEWS_FOR_COMMENTS = 3;
const MAX_COMMENTS = 5;

async function loadSellerComments(sellerId) {
  const { data, error } = await supabase
    .from('reviews')
    .select('rating, comment, created_at')
    .eq('seller_id', sellerId)
    .eq('hidden', false)
    .not('comment', 'is', null)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) throw error;

  return (data || [])
    .filter((row) => typeof row.comment === 'string' && row.comment.trim() !== '')
    .slice(0, MAX_COMMENTS)
    .map((row) => ({
      rating: Number(row.rating),
      comment: row.comment.trim().slice(0, 600),
      created_at: row.created_at,
    }));
}

// ---------------------------------------------------------------------------
// Administration : les commentaires des acheteurs (masquer un commentaire abusif).
// Réservé aux adresses e-mail de la variable ADMIN_EMAILS (séparées par des virgules), avec e-mail confirmé.
// Un commentaire masqué n'apparaît plus sur la page du vendeur ; la note reste comptée dans la moyenne.
// ---------------------------------------------------------------------------
const MAX_REVIEWS_LISTED = 100;

function isAdminEmail(email) {
  const list = String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return !!email && list.includes(String(email).trim().toLowerCase());
}

// Renvoie l'administrateur connecté, ou répond (401 / 403) et renvoie null
async function requireAdmin(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ error: 'Vous devez être connecté.' });
    return null;
  }
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData || !userData.user) {
    res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
    return null;
  }
  const user = userData.user;
  if (!isAdminEmail(user.email) || !user.email_confirmed_at) {
    res.status(403).json({ error: 'Accès réservé.' });
    return null;
  }
  return user;
}

async function adminListReviews() {
  const { data: reviews, error } = await supabase
    .from('reviews')
    .select('order_id, seller_id, rating, comment, created_at, hidden')
    .not('comment', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_REVIEWS_LISTED);
  if (error) throw new Error('Lecture des commentaires impossible : ' + error.message);

  const rows = (reviews || []).filter((r) => typeof r.comment === 'string' && r.comment.trim() !== '');
  const sellerIds = [...new Set(rows.map((r) => r.seller_id).filter(Boolean))];

  let sellers = [];
  if (sellerIds.length > 0) {
    const sellersResult = await supabase.from('sellers').select('id, city, pseudo').in('id', sellerIds);
    if (sellersResult.error) throw new Error('Lecture des vendeurs impossible : ' + sellersResult.error.message);
    sellers = sellersResult.data || [];
  }

  return {
    reviews: rows.map((r) => {
      const seller = sellers.find((x) => x.id === r.seller_id);
      return {
        orderId: r.order_id,
        sellerId: r.seller_id,
        rating: Number(r.rating),
        comment: r.comment,
        createdAt: r.created_at,
        hidden: r.hidden === true,
        sellerPseudo: seller ? seller.pseudo || null : null,
        sellerCity: seller ? seller.city || null : null,
      };
    }),
  };
}

async function handleAdminAction(req, res) {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { action, orderId, sellerId, hidden } = req.body || {};

    if (action === 'admin_list_reviews') {
      return res.status(200).json(await adminListReviews());
    }

    if (action === 'admin_set_review_hidden') {
      const validId = (value) => (typeof value === 'string' && value.trim() !== '') || typeof value === 'number';
      if (!validId(orderId) || !validId(sellerId) || typeof hidden !== 'boolean') {
        return res.status(400).json({ error: 'Demande invalide.' });
      }

      const { data, error } = await supabase
        .from('reviews')
        .update({ hidden })
        .eq('order_id', typeof orderId === 'string' ? orderId.trim() : orderId)
        .eq('seller_id', typeof sellerId === 'string' ? sellerId.trim() : sellerId)
        .select('order_id');
      if (error) {
        console.error('Erreur Supabase (masquer un commentaire) :', error);
        return res.status(500).json({ error: 'Impossible de modifier ce commentaire pour le moment. Réessayez.' });
      }
      if (!data || data.length === 0) {
        return res.status(404).json({ error: 'Commentaire introuvable.' });
      }
      return res.status(200).json({ hidden });
    }

    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}

export default async function handler(req, res) {
  // POST : actions de l'administrateur (modération des commentaires)
  if (req.method === 'POST') {
    return handleAdminAction(req, res);
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { data: listings, error } = await supabase
      .from('listings')
      .select('id, seller_id, title, description, price, unit, category, subcategory, harvest_date, image_url, created_at, quantity_available, listing_pickup_hours(day_of_week, slot, start_time, end_time), sellers(city, latitude, longitude, stripe_account_id, seller_type, pseudo)')
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

    // Page vendeur : ?listing=<id d'une annonce> renvoie le profil public de son vendeur.
    // L'identifiant du vendeur n'est jamais envoyé : on le retrouve ici à partir de l'annonce.
    const wantedListing = typeof req.query?.listing === 'string' ? req.query.listing : null;
    if (wantedListing) {
      const target = (listings || []).find(
        (item) => String(item.id) === wantedListing && item.sellers && item.sellers.city && item.seller_id
      );
      if (!target) {
        return res.status(404).json({ error: 'Vendeur introuvable' });
      }

      const sellerId = target.seller_id;
      let rating = { average: null, count: 0 };
      try {
        const sellerRatings = await loadSellerRatings([sellerId]);
        if (sellerRatings.get(sellerId)) rating = sellerRatings.get(sellerId);
      } catch (ratingError) {
        console.error('Lecture des avis impossible :', ratingError);
      }

      let reviews = [];
      if (rating.count >= MIN_REVIEWS_FOR_COMMENTS) {
        try {
          reviews = await loadSellerComments(sellerId);
        } catch (commentError) {
          console.error('Lecture des commentaires impossible :', commentError);
        }
      }

      const sellerListings = visibleListings
        .filter((item) => item.seller_id === sellerId)
        .map(({ seller_id, ...item }) => item);

      return res.status(200).json({
        seller: {
          pseudo: target.sellers.pseudo || null,
          city: target.sellers.city,
          seller_type: target.sellers.seller_type === 'professionnel' ? 'professionnel' : 'particulier',
          rating: { average: rating.count ? rating.average : null, count: rating.count },
          reviews,
          listings: sellerListings,
        },
      });
    }

    // La note moyenne du vendeur accompagne chaque annonce (jamais son identifiant)
    // Une panne de lecture des avis ne doit pas empêcher d'afficher les annonces.
    let ratings = new Map();
    try {
      ratings = await loadSellerRatings([...new Set(visibleListings.map((item) => item.seller_id).filter(Boolean))]);
    } catch (ratingError) {
      console.error('Lecture des avis impossible :', ratingError);
    }

    const listingsWithRating = visibleListings.map(({ seller_id, ...item }) => {
      const rating = ratings.get(seller_id);
      return { ...item, seller_rating: rating ? { average: rating.average, count: rating.count } : { average: null, count: 0 } };
    });

    res.status(200).json({ listings: listingsWithRating });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
