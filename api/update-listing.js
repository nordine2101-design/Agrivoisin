import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  realtime: {
    params: {
      eventsPerSecond: 0,
    },
  },
});

// Cette fonction sert à modifier une annonce depuis « Mes annonces » :
//   GET  /api/update-listing?id=...  -> renvoie l'annonce (et ses horaires de retrait) pour remplir le formulaire
//   POST /api/update-listing         -> enregistre les modifications
//   POST /api/update-listing avec { action: 'delete', listingId } -> supprime l'annonce
// Seul le vendeur qui a publié l'annonce peut la lire ici et la modifier.

const DAY_LABELS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const MAX_TITLE = 25;
const MAX_DESCRIPTION = 200;
const MAX_QUANTITY = 9999;
const MAX_PRICE = 10000;
const MAX_TIERS = 10;
const MAX_SHIPPING_PRICE = 500;
const DELIVERY_MODES = ['retrait', 'expedition', 'les_deux'];

// Catégories que les particuliers peuvent vendre (produits frais, non transformés).
// Toutes les autres sont réservées aux vendeurs professionnels.
const PARTICULIER_CATEGORIES = ['Fruits', 'Légumes', 'Aromates', 'Fleurs du jardin'];

// Vérifie les horaires de retrait reçus du navigateur : on ne leur fait jamais confiance sur parole.
function validatePickupHours(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'Indiquez au moins un horaire de retrait pour enregistrer votre annonce.' };
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

  return {
    rows: input.map((h) => ({
      day_of_week: h.day_of_week,
      slot: h.slot,
      start_time: h.start_time,
      end_time: h.end_time,
    })),
  };
}

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
    if (Math.abs(Math.round(t.price * 100) - t.price * 100) > 1e-6) {
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

// "18:00:00" -> "18:00" (la base renvoie parfois les secondes)
function cleanTime(value) {
  return String(value == null ? '' : value).slice(0, 5);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Vous devez être connecté pour modifier une annonce.' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    if (userError || !userData.user) {
      return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
    }

    const userId = userData.user.id;

    // Le vendeur lié à ce compte connecté
    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id, seller_type')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sellerError || !seller) {
      return res.status(400).json({ error: 'Aucun compte vendeur trouvé pour ce compte.' });
    }

    const listingId = req.method === 'GET' ? req.query.id : (req.body || {}).listingId;
    if (!listingId || typeof listingId !== 'string') {
      return res.status(400).json({ error: 'Annonce manquante.' });
    }

    // L'annonce doit exister et appartenir à ce vendeur
    const { data: existing, error: existingError } = await supabase
      .from('listings')
      .select('id, seller_id, title, description, price, unit, category, subcategory, harvest_date, harvest_at, image_url, quantity_available, pro_attested_at, is_bio, delivery_mode, shipping_tiers')
      .eq('id', listingId)
      .single();

    if (existingError || !existing) {
      return res.status(404).json({ error: 'Annonce introuvable.' });
    }
    if (existing.seller_id !== seller.id) {
      return res.status(403).json({ error: "Vous n'êtes pas autorisé à modifier cette annonce." });
    }

    // ---------- GET : les informations actuelles, pour remplir le formulaire ----------
    if (req.method === 'GET') {
      const { data: hoursRows, error: hoursReadError } = await supabase
        .from('listing_pickup_hours')
        .select('day_of_week, slot, start_time, end_time')
        .eq('listing_id', existing.id);

      if (hoursReadError) throw hoursReadError;

      const pickupHours = (hoursRows || []).map((h) => ({
        day_of_week: h.day_of_week,
        slot: h.slot,
        start_time: cleanTime(h.start_time),
        end_time: cleanTime(h.end_time),
      }));

      return res.status(200).json({
        sellerType: seller.seller_type,
        listing: existing,
        pickupHours,
      });
    }

    // ---------- POST « delete » : supprimer l'annonce (remplace l'ancienne fonction delete-listing) ----------
    if ((req.body || {}).action === 'delete') {
      const { error: deleteError } = await supabase
        .from('listings')
        .delete()
        .eq('id', existing.id)
        .eq('seller_id', seller.id);

      if (deleteError) throw deleteError;

      return res.status(200).json({ success: true });
    }

    // ---------- POST : enregistrer les modifications ----------
    const { title, description, price, unit, category, subcategory, harvestDate, harvestAt, imageUrl, pickupHours, quantity, proAttest, isBio, deliveryMode, shippingTiers } = req.body;
    const isPro = seller.seller_type === 'professionnel';

    // Titre et description : mêmes limites que sur la page « Publier une annonce »
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (!cleanTitle) {
      return res.status(400).json({ error: "Indiquez le titre de l'annonce." });
    }
    if (cleanTitle.length > MAX_TITLE) {
      return res.status(400).json({ error: 'Le titre est trop long (' + MAX_TITLE + ' lettres au maximum).' });
    }
    const cleanDescription = typeof description === 'string' ? description : '';
    if (cleanDescription.length > MAX_DESCRIPTION) {
      return res.status(400).json({ error: 'La description est trop longue (' + MAX_DESCRIPTION + ' caractères au maximum).' });
    }

    // Prix et unité
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > MAX_PRICE) {
      return res.status(400).json({ error: 'Indiquez un prix valide, supérieur à 0 €.' });
    }
    if (Math.abs(Math.round(price * 100) - price * 100) > 1e-6) {
      return res.status(400).json({ error: 'Le prix ne peut pas avoir plus de deux chiffres après la virgule.' });
    }
    const cleanUnit = typeof unit === 'string' ? unit.trim() : '';
    if (!cleanUnit || cleanUnit.length > 60) {
      return res.status(400).json({ error: "Indiquez l'unité de vente (60 caractères au maximum)." });
    }

    // Catégorie : mêmes règles qu'à la publication
    if (typeof category !== 'string' || !category) {
      return res.status(400).json({ error: 'Choisissez une catégorie.' });
    }
    if (!isPro && !PARTICULIER_CATEGORIES.includes(category)) {
      return res.status(403).json({
        error: 'Cette catégorie est réservée aux vendeurs professionnels. En tant que particulier, vous pouvez vendre des fruits, des légumes, des aromates et des fleurs du jardin.',
      });
    }
    const cleanSubcategory = typeof subcategory === 'string' && subcategory ? subcategory : null;

    // Un professionnel qui vend une catégorie réservée aux professionnels doit avoir confirmé son activité
    const proOnlyCategory = isPro && !PARTICULIER_CATEGORIES.includes(category);
    let proAttestedAt = null;
    if (proOnlyCategory) {
      if (existing.pro_attested_at) {
        proAttestedAt = existing.pro_attested_at;
      } else if (proAttest === true) {
        proAttestedAt = new Date().toISOString();
      } else {
        return res.status(400).json({
          error: "Pour enregistrer cette annonce, cochez la case de confirmation : vous avez déclaré votre activité aux autorités compétentes et vous respectez l'étiquetage obligatoire de vos produits.",
        });
      }
    }

    // « Bio » : réservé aux professionnels
    let bio = false;
    if (isBio === true) {
      if (!isPro) {
        return res.status(400).json({ error: 'La mention « Bio » est réservée aux vendeurs professionnels.' });
      }
      bio = true;
    }

    // Date et heure de récolte
    let harvestMoment = null;
    if (harvestAt != null && harvestAt !== '') {
      const parsed = new Date(harvestAt);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "La date et l'heure de récolte ne sont pas valides." });
      }
      if (parsed.getTime() > Date.now() + 5 * 60 * 1000) {
        return res.status(400).json({ error: 'La récolte ne peut pas être dans le futur.' });
      }
      harvestMoment = parsed.toISOString();
    }

    // Mode de remise : l'expédition est réservée aux professionnels qui vendent une catégorie réservée aux professionnels
    const mode = deliveryMode == null ? 'retrait' : deliveryMode;
    if (!DELIVERY_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Mode de remise invalide : choisissez retrait, expédition ou les deux.' });
    }
    if (mode !== 'retrait' && !proOnlyCategory) {
      return res.status(403).json({ error: "L'expédition n'est pas possible pour cette catégorie de produits : seul le retrait est proposé." });
    }

    // Quantité disponible
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return res.status(400).json({ error: 'Indiquez la quantité disponible : un nombre entier entre 1 et ' + MAX_QUANTITY + '.' });
    }

    // Horaires de retrait (obligatoires si le retrait est proposé) et frais d'expédition (obligatoires si l'expédition est proposée)
    let hours = { rows: [] };
    if (mode !== 'expedition') {
      hours = validatePickupHours(pickupHours);
      if (hours.error) {
        return res.status(400).json({ error: hours.error });
      }
    }
    let shipping = { tiers: null };
    if (mode !== 'retrait') {
      shipping = validateShippingTiers(shippingTiers);
      if (shipping.error) {
        return res.status(400).json({ error: shipping.error });
      }
    }

    // Ce qui change dans l'annonce
    const changes = {
      title: cleanTitle,
      description: cleanDescription,
      price,
      unit: cleanUnit,
      category,
      subcategory: cleanSubcategory,
      harvest_date: harvestDate || (harvestMoment ? harvestMoment.slice(0, 10) : null),
      harvest_at: harvestMoment,
      quantity_available: quantity,
      pro_attested_at: proAttestedAt,
      is_bio: bio,
      delivery_mode: mode,
      shipping_tiers: shipping.tiers,
      multi_parcel: mode !== 'retrait',
    };

    // Une nouvelle photo n'est enregistrée que si le vendeur en a choisi une ; sinon l'ancienne reste
    if (typeof imageUrl === 'string' && imageUrl) {
      changes.image_url = imageUrl;
    }

    // Si le prix ou l'unité change, la promotion en cours n'a plus de sens : elle est retirée
    if (Number(existing.price) !== price || (existing.unit || '') !== cleanUnit) {
      changes.promo_percent = null;
      changes.promo_price = null;
      changes.promo_starts_at = null;
      changes.promo_ends_at = null;
      changes.promo_clearance = false;
      changes.lot_quantity = null;
      changes.lot_price = null;
    }

    // Les anciens horaires sont gardés de côté, pour les remettre si l'enregistrement des nouveaux échoue
    const { data: oldHours, error: oldHoursError } = await supabase
      .from('listing_pickup_hours')
      .select('day_of_week, slot, start_time, end_time')
      .eq('listing_id', existing.id);
    if (oldHoursError) throw oldHoursError;

    const { data: updated, error: updateError } = await supabase
      .from('listings')
      .update(changes)
      .eq('id', existing.id)
      .eq('seller_id', seller.id)
      .select()
      .single();

    if (updateError) throw updateError;

    // Remplacer les horaires de retrait
    const { error: deleteHoursError } = await supabase
      .from('listing_pickup_hours')
      .delete()
      .eq('listing_id', existing.id);

    let hoursError = deleteHoursError;
    if (!hoursError && hours.rows.length > 0) {
      ({ error: hoursError } = await supabase
        .from('listing_pickup_hours')
        .insert(hours.rows.map((h) => ({ ...h, listing_id: existing.id }))));
    }

    if (hoursError) {
      console.error('Erreur Supabase (horaires de retrait) :', hoursError);

      // On remet les anciens horaires : il ne doit jamais y avoir une annonce avec retrait sans horaires
      await supabase.from('listing_pickup_hours').delete().eq('listing_id', existing.id);
      if (oldHours && oldHours.length > 0) {
        const { error: restoreError } = await supabase
          .from('listing_pickup_hours')
          .insert(oldHours.map((h) => ({ ...h, listing_id: existing.id })));
        if (restoreError) console.error('Impossible de remettre les anciens horaires :', restoreError);
      }

      return res.status(500).json({
        error: "Vos modifications n'ont pas pu être enregistrées avec les horaires de retrait. Réessayez dans quelques instants.",
      });
    }

    res.status(200).json({ listing: updated, pickupHours: hours.rows });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
