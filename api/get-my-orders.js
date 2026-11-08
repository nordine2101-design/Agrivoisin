import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// Produits frais : l'annulation d'un retrait coûte 50 % (les autres catégories, réservées aux professionnels, sont remboursées en totalité)
const FRESH_CATEGORIES = ['Fruits', 'Légumes', 'Aromates', 'Fleurs du jardin'];

// ---------------------------------------------------------------------------
// Avis sur un vendeur : l'envoi passe par le serveur.
// Un avis est « lié » (jamais affiché, jamais compté dans la moyenne) quand l'acheteur et le vendeur semblent être la même
// personne ou des proches : même e-mail, même téléphone, même adresse ou même carte bancaire.
// L'acheteur ne le sait pas : pour lui, l'avis est envoyé comme les autres.
// ---------------------------------------------------------------------------
const MAX_REVIEW_COMMENT = 1000;
const MAX_ORDERS_COMPARED = 5; // commandes les plus récentes de chaque personne, comparées pour la carte, le téléphone et l'adresse

// Même adresse e-mail même écrite autrement : majuscules, « +quelquechose », points de Gmail
function normalizeEmail(value) {
  const raw = String(value || '').trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at < 1) return '';
  let local = raw.slice(0, at).split('+')[0];
  let domain = raw.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local && domain ? local + '@' + domain : '';
}

