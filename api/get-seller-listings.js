import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  realtime: {
    params: {
      eventsPerSecond: 0,
    },
  },
});

// Les réductions en pourcentage proposées aux professionnels
const ALLOWED_PERCENTS = [5, 10, 15, 20, 30];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// La date d'aujourd'hui à Paris, au format AAAA-MM-JJ
function todayInParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

// Vérifie qu'une date « AAAA-MM-JJ » existe vraiment (pas de 31 février)
function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Enregistre (ou retire) la promotion d'une annonce. Réservé aux vendeurs professionnels.
async function setPromotion(req, res, seller) {
  if (seller.seller_type !== 'professionnel') {
    return res.status(403).json({ error: 'Les promotions sont réservées aux vendeurs professionnels.' });
  }

  const body = req.body || {};
  const { listingId, mode } = body;

  if (!listingId) {
    return res.status(400).json({ error: 'Informations manquantes' });
  }

  const { data: listing, error: listingError } = await supabase
    .from('listings')
    .select('id, seller_id, price')
    .eq('id', listingId)
    .single();

  if (listingError || !listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }

  if (listing.seller_id !== seller.id) {
    return res.status(403).json({ error: "Vous n'êtes pas autorisé à modifier cette annonce." });
  }

  let update;

  if (mode === 'none') {
    // Retirer la promotion
    update = { promo_percent: null, promo_price: null, promo_starts_at: null, promo_ends_at: null };
  } else if (mode === 'percent' || mode === 'price') {
    const { startsAt, endsAt } = body;

    if (!isRealDate(startsAt) || !isRealDate(endsAt)) {
      return res.status(400).json({ error: 'Indiquez une date de début et une date de fin valides.' });
    }
    if (endsAt < startsAt) {
      return res.status(400).json({ error: 'La date de fin doit être le même jour ou après la date de début.' });
    }
    if (endsAt < todayInParis()) {
      return res.status(400).json({ error: 'La date de fin est déjà passée.' });
    }

    if (mode === 'percent') {
      const percent = Number(body.percent);
      if (!ALLOWED_PERCENTS.includes(percent)) {
        return res.status(400).json({ error: 'Réduction non proposée. Choisissez parmi : ' + ALLOWED_PERCENTS.map((p) => '-' + p + ' %').join(', ') + '.' });
      }
      update = { promo_percent: percent, promo_price: null, promo_starts_at: startsAt, promo_ends_at: endsAt };
    } else {
      const promoPrice = Math.round(Number(body.promoPrice) * 100) / 100;
      const normalPrice = Number(listing.price);
      if (!Number.isFinite(promoPrice) || promoPrice <= 0) {
        return res.status(400).json({ error: 'Indiquez un prix promotionnel supérieur à 0 €.' });
      }
      if (promoPrice >= normalPrice) {
        return res.status(400).json({ error: 'Le prix promotionnel doit être inférieur au prix normal (' + normalPrice.toFixed(2).replace('.', ',') + ' €).' });
      }
      update = { promo_percent: null, promo_price: promoPrice, promo_starts_at: startsAt, promo_ends_at: endsAt };
    }
  } else {
    return res.status(400).json({ error: 'Type de promotion inconnu.' });
  }

  const { error: updateError } = await supabase
    .from('listings')
    .update(update)
    .eq('id', listingId);

  if (updateError) throw updateError;

  return res.status(200).json({ success: true, promotion: update });
}

// GET : la liste de mes annonces. POST : enregistrer ou retirer une promotion sur une annonce.
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Non authentifié' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    if (userError || !userData.user) {
      return res.status(401).json({ error: 'Session invalide' });
    }

    const userId = userData.user.id;

    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id, seller_type')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sellerError || !seller) {
      return res.status(400).json({ error: "Aucun compte vendeur trouvé pour ce compte. Devenez d'abord vendeur." });
    }

    if (req.method === 'POST') {
      return await setPromotion(req, res, seller);
    }

    const { data: listings, error: listingsError } = await supabase
      .from('listings')
      .select('id, title, description, price, unit, quantity_available, category, subcategory, harvest_date, image_url, created_at, promo_percent, promo_price, promo_starts_at, promo_ends_at')
      .eq('seller_id', seller.id)
      .order('created_at', { ascending: false });

    if (listingsError) throw listingsError;

    res.status(200).json({ listings, sellerType: seller.seller_type === 'professionnel' ? 'professionnel' : 'particulier' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
    
