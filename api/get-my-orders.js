import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { findForbiddenText } from '../lib/moderation.js';

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

  // Le texte de l'avis ne doit contenir ni insulte ni propos discriminatoire (racisme, sexisme, homophobie…)
  if (comment) {
    const forbidden = findForbiddenText(comment);
    if (forbidden) {
      console.warn('Avis refusé (' + forbidden + ') : acheteur ' + buyer.id + ', commande ' + orderId);
      return res.status(400).json({
        error: 'Votre avis n\'a pas été publié : il contient des propos injurieux ou discriminatoires (racisme, antisémitisme, islamophobie, sexisme, homophobie, insultes). Reformulez-le en décrivant simplement votre expérience.',
      });
    }
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

// ---------------------------------------------------------------------------
// Suppression du compte (acheteur ou vendeur).
// 1) « delete_check » : on regarde ce qui bloque (commande en cours, annonce en vente, litige…) sans rien supprimer.
// 2) « delete_account » : on vérifie encore une fois, puis on supprime. Ce que la loi oblige à garder (commandes, versements,
//    informations fiscales des vendeurs) reste en base, sans lien avec une personne qui peut encore se connecter.
// Une commande est « en cours » tant que l'argent de son retrait n'est ni versé ni remboursé.
// ---------------------------------------------------------------------------
const OPEN_PAYOUT_STATUSES = ['en_attente', 'en_cours', 'probleme'];

function chunkList(list, size) {
  const parts = [];
  for (let i = 0; i < list.length; i += size) parts.push(list.slice(i, i + size));
  return parts;
}

function isAdminEmail(email) {
  const list = String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return !!email && list.includes(String(email).trim().toLowerCase());
}

function todayInParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

// Une récolte « Bientôt mûr » reste visible jusqu'à 1 jour après sa date prévue
function isComingSoonStillActive(item, today) {
  if (item.availability_status !== 'bientot_mur' || !item.planned_date) return false;
  const [y, m, d] = today.split('-').map(Number);
  const limit = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  return String(item.planned_date).slice(0, 10) >= limit;
}

// Renvoie les raisons qui empêchent la suppression (liste vide = on peut supprimer), et les fiches vendeur du compte
async function accountBlockers(user) {
  if (isAdminEmail(user.email)) return { reasons: ['admin'], sellerIds: [], orderIds: [] };

  const reasons = [];

  const { data: sellers, error: sellersError } = await supabase.from('sellers').select('id').eq('user_id', user.id);
  if (sellersError) throw sellersError;
  const sellerIds = (sellers || []).map((s) => s.id);

  const { data: orders, error: ordersError } = await supabase.from('orders').select('id').eq('buyer_id', user.id);
  if (ordersError) throw ordersError;
  const orderIds = (orders || []).map((o) => o.id);

  // Acheteur : une commande dont l'argent n'est ni versé ni remboursé
  let buyerOpen = false;
  let buyerDispute = false;
  for (const part of chunkList(orderIds, 100)) {
    const { data: rows, error } = await supabase
      .from('payouts')
      .select('status')
      .in('order_id', part)
      .in('status', OPEN_PAYOUT_STATUSES);
    if (error) throw error;
    (rows || []).forEach((row) => {
      if (row.status === 'probleme') buyerDispute = true;
      else buyerOpen = true;
    });
  }

  // Vendeur : des ventes pas terminées, des annonces en vente, des récoltes « Bientôt mûr » à venir
  let sellerOpen = false;
  let sellerDispute = false;
  let listingsOnSale = false;
  let comingSoon = false;
  if (sellerIds.length > 0) {
    const { data: rows, error } = await supabase
      .from('payouts')
      .select('status')
      .in('seller_id', sellerIds)
      .in('status', OPEN_PAYOUT_STATUSES);
    if (error) throw error;
    (rows || []).forEach((row) => {
      if (row.status === 'probleme') sellerDispute = true;
      else sellerOpen = true;
    });

    const { data: listings, error: listingsError } = await supabase
      .from('listings')
      .select('id, availability_status, planned_date')
      .in('seller_id', sellerIds)
      .is('withdrawn_at', null)
      .limit(1000);
    if (listingsError) throw listingsError;
    const today = todayInParis();
    (listings || []).forEach((item) => {
      const status = item.availability_status || 'disponible';
      if (status === 'disponible') listingsOnSale = true;
      else if (isComingSoonStillActive(item, today)) comingSoon = true;
    });
  }

  if (listingsOnSale) reasons.push('seller_listings');
  if (comingSoon) reasons.push('seller_coming');
  if (sellerOpen) reasons.push('seller_sales');
  if (buyerOpen) reasons.push('buyer_order');
  if (buyerDispute) reasons.push('buyer_dispute');
  if (sellerDispute) reasons.push('seller_dispute');

  return { reasons, sellerIds, orderIds };
}

async function checkAccountDeletion(res, user) {
  const { reasons } = await accountBlockers(user);
  return res.status(200).json({ blocked: reasons.length > 0, reasons });
}

// Essaie de tout modifier d'un coup ; si la base refuse un champ, on réessaie champ par champ (un refus n'arrête rien)
async function updateWhatWeCan(table, column, value, fields) {
  const { error } = await supabase.from(table).update(fields).eq(column, value);
  if (!error) return;
  console.error('Suppression de compte : modification de ' + table + ' refusée, essai champ par champ :', error.message);
  for (const key of Object.keys(fields)) {
    const { error: oneError } = await supabase.from(table).update({ [key]: fields[key] }).eq(column, value);
    if (oneError) console.error('Suppression de compte : ' + table + '.' + key + ' non modifié :', oneError.message);
  }
}

async function deleteQuietly(label, run) {
  try {
    const { error } = await run();
    if (error) console.error('Suppression de compte : ' + label + ' non effacé :', error.message);
  } catch (err) {
    console.error('Suppression de compte : ' + label + ' non effacé :', err.message);
  }
}

async function deleteAccount(req, res, user, token) {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ error: 'Confirmation manquante.' });
  }

  const { reasons, sellerIds, orderIds } = await accountBlockers(user);
  if (reasons.length > 0) {
    return res.status(409).json({ blocked: true, reasons });
  }

  const userId = user.id;
  const anonymousEmail = 'compte-supprime-' + userId + '@agrivoisin.invalid';

  // Ce que la personne a fait elle-même et qui ne sert à personne d'autre : favoris, alertes, réservations, paniers en attente
  await deleteQuietly('favoris', () => supabase.from('favorites').delete().eq('user_id', userId));
  await deleteQuietly('alertes', () => supabase.from('listing_alerts').delete().eq('user_id', userId));
  await deleteQuietly('réservations', () => supabase.from('listing_reservations').delete().eq('user_id', userId));
  await deleteQuietly('paniers en attente', () => supabase.from('checkout_carts').delete().eq('buyer_id', userId));

  // Vendeur : les avis reçus disparaissent avec le compte ; il ne reste ni annonce ni boutique visible
  if (sellerIds.length > 0) {
    await deleteQuietly('avis reçus', () => supabase.from('reviews').delete().in('seller_id', sellerIds));
    await deleteQuietly('annonces', () => supabase.from('listings').delete().in('seller_id', sellerIds));
    for (const sellerId of sellerIds) {
      // La fiche vendeur reste (adresse, SIRET, informations fiscales : conservés comme la loi l'impose) mais sans nom ni boutique
      await updateWhatWeCan('sellers', 'id', sellerId, {
        pseudo: 'compte-supprime-' + String(sellerId).slice(0, 8),
        shop_name: null,
        shop_description: null,
        shop_cover_url: null,
        shop_logo_url: null,
        email: anonymousEmail,
        phone: null,
      });
    }
  }

  // Les avis écrits par la personne restent, sans son nom (« Ancien membre ») : son compte devient anonyme
  const { data: writtenReviews } = await supabase.from('reviews').select('order_id').eq('buyer_id', userId).limit(1);
  const mustKeepTrace = orderIds.length > 0 || sellerIds.length > 0 || (writtenReviews && writtenReviews.length > 0);

  // On coupe toutes les connexions en cours de cette personne
  try { await supabase.auth.admin.signOut(token, 'global'); } catch (err) { /* la suite rend la connexion impossible de toute façon */ }

  let removed = false;
  if (!mustKeepTrace) {
    // Aucune commande, aucune fiche vendeur, aucun avis : on efface le compte pour de bon
    const { error: deleteError } = await supabase.auth.admin.deleteUser(userId);
    if (!deleteError) removed = true;
    else console.error('Suppression de compte : effacement complet refusé, on anonymise :', deleteError.message);
  }

  if (!removed) {
    // Le compte reste en base sous un nom anonyme, sans adresse e-mail réelle, sans mot de passe utilisable, et sans possibilité de se connecter
    const randomPassword = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('') + 'Aa1!';
    const { error: anonymiseError } = await supabase.auth.admin.updateUserById(userId, {
      email: anonymousEmail,
      email_confirm: true,
      password: randomPassword,
      user_metadata: {},
      ban_duration: '876000h',
    });
    if (anonymiseError) {
      console.error('Suppression de compte : anonymisation impossible :', anonymiseError.message);
      return res.status(500).json({ error: "Impossible de supprimer le compte pour le moment. Réessayez dans quelques instants." });
    }
  }

  console.log('Suppression de compte : ' + userId + (removed ? ' effacé' : ' anonymisé') + ' le ' + new Date().toISOString());
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
      const action = req.body && typeof req.body.action === 'string' ? req.body.action : '';
      if (action === 'delete_check') return await checkAccountDeletion(res, userData.user);
      if (action === 'delete_account') return await deleteAccount(req, res, userData.user, token);
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
