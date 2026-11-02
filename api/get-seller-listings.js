import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  realtime: {
    params: {
      eventsPerSecond: 0,
    },
  },
});

// Les réductions en pourcentage proposées aux vendeurs
const ALLOWED_PERCENTS = [5, 10, 15, 20, 30];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Un lot : de 2 à 50 unités (50 = le maximum d'articles par paiement)
const MIN_LOT_QUANTITY = 2;
const MAX_LOT_QUANTITY = 50;

// La date d'aujourd'hui à Paris, au format AAAA-MM-JJ
function todayInParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

// « Bientôt mûr » : une récolte à venir reste visible jusqu'à 1 jour après sa date prévue
function addDaysIso(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function isComingSoonActive(item, today) {
  if (item.availability_status !== 'bientot_mur' || !item.planned_date) return false;
  return String(item.planned_date).slice(0, 10) >= addDaysIso(today, -1);
}

// Vérifie qu'une date « AAAA-MM-JJ » existe vraiment (pas de 31 février)
function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Enregistre (ou retire) la promotion d'une annonce (professionnels et particuliers).
async function setPromotion(req, res, seller) {
  const body = req.body || {};
  const { listingId, mode } = body;

  if (!listingId) {
    return res.status(400).json({ error: 'Informations manquantes' });
  }

  const { data: listing, error: listingError } = await supabase
    .from('listings')
    .select('id, seller_id, price, quantity_available')
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
    update = { promo_percent: null, promo_price: null, promo_starts_at: null, promo_ends_at: null, promo_clearance: false, lot_quantity: null, lot_price: null };
  } else if (mode === 'percent' || mode === 'price' || mode === 'lot') {
    // Déstockage : la réduction commence aujourd'hui et n'a pas de date de fin (elle s'arrête quand le stock est vendu)
    const clearance = mode !== 'lot' && body.clearance === true;
    let startsAt;
    let endsAt;

    if (clearance) {
      startsAt = todayInParis();
      endsAt = null;
    } else {
      startsAt = body.startsAt;
      endsAt = body.endsAt;

      if (!isRealDate(startsAt) || !isRealDate(endsAt)) {
        return res.status(400).json({ error: 'Indiquez une date de début et une date de fin valides.' });
      }
      if (endsAt < startsAt) {
        return res.status(400).json({ error: 'La date de fin doit être le même jour ou après la date de début.' });
      }
      if (endsAt < todayInParis()) {
        return res.status(400).json({ error: 'La date de fin est déjà passée.' });
      }
    }

    if (mode === 'lot') {
      // Un lot : un prix pour une quantité (par exemple 3 kg pour 7 €). Une annonce n'a qu'une seule offre à la fois.
      const lotQuantity = Number(body.lotQuantity);
      const lotPrice = Math.round(Number(body.lotPrice) * 100) / 100;
      const normalPrice = Number(listing.price);
      if (!Number.isInteger(lotQuantity) || lotQuantity < MIN_LOT_QUANTITY || lotQuantity > MAX_LOT_QUANTITY) {
        return res.status(400).json({ error: 'La quantité du lot doit être un nombre entier entre ' + MIN_LOT_QUANTITY + ' et ' + MAX_LOT_QUANTITY + '.' });
      }
      if (listing.quantity_available != null && lotQuantity > Number(listing.quantity_available)) {
        return res.status(400).json({ error: 'Le lot (' + lotQuantity + ') dépasse le stock disponible (' + Number(listing.quantity_available) + ').' });
      }
      if (!Number.isFinite(lotPrice) || lotPrice <= 0) {
        return res.status(400).json({ error: 'Indiquez un prix du lot supérieur à 0 €.' });
      }
      const fullPrice = Math.round(normalPrice * lotQuantity * 100) / 100;
      if (lotPrice >= fullPrice) {
        return res.status(400).json({ error: 'Le prix du lot doit être inférieur au prix normal de ' + lotQuantity + ' unités (' + fullPrice.toFixed(2).replace('.', ',') + ' €).' });
      }
      update = {
        promo_percent: null,
        promo_price: null,
        promo_clearance: false,
        promo_starts_at: startsAt,
        promo_ends_at: endsAt,
        lot_quantity: lotQuantity,
        lot_price: lotPrice,
      };
    } else if (mode === 'percent') {
      const percent = Number(body.percent);
      if (!ALLOWED_PERCENTS.includes(percent)) {
        return res.status(400).json({ error: 'Réduction non proposée. Choisissez parmi : ' + ALLOWED_PERCENTS.map((p) => '-' + p + ' %').join(', ') + '.' });
      }
      update = { promo_percent: percent, promo_price: null, promo_starts_at: startsAt, promo_ends_at: endsAt, promo_clearance: clearance, lot_quantity: null, lot_price: null };
    } else {
      const promoPrice = Math.round(Number(body.promoPrice) * 100) / 100;
      const normalPrice = Number(listing.price);
      if (!Number.isFinite(promoPrice) || promoPrice <= 0) {
        return res.status(400).json({ error: 'Indiquez un prix promotionnel supérieur à 0 €.' });
      }
      if (promoPrice >= normalPrice) {
        return res.status(400).json({ error: 'Le prix promotionnel doit être inférieur au prix normal (' + normalPrice.toFixed(2).replace('.', ',') + ' €).' });
      }
      update = { promo_percent: null, promo_price: promoPrice, promo_starts_at: startsAt, promo_ends_at: endsAt, promo_clearance: clearance, lot_quantity: null, lot_price: null };
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

// GET : la liste de mes annonces (sans les récoltes « Bientôt mûr »), ou avec ?status=bientot_mur la liste de mes récoltes à venir.
// POST : enregistrer ou retirer une promotion sur une annonce.
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
      .select('id, title, description, price, unit, quantity_available, category, subcategory, harvest_date, image_url, created_at, promo_percent, promo_price, promo_starts_at, promo_ends_at, promo_clearance, lot_quantity, lot_price, availability_status, planned_date, price_locked')
      .eq('seller_id', seller.id)
      .order('created_at', { ascending: false });

    if (listingsError) throw listingsError;

    const sellerType = seller.seller_type === 'professionnel' ? 'professionnel' : 'particulier';

    // Les deux listes ne se mélangent jamais : « Mes annonces » ne contient que les annonces en vente,
    // les récoltes « Bientôt mûr » sont sur leur page à part.
    if (req.query && req.query.status === 'bientot_mur') {
      const today = todayInParis();
      const coming = (listings || []).filter((item) => isComingSoonActive(item, today));
      const ids = coming.map((item) => item.id);

      // Pour chaque récolte : la quantité réservée, le nombre de personnes, et le nombre d'alertes (jamais leurs noms ni leurs e-mails)
      const reserved = {};
      const people = {};
      const alerts = {};
      if (ids.length > 0) {
        const { data: heldRows, error: heldError } = await supabase
          .from('listing_reservations')
          .select('listing_id, quantity')
          .in('listing_id', ids)
          .eq('status', 'active');
        if (heldError) throw heldError;
        (heldRows || []).forEach((row) => {
          const key = String(row.listing_id);
          reserved[key] = (reserved[key] || 0) + (Number(row.quantity) || 0);
          people[key] = (people[key] || 0) + 1;
        });

        const { data: alertRows, error: alertError } = await supabase
          .from('listing_alerts')
          .select('listing_id')
          .in('listing_id', ids)
          .is('notified_at', null);
        if (alertError) throw alertError;
        (alertRows || []).forEach((row) => {
          const key = String(row.listing_id);
          alerts[key] = (alerts[key] || 0) + 1;
        });
      }

      return res.status(200).json({
        listings: coming.map((item) => ({
          ...item,
          reserved_quantity: reserved[String(item.id)] || 0,
          reservations_count: people[String(item.id)] || 0,
          alerts_count: alerts[String(item.id)] || 0,
        })),
        sellerType,
      });
    }

    const onSale = (listings || []).filter((item) => (item.availability_status || 'disponible') === 'disponible');

    res.status(200).json({ listings: onSale, sellerType });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
