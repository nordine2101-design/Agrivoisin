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

// « Bientôt mûr » : une récolte pas encore faite, prévue dans 3 jours au maximum après le dépôt de l'annonce.
// On compte les jours à l'heure de Paris : la date prévue va d'aujourd'hui à aujourd'hui + 3 jours.
const MAX_DAYS_AHEAD = 3;

function parisToday() {
  // Date du jour à Paris, au format AAAA-MM-JJ
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

function validatePlannedDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: 'Indiquez la date de mise en vente prévue.' };
  }
  const check = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== value) {
    return { error: "La date de mise en vente prévue n'est pas valide." };
  }
  const today = parisToday();
  const latest = addDays(today, MAX_DAYS_AHEAD);
  if (value < today) {
    return { error: 'La date de mise en vente prévue ne peut pas être dans le passé.' };
  }
  if (value > latest) {
    return { error: 'Une récolte « Bientôt mûr » doit être prévue dans ' + MAX_DAYS_AHEAD + ' jours au maximum après le dépôt de l\'annonce.' };
  }
  return { plannedDate: value };
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
    const { title, description, price, unit, category, subcategory, harvestDate, imageUrl, pickupHours, quantity, proAttest, deliveryMode, shippingTiers, multiParcel, isBio, harvestAt, availabilityStatus, plannedDate } = req.body;

    // 0 bis. Statut de l'annonce : disponible tout de suite (par défaut) ou « Bientôt mûr »
    const status = availabilityStatus == null || availabilityStatus === '' ? 'disponible' : availabilityStatus;
    if (status !== 'disponible' && status !== 'bientot_mur') {
      return res.status(400).json({ error: "Statut d'annonce invalide : choisissez « Disponible maintenant » ou « Bientôt mûr »." });
    }
    const comingSoon = status === 'bientot_mur';

    let planned = null;
    if (comingSoon) {
      const checked = validatePlannedDate(plannedDate);
      if (checked.error) {
        return res.status(400).json({ error: checked.error });
      }
      planned = checked.plannedDate;
    }

    // 0. Date et heure de la récolte (elles servent à calculer la fraîcheur affichée sur l'annonce)
    //    Une récolte « Bientôt mûr » n'est pas encore faite : pas de date de récolte à ce stade
    let harvestMoment = null;
    if (!comingSoon && harvestAt != null && harvestAt !== '') {
      const parsed = new Date(harvestAt);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "La date et l'heure de récolte ne sont pas valides." });
      }
      if (parsed.getTime() > Date.now() + 5 * 60 * 1000) {
        return res.status(400).json({ error: "La récolte ne peut pas être dans le futur." });
      }
      harvestMoment = parsed.toISOString();
    }

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

    // 2 ter. Trop d'annulations de récoltes « Bientôt mûr » : plus de nouvelle récolte « Bientôt mûr » pendant 30 jours
    //        (3e annulation en 90 jours ; les annonces « Disponible maintenant » ne sont pas concernées)
    if (comingSoon) {
      const DAY_MS = 24 * 60 * 60 * 1000;
      const { data: cancelledRows, error: cancelledError } = await supabase
        .from('listings')
        .select('cancelled_at')
        .eq('seller_id', seller.id)
        .not('cancelled_at', 'is', null)
        .gte('cancelled_at', new Date(Date.now() - 90 * DAY_MS).toISOString());
      if (cancelledError) throw cancelledError;
      const times = (cancelledRows || []).map((r) => new Date(r.cancelled_at).getTime()).filter((t) => Number.isFinite(t));
      if (times.length > 2) {
        const until = Math.max.apply(null, times) + 30 * DAY_MS;
        if (until > Date.now()) {
          const untilFr = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris' }).format(new Date(until));
          return res.status(403).json({
            error: 'Vous avez annulé 3 récoltes « Bientôt mûr » en 90 jours : vous ne pouvez plus en publier jusqu\'au ' + untilFr + '. Vos annonces « Disponible maintenant » ne sont pas concernées.',
          });
        }
      }
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

    // 2 quater. La mention « Bio » est réservée aux professionnels (label officiel)
    let bio = false;
    if (isBio === true) {
      if (seller.seller_type !== 'professionnel') {
        return res.status(400).json({ error: 'La mention « Bio » est réservée aux vendeurs professionnels.' });
      }
      bio = true;
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

    // 3 bis. « Bientôt mûr » : seulement des produits frais de la récolte (fruits, légumes, aromates, fleurs du jardin),
    //        et seulement en retrait chez le vendeur, pas d'expédition
    if (comingSoon) {
      if (!PARTICULIER_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'Une annonce « Bientôt mûr » concerne une récolte à venir : fruits, légumes, aromates ou fleurs du jardin.' });
      }
      if (mode !== 'retrait') {
        return res.status(400).json({ error: 'Une annonce « Bientôt mûr » se retire chez le vendeur : pas d\'expédition.' });
      }
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
        harvest_date: comingSoon ? planned : (harvestDate || (harvestMoment ? harvestMoment.slice(0, 10) : harvestDate)),
        harvest_at: harvestMoment,
        availability_status: status,
        planned_date: planned,
        price_locked: false,
        image_url: imageUrl,
        quantity_available: stock.quantity,
        pro_attested_at: proAttestedAt,
        is_bio: bio,
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