// Téléphone français : « 06 12 34 56 78 », « +33 6 12 34 56 78 » et « 0033612345678 » sont le même numéro
function normalizePhone(value) {
  let digits = String(value || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+33')) digits = '0' + digits.slice(3);
  else if (digits.startsWith('0033')) digits = '0' + digits.slice(4);
  return /^0[1-9]\d{8}$/.test(digits) ? digits : '';
}

// Texte sans accents, sans ponctuation, en minuscules
function normalizeText(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// L'empreinte de la carte utilisée pour une commande : la même carte donne toujours la même empreinte
async function cardFingerprints(orders) {
  const found = new Set();
  await Promise.all((orders || []).filter((o) => o.stripe_session_id).map(async (o) => {
    try {
      const session = await stripe.checkout.sessions.retrieve(o.stripe_session_id, { expand: ['payment_intent.latest_charge'] });
      const paymentIntent = session && session.payment_intent;
      const charge = paymentIntent && typeof paymentIntent === 'object' ? paymentIntent.latest_charge : null;
      const card = charge && typeof charge === 'object' && charge.payment_method_details ? charge.payment_method_details.card : null;
      if (card && card.fingerprint) found.add(card.fingerprint);
    } catch (err) {
      console.error('Avis : carte d\'une commande illisible :', err.message);
    }
  }));
  return found;
}

// Renvoie la raison du lien (« meme_email », « meme_telephone », « meme_adresse », « meme_carte ») ou null
async function reviewLinkReason(buyer, seller) {
  if (seller.user_id && String(seller.user_id) === String(buyer.id)) return 'meme_compte';

  // 1. L'e-mail
  const buyerEmail = normalizeEmail(buyer.email);
  const sellerEmails = new Set();
  if (seller.email) sellerEmails.add(normalizeEmail(seller.email));
  if (seller.user_id) {
    try {
      const { data: sellerUser } = await supabase.auth.admin.getUserById(seller.user_id);
      if (sellerUser && sellerUser.user && sellerUser.user.email) sellerEmails.add(normalizeEmail(sellerUser.user.email));
    } catch (err) {
      console.error('Avis : e-mail du vendeur illisible :', err.message);
    }
  }
  sellerEmails.delete('');
  if (buyerEmail && sellerEmails.has(buyerEmail)) return 'meme_email';

  // 2. Les commandes de l'acheteur, et celles que le vendeur a lui-même passées comme acheteur
  const readOrders = async (userId) => {
    if (!userId) return [];
    const { data, error } = await supabase
      .from('orders')
      .select('id, stripe_session_id, shipping_address, created_at')
      .eq('buyer_id', userId)
      .order('created_at', { ascending: false })
      .limit(MAX_ORDERS_COMPARED);
    if (error) throw new Error('commandes : ' + error.message);
    return data || [];
  };
  const buyerOrders = await readOrders(buyer.id);
  const sellerOrders = await readOrders(seller.user_id);

  const phonesOf = (orders) => new Set(orders.map((o) => normalizePhone(o.shipping_address && o.shipping_address.phone)).filter(Boolean));
  const buyerPhones = phonesOf(buyerOrders);
  for (const phone of phonesOf(sellerOrders)) {
    if (buyerPhones.has(phone)) return 'meme_telephone';
  }

  // 3. L'adresse : celle du vendeur (sa fiche) ou celles de ses propres livraisons, comparées aux livraisons de l'acheteur
  const addressKey = (a) => {
    const street = normalizeText(a && a.address);
    const postal = String((a && a.postal_code) || '').trim();
    return street.length >= 6 ? street + '|' + postal : '';
  };
  const buyerAddresses = buyerOrders.map((o) => o.shipping_address).filter((a) => a && typeof a === 'object' && addressKey(a));
  const sellerAddressText = normalizeText(seller.address);
  const sellerKeys = new Set(sellerOrders.map((o) => addressKey(o.shipping_address)).filter(Boolean));
  for (const a of buyerAddresses) {
    const street = normalizeText(a.address);
    const postal = String(a.postal_code || '').trim();
    if (sellerKeys.has(addressKey(a))) return 'meme_adresse';
    if (sellerAddressText && sellerAddressText.includes(street) && (!postal || sellerAddressText.includes(postal))) return 'meme_adresse';
  }

  // 4. La carte bancaire (seulement si le vendeur a déjà acheté sur Agrivoisin)
  if (sellerOrders.length > 0 && buyerOrders.length > 0) {
    const [buyerCards, sellerCards] = await Promise.all([cardFingerprints(buyerOrders), cardFingerprints(sellerOrders)]);
    for (const fingerprint of buyerCards) {
      if (sellerCards.has(fingerprint)) return 'meme_carte';
    }
  }

  return null;
}

async function submitReview(req, res, buyer) {
  const body = req.body || {};
  const orderId = typeof body.orderId === 'string' || typeof body.orderId === 'number' ? String(body.orderId).trim() : '';
  const sellerId = typeof body.sellerId === 'string' || typeof body.sellerId === 'number' ? String(body.sellerId).trim() : '';
  const rating = Number(body.rating);
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, MAX_REVIEW_COMMENT) : '';

  if (!orderId || !sellerId || orderId.length > 64 || sellerId.length > 64) {
    return res.status(400).json({ error: 'Commande introuvable.' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    return res.status(400).json({ error: 'Merci de choisir une note.' });
  }

  // La commande est bien celle de cette personne, et ce vendeur y figure
  const { data: order, error: orderError } = await supabase.from('orders').select('id, buyer_id').eq('id', orderId).maybeSingle();
  if (orderError) throw orderError;
  if (!order || String(order.buyer_id) !== String(buyer.id)) {
    return res.status(404).json({ error: 'Commande introuvable.' });
  }
  const { data: sold, error: soldError } = await supabase
    .from('order_items')
    .select('id')
    .eq('order_id', order.id)
    .eq('seller_id', sellerId)
    .limit(1);
  if (soldError) throw soldError;
  if (!sold || sold.length === 0) {
    return res.status(404).json({ error: 'Commande introuvable.' });
  }

  // Un avis n'est possible qu'une fois tout réglé : chaque retrait est soit payé au vendeur, soit remboursé, et au moins un a été payé.
  // Jamais pour une commande annulée par l'acheteur, ni tant qu'un problème est examiné.
  // Les anciennes commandes, sans versement enregistré, ne sont pas concernées.
  const { data: payouts, error: payoutsError } = await supabase
    .from('payouts')
    .select('status, buyer_cancelled_at')
    .eq('order_id', order.id)
    .eq('seller_id', sellerId);
  if (payoutsError) throw payoutsError;
  const list = payouts || [];
  const settled = list.every((p) => !p.buyer_cancelled_at && (p.status === 'verse' || p.status === 'rembourse'));
  if (list.length > 0 && (!settled || !list.some((p) => p.status === 'verse'))) {
    return res.status(409).json({ error: 'Vous pourrez donner votre avis une fois la commande retirée et le paiement versé.' });
  }

  // Un seul avis par commande et par vendeur
  const { data: already, error: alreadyError } = await supabase
    .from('reviews')
    .select('order_id')
    .eq('order_id', order.id)
    .eq('seller_id', sellerId)
    .eq('buyer_id', buyer.id)
    .limit(1);
  if (alreadyError) throw alreadyError;
  if (already && already.length > 0) {
    return res.status(409).json({ error: 'Vous avez déjà donné votre avis pour cette commande.' });
  }

  // Avis lié ? En cas de doute technique, l'avis est publié (rien n'est refusé à un acheteur honnête)
  let linkReason = null;
  try {
    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id, user_id, email, address')
      .eq('id', sellerId)
      .maybeSingle();
    if (sellerError) throw sellerError;
    if (seller) linkReason = await reviewLinkReason(buyer, seller);
  } catch (err) {
    console.error('Avis : comparaison impossible :', err.message);
  }
  if (linkReason) {
    console.warn('Avis lié (non publié) : commande ' + order.id + ', vendeur ' + sellerId + ', raison : ' + linkReason);
  }

  const { error: insertError } = await supabase.from('reviews').insert({
    order_id: order.id,
    seller_id: sellerId,
    buyer_id: buyer.id,
    rating,
    comment: comment || null,
    linked: !!linkReason,
  });
  if (insertError) {
    if (insertError.code === '23505') {
      return res.status(409).json({ error: 'Vous avez déjà donné votre avis pour cette commande.' });
    }
    throw insertError;
  }

  // Même réponse dans tous les cas : l'acheteur ne sait pas si l'avis est lié
  return res.status(200).json({ success: true });
}

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

    const buyerId = userData.user.id;

    // Envoi d'un avis sur un vendeur
    if (req.method === 'POST') {
      return await submitReview(req, res, userData.user);
    }

    // Page d'une annonce : l'acheteur qui l'a commandée peut savoir qu'elle a été retirée par le vendeur
    const askedListing = req.query && req.query.withdrawn ? String(req.query.withdrawn).slice(0, 64) : '';
    if (askedListing) {
      const { data: gone } = await supabase
        .from('listings')
        .select('id, title, image_url, withdrawn_at')
        .eq('id', askedListing)
        .maybeSingle();
      if (!gone || !gone.withdrawn_at) {
        return res.status(200).json({ withdrawn: null });
      }
      const { data: mine } = await supabase.from('orders').select('id').eq('buyer_id', buyerId);
      const mineIds = (mine || []).map((o) => o.id);
      if (mineIds.length === 0) return res.status(200).json({ withdrawn: null });
      const { data: bought } = await supabase
        .from('order_items')
        .select('id')
        .eq('listing_id', gone.id)
        .in('order_id', mineIds)
        .limit(1);
      if (!bought || bought.length === 0) return res.status(200).json({ withdrawn: null });
      return res.status(200).json({ withdrawn: { id: gone.id, title: gone.title, image_url: gone.image_url } });
    }

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id, total_amount, created_at, service_fee_cents, shipping_address')
      .eq('buyer_id', buyerId)
      .order('created_at', { ascending: false });

    if (ordersError) throw ordersError;

    const orderIds = orders.map((o) => o.id);

    if (orderIds.length === 0) {
      return res.status(200).json({ orders: [] });
    }

    const { data: items, error: itemsError } = await supabase
      .from('order_items')
      .select('id, order_id, seller_id, listing_id, payout_id, price_at_purchase, delivery_mode, listings(title, unit, image_url, category, listing_pickup_hours(day_of_week, slot, start_time, end_time))')
      .in('order_id', orderIds);

    if (itemsError) throw itemsError;

    const sellerIds = [...new Set(items.map((it) => it.seller_id).filter(Boolean))];
    let citiesById = {};
    let addressesById = {};
    if (sellerIds.length > 0) {
      // L'e-mail des vendeurs n'est jamais lu ni envoyé à l'acheteur : pas de contact direct possible
      const { data: sellersData, error: sellersError } = await supabase
        .from('sellers')
        .select('id, city, address')
        .in('id', sellerIds);
      if (sellersError) throw sellersError;
      sellersData.forEach((s) => {
        citiesById[s.id] = s.city;
        addressesById[s.id] = s.address;
      });
    }

    const { data: reviews, error: reviewsError } = await supabase
      .from('reviews')
      .select('order_id, seller_id, rating, comment')
      .eq('buyer_id', buyerId)
      .in('order_id', orderIds);

    if (reviewsError) throw reviewsError;

    // État du versement de chaque vendeur (l'argent est retenu jusqu'à la confirmation de réception)
    let payouts = [];
    const { data: payoutsData, error: payoutsError } = await supabase
      .from('payouts')
      .select('id, order_id, seller_id, status, auto_release_at, released_at, pickup_start_at, pickup_end_at, pickup_code, picked_up_at, refunded_cents, shipping_cents, shipped_at, tracking_number, reschedule_status, reschedule_requested_at, reschedule_proposed_start_at, reschedule_proposed_end_at, buyer_cancelled_at, amount_cents, original_amount_cents')
      .in('order_id', orderIds);

    if (payoutsError) {
      // Pas bloquant : la page s'affiche, sans les boutons de versement
      console.error('Erreur Supabase (versements) :', payoutsError);
    } else {
      payouts = payoutsData || [];
    }

    const result = orders.map((order) => {
      const orderItems = items.filter((it) => it.order_id === order.id);

      const sellersMap = {};
      orderItems.forEach((it) => {
        if (!sellersMap[it.seller_id]) {
          sellersMap[it.seller_id] = {
            sellerId: it.seller_id,
            sellerCity: citiesById[it.seller_id] || null,
            products: [],
            items: [],
          };
        }
        sellersMap[it.seller_id].products.push(it.listings ? it.listings.title : 'Produit');

        // Les articles avec leurs horaires de retrait (une seule fois par annonce, même achetée plusieurs fois),
        // avec la quantité achetée, son unité et le montant de la ligne
        const cents = Math.round(Number(it.price_at_purchase || 0) * 100);
        const existingItem = sellersMap[it.seller_id].items.find((x) => x.listingId === it.listing_id);
        if (!existingItem) {
          sellersMap[it.seller_id].items.push({
            listingId: it.listing_id,
            title: it.listings ? it.listings.title : 'Produit',
            // L'unité de l'annonce (kg par défaut) ; « unité » si l'annonce a été supprimée depuis l'achat
            unit: it.listings ? (String(it.listings.unit == null ? '' : it.listings.unit).trim() || 'kg') : 'unité',
            quantity: 1,
            amountCents: cents,
            // Vrai si cet article est expédié (pas de retrait chez le vendeur)
            shipped: it.delivery_mode === 'expedition',
            pickup_hours: (it.listings && it.listings.listing_pickup_hours) || [],
          });
        } else {
          existingItem.quantity += 1;
          existingItem.amountCents += cents;
        }
      });

      const sellersList = Object.values(sellersMap).map((s) => {
        const existingReview = reviews.find((r) => r.order_id === order.id && r.seller_id === s.sellerId);
        // Plusieurs versements possibles pour un même vendeur (un par créneau) : celui de l'expédition passe en premier
        const sellerPayouts = payouts.filter((p) => p.order_id === order.id && p.seller_id === s.sellerId);
        // Les retraits avec créneau (un versement par créneau) d'un côté ; l'expédition et les anciennes commandes de l'autre
        const slotPayouts = sellerPayouts
          .filter((p) => p.pickup_end_at)
          .sort((x, y) => new Date(x.pickup_start_at) - new Date(y.pickup_start_at));
        const otherPayouts = sellerPayouts.filter((p) => !p.pickup_end_at);
        const payoutRow = otherPayouts.find((p) => Number(p.shipping_cents) > 0) || otherPayouts[0];

        // Un encadré par créneau : les produits à retirer, et le code (donné seulement à partir du début du créneau)
        const nowMs = Date.now();
        const slots = slotPayouts.map((p) => {
          const started = new Date(p.pickup_start_at).getTime() <= nowMs;
          const byListing = {};
          orderItems.filter((it) => it.payout_id === p.id).forEach((it) => {
            const key = it.listing_id || 'supprimee';
            if (!byListing[key]) {
              byListing[key] = {
                title: it.listings ? it.listings.title : 'Produit',
                unit: it.listings ? (String(it.listings.unit == null ? '' : it.listings.unit).trim() || 'kg') : 'unité',
                quantity: 0,
              };
            }
            byListing[key].quantity += 1;
          });
          return {
            payoutId: p.id,
            status: p.status,
            autoReleaseAt: p.auto_release_at,
            releasedAt: p.released_at,
            pickupStartAt: p.pickup_start_at,
            pickupEndAt: p.pickup_end_at,
            // Le moment où le vendeur a tapé le bon code : la commande est alors « retirée »
            pickedUpAt: p.picked_up_at || null,
            // Demande d'un autre créneau (vendeur absent) : où elle en est, et jusqu'à quand le vendeur peut répondre
            // (24 h après la FIN du premier créneau ; c'est aussi la limite pour que l'acheteur le demande)
            rescheduleStatus: p.reschedule_status || null,
            rescheduleDeadlineAt: p.pickup_end_at ? new Date(new Date(p.pickup_end_at).getTime() + 24 * 60 * 60 * 1000).toISOString() : null,
            rescheduleProposedStartAt: p.reschedule_proposed_start_at || null,
            rescheduleProposedEndAt: p.reschedule_proposed_end_at || null,
            refundedAmount: p.status === 'rembourse' && p.refunded_cents != null ? (Number(p.refunded_cents) || 0) / 100 : null,
            // Le code n'est jamais envoyé avant le début du créneau, ni une fois la commande retirée (ni quand le versement n'est plus en attente)
            code: started && p.status === 'en_attente' && !p.picked_up_at && !p.buyer_cancelled_at ? (p.pickup_code || null) : null,
            // Retrait annulé par l'acheteur : ce qui lui a été remboursé et ce qui est resté au vendeur (en euros)
            buyerCancelled: !!p.buyer_cancelled_at,
            cancelRefundedAmount: p.buyer_cancelled_at && p.refunded_cents != null ? (Number(p.refunded_cents) || 0) / 100 : null,
            cancelKeptAmount: p.buyer_cancelled_at && Number(p.original_amount_cents) > 0 ? (Number(p.amount_cents) || 0) / 100 : 0,
            items: Object.values(byListing),
          };
        });

        // « Annuler » : possible tant qu'aucun retrait de ce vendeur n'a commencé (tout ou rien par vendeur).
        // Gratuit (remboursement total) seulement si aucun des produits n'est un produit frais.
        const toCancel = slotPayouts.filter((p) => !p.buyer_cancelled_at);
        const cancelAllowed = toCancel.length > 0 && toCancel.every((p) => p.status === 'en_attente' && !p.picked_up_at && !p.reschedule_status && new Date(p.pickup_start_at).getTime() > nowMs);
        const cancelFree = cancelAllowed && toCancel.every((p) => !orderItems.filter((it) => it.payout_id === p.id).some((it) => {
          const category = it.listings && it.listings.category;
          return !category || FRESH_CATEGORIES.includes(category);
        }));

        // L'adresse du vendeur n'est donnée que tant que l'acheteur n'a pas confirmé la réception :
        // dès que le paiement est versé (ou suspendu), elle disparaît et n'est plus jamais renvoyée
        const addressStillVisible = payoutRow && payoutRow.status === 'en_attente';

        // Expédition : les frais payés pour ce vendeur, l'état du colis et l'adresse de livraison de l'acheteur
        // (la sienne, donnée seulement tant que l'argent est retenu)
        const shippingCents = payoutRow ? Number(payoutRow.shipping_cents) || 0 : 0;
        const hasPickupItem = s.items.some((x) => !x.shipped);
        const buyerAddress = order.shipping_address && typeof order.shipping_address === 'object' ? order.shipping_address : null;
        const delivery = shippingCents > 0
          ? {
              shippingAmount: shippingCents / 100,
              shippedAt: payoutRow.shipped_at || null,
              trackingNumber: payoutRow.tracking_number || null,
              address: addressStillVisible && buyerAddress
                ? { name: buyerAddress.name || '', address: buyerAddress.address || '', address2: buyerAddress.address2 || '', postalCode: buyerAddress.postal_code || '', city: buyerAddress.city || '', country: buyerAddress.country || 'France', phone: buyerAddress.phone || '' }
                : null,
            }
          : null;

        return {
          ...s,
          items: s.items.map(({ amountCents, ...item }) => ({ ...item, amount: amountCents / 100 })),
          // L'adresse du vendeur ne sert que s'il reste au moins un article à retirer chez lui
          sellerAddress: hasPickupItem && (slotPayouts.length > 0 ? slotPayouts.some((p) => p.status === 'en_attente' && !p.picked_up_at && !p.buyer_cancelled_at) : addressStillVisible) ? (addressesById[s.sellerId] || null) : null,
          slots,
          cancelAllowed,
          cancelFree,
          delivery,
          review: existingReview || null,
          // null pour les anciennes commandes (payées avant l'argent retenu)
          payout: payoutRow
            ? {
                status: payoutRow.status,
                autoReleaseAt: payoutRow.auto_release_at,
                releasedAt: payoutRow.released_at,
                // Le début du créneau de retrait : avant ce moment, l'acheteur ne peut pas signaler de problème (vide = sans attente)
                pickupStartAt: payoutRow.pickup_start_at || null,
                // Le montant remboursé à l'acheteur, en euros (seulement quand la commande a été remboursée)
                refundedAmount: payoutRow.status === 'rembourse' && payoutRow.refunded_cents != null ? (Number(payoutRow.refunded_cents) || 0) / 100 : null,
              }
            : null,
        };
      });

      return {
        orderId: order.id,
        totalAmount: order.total_amount,
        // Les frais de service payés par l'acheteur, une seule fois par commande (0 pour les anciennes commandes)
        serviceFee: (Number(order.service_fee_cents) || 0) / 100,
        createdAt: order.created_at,
        sellers: sellersList,
      };
    });

    res.status(200).json({ orders: result });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
