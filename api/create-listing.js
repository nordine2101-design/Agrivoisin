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

// Catégories que les particuliers peuvent vendre (produits frais, non transformés).
// Toutes les autres sont réservées aux vendeurs professionnels.
const PARTICULIER_CATEGORIES = ['Fruits', 'Légumes', 'Aromates', 'Fleurs du jardin'];

// Quantité disponible : un nombre entier d'unités (par exemple 5 kg ou 3 bottes), de 1 à 9999
const MAX_QUANTITY = 9999;

function validateQuantity(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUANTITY) {
    return { error: 'Indiquez la quantité disponible : un nombre entier entre 1 et ' + MAX_QUANTITY + '.' };
  }
  return { quantity: value };
}

// Modes de remise : retrait chez le vendeur, expédition par le vendeur, ou les deux au choix de l'acheteur
const DELIVERY_MODES = ['retrait', 'expedition', 'les_deux'];

// Frais d'expédition : des paliers selon la quantité commandée, par exemple
// 1 à 2 unités = 5,00 €, 3 à 5 unités = 8,00 €. Le vendeur les écrit librement : ils ne dépendent pas du stock.
// Seule règle : deux paliers ne se chevauchent pas. Au-delà du dernier palier (ou entre deux paliers), l'expédition
// n'est pas proposée pour cette quantité (le retrait reste possible).
// Renvoie { tiers } (paliers propres) ou { error }.
const MAX_TIERS = 10;
const MAX_SHIPPING_PRICE = 500;

function validateShippingTiers(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: "Indiquez vos frais d'expédition : au moins un palier est obligatoire." };
  }
  if (input.length > MAX_TIERS) {
    return { error: "Trop de paliers de frais d'expédition : " + MAX_TIERS + ' au maximum.' };
  }

  const tiers = [];
  for (const t of input) {
    if (!t || typeof t !== 'object') {
      return { error: "Palier de frais d'expédition invalide." };
    }
    if (!Number.isInteger(t.min) || !Number.isInteger(t.max) || t.min < 1 || t.max < t.min || t.max > MAX_QUANTITY) {
      return { error: "Frais d'expédition : chaque palier doit aller d'une quantité de départ à une quantité de fin (nombres entiers, la fin n'est pas avant le début)." };
    }
    if (typeof t.price !== 'number' || !Number.isFinite(t.price) || t.price < 0 || t.price > MAX_SHIPPING_PRICE) {
      return { error: "Frais d'expédition : le montant d'un palier doit être compris entre 0 € et " + MAX_SHIPPING_PRICE + ' €.' };
    }
    if (Math.round(t.price * 100) !== t.price * 100 && Math.abs(Math.round(t.price * 100) - t.price * 100) > 1e-6) {
      return { error: "Frais d'expédition : un montant ne peut pas avoir plus de deux chiffres après la virgule." };
    }
    tiers.push({ min: t.min, max: t.max, price: Math.round(t.price * 100) / 100 });
  }

  tiers.sort((a, b) => a.min - b.min);

  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].min <= tiers[i - 1].max) {
      return { error: "Frais d'expédition : deux paliers ne peuvent pas se chevaucher (un palier commence après la fin du précédent)." };
    }
  }

  return { tiers };
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
    const { title, description, price, unit, category, subcategory, harvestDate, imageUrl, pickupHours, quantity, proAttest, deliveryMode, shippingTiers, multiParcel } = req.body;

    // 1. Retrouver le vendeur lié à ce compte connecté
    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id, city, latitude, longitude, seller_type')
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

    // 2 bis. Les catégories de produits transformés, de miel, de plants et de graines
    //        sont réservées aux vendeurs professionnels
    if (seller.seller_type !== 'professionnel' && !PARTICULIER_CATEGORIES.includes(category)) {
      return res.status(403).json({
        error: 'Cette catégorie est réservée aux vendeurs professionnels. En tant que particulier, vous pouvez vendre des fruits, des légumes, des aromates et des fleurs du jardin.',
      });
    }

    // 2 ter. Un professionnel qui vend une catégorie réservée aux professionnels doit avoir confirmé
    //        (case à cocher) qu'il a déclaré son activité et respecte l'étiquetage : on garde la date
    let proAttestedAt = null;
    if (seller.seller_type === 'professionnel' && !PARTICULIER_CATEGORIES.includes(category)) {
      if (proAttest !== true) {
        return res.status(400).json({
          error: "Pour publier cette annonce, cochez la case de confirmation : vous avez déclaré votre activité aux autorités compétentes et vous respectez l'étiquetage obligatoire de vos produits.",
        });
      }
      proAttestedAt = new Date().toISOString();
    }

    // 3. Le mode de remise : retrait (par défaut), expédition, ou les deux.
    //    L'expédition est réservée aux professionnels qui vendent une catégorie réservée aux professionnels
    //    (produits qui se conservent), jamais aux fruits et légumes frais.
    const mode = deliveryMode == null ? 'retrait' : deliveryMode;
    if (!DELIVERY_MODES.includes(mode)) {
      return res.status(400).json({ error: "Mode de remise invalide : choisissez retrait, expédition ou les deux." });
    }
    if (mode !== 'retrait' && !(seller.seller_type === 'professionnel' && !PARTICULIER_CATEGORIES.includes(category))) {
      return res.status(403).json({ error: "L'expédition n'est pas possible pour cette catégorie de produits : seul le retrait est proposé." });
    }

    // 4. La quantité disponible est obligatoire pour une nouvelle annonce, et vérifiée ici
    const stock = validateQuantity(quantity);
    if (stock.error) {
      return res.status(400).json({ error: stock.error });
    }

    // 4 bis. Les horaires de retrait sont obligatoires dès que le retrait est proposé (retrait ou les deux)
    let hours = { rows: [] };
    if (mode !== 'expedition') {
      hours = validatePickupHours(pickupHours);
      if (hours.error) {
        return res.status(400).json({ error: hours.error });
      }
    }

    // 4 ter. Les frais d'expédition par paliers sont obligatoires dès que l'expédition est proposée
    let shipping = { tiers: null };
    if (mode !== 'retrait') {
      shipping = validateShippingTiers(shippingTiers);
      if (shipping.error) {
        return res.status(400).json({ error: shipping.error });
      }
    }

    // 4 quater. Plusieurs colis : toujours possible quand l'expédition est proposée (l'acheteur paie les frais de chaque colis).
    //    Le vendeur n'a pas de case à cocher : aucun frein à la vente.
    const acceptsMultiParcel = mode !== 'retrait';

    // 5. Créer l'annonce liée à ce vendeur
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
        quantity_available: stock.quantity,
        pro_attested_at: proAttestedAt,
        delivery_mode: mode,
        shipping_tiers: shipping.tiers,
        multi_parcel: acceptsMultiParcel,
      })
      .select()
      .single();

    if (listingError) {
      throw listingError;
    }

    // 6. Ranger les horaires de retrait avec l'annonce
    let hoursError = null;
    if (hours.rows.length > 0) {
      ({ error: hoursError } = await supabase
        .from('listing_pickup_hours')
        .insert(hours.rows.map((h) => ({ ...h, listing_id: listing.id }))));
    }

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
