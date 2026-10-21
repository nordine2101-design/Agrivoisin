import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// --- Réglages de l'argent retenu ---
// Commission d'Agrivoisin, par vendeur et par commande (en pourcentage entier, pour des calculs exacts) :
// 15 % pour un particulier, 17 % pour un professionnel (première année, sans abonnement).
const COMMISSION_PERCENT_PARTICULIER = 15;
const COMMISSION_PERCENT_PROFESSIONNEL = 17;

function commissionPercentFor(sellerType) {
  return sellerType === 'professionnel' ? COMMISSION_PERCENT_PROFESSIONNEL : COMMISSION_PERCENT_PARTICULIER;
}

// Commission en centimes : le même arrondi qu'avant, mais calculé sur des entiers
function commissionCents(amountCents, sellerType) {
  return Math.round((amountCents * commissionPercentFor(sellerType)) / 100);
}

// Forfait d'Agrivoisin sur les frais d'expédition : 0,50 € par commande expédiée et par vendeur (jamais plus que les frais eux-mêmes)
const SHIPPING_FLAT_FEE_CENTS = 50;
const SHIPPED_RELEASE_DAYS = 30; // délai de sécurité avant le versement d'une commande expédiée (le colis doit partir avant)
const AUTO_RELEASE_DAYS = 3;  // délai avant le versement automatique au vendeur (annonces sans horaires de retrait)
const PICKUP_RELEASE_DELAY_MS = 48 * 60 * 60 * 1000; // avec horaires : libération 48 h après la fin du créneau de retrait

// ---------------------------------------------------------------------------
// Les créneaux de retrait : heure de Paris (avec l'heure d'été), jours 1 = lundi … 7 = dimanche
// ---------------------------------------------------------------------------
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const parisFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Paris', hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// Ce que dit l'horloge de Paris à un instant donné
function parisParts(ms) {
  const p = {};
  parisFormatter.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, weekday: WEEKDAYS[p.weekday] };
}

// « 18 h à Paris ce jour-là » -> l'instant exact (en tenant compte de l'heure d'été ou d'hiver)
function parisToUtcMs(y, m, d, hh, mm) {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = parisParts(guess);
    guess += target - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  }
  return guess;
}

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  return match ? { h: +match[1], m: +match[2] } : null;
}

// Le premier créneau qui n'est pas encore terminé à l'instant donné (celui en cours compte) : { startMs, endMs } ou null
function firstSlotAfter(slots, afterMs) {
  const base = parisParts(afterMs);
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(Date.UTC(base.y, base.m - 1, base.d + offset));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const weekday = ((base.weekday - 1 + offset) % 7) + 1;

    let best = null;
    (slots || []).forEach((s) => {
      if (Number(s.day_of_week) !== weekday) return;
      const st = parseTime(s.start_time);
      const en = parseTime(s.end_time);
      if (!st || !en) return;
      const startMs = parisToUtcMs(y, m, d, st.h, st.m);
      const endMs = parisToUtcMs(y, m, d, en.h, en.m);
      if (!(endMs > startMs) || endMs <= afterMs) return;
      if (!best || endMs < best.endMs) best = { startMs, endMs };
    });
    // Les jours suivants finissent forcément plus tard : on s'arrête au premier jour qui a un créneau
    if (best) return best;
  }
  return null;
}

// Pour un vendeur : le début du premier créneau (pour signaler un problème) et la date de libération
// automatique (48 h après la fin du créneau le plus tardif). null si aucun article n'a d'horaires.
function computePickupWindow(listingIds, slotsByListing, purchaseMs) {
  let startMs = null;
  let endMs = null;
  listingIds.forEach((id) => {
    const first = firstSlotAfter(slotsByListing[id] || [], purchaseMs);
    if (!first) return;
    startMs = startMs === null ? first.startMs : Math.min(startMs, first.startMs);
    endMs = endMs === null ? first.endMs : Math.max(endMs, first.endMs);
  });
  if (startMs === null) return null;
  return { start: new Date(startMs), release: new Date(endMs + PICKUP_RELEASE_DELAY_MS) };
}

export const config = {
  api: {
    bodyParser: false,
  },
};

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

// Les frais de service payés par l'acheteur (0,25 € par commande), annoncés par le paiement.
// Valeur prudente : un entier de 0 à 100 centimes, sinon 0.
function readServiceFee(session) {
  const raw = session.metadata?.service_fee_cents;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : 0;
}

// Les frais d'expédition rangés avec le panier : { identifiant de l'annonce : centimes }.
// Une annonce présente dans cette liste est expédiée (même à 0 centime) ; les autres sont en retrait.
function readShippingFees(shipping) {
  const fees = {};
  const raw = shipping && typeof shipping === 'object' ? shipping.fees : null;
  if (raw && typeof raw === 'object') {
    Object.entries(raw).forEach(([listingId, cents]) => {
      if (Number.isInteger(cents) && cents >= 0 && cents <= 50000) {
        fees[listingId] = cents;
      }
    });
  }
  return fees;
}

// Retrouve les articles d'un paiement : { lines: [{ listing_id, seller_id, cents }], shipping } (shipping : adresse et frais, ou null)
async function loadLines(session) {
  const cartId = session.metadata?.cart_id;

  if (cartId) {
    const { data, error } = await supabase
      .from('checkout_carts')
      .select('lines, shipping')
      .eq('id', cartId)
      .single();

    if (error || !data) {
      throw new Error('Panier introuvable (' + cartId + ') : ' + (error ? error.message : 'aucune ligne'));
    }
    return { lines: Array.isArray(data.lines) ? data.lines : [], shipping: data.shipping || null };
  }

  // Anciens paiements (faits avant ce changement) : le détail était dans le message de Stripe
  const itemsRaw = session.metadata?.items || '';
  const oldLines = itemsRaw.split(',').filter(Boolean).map((entry) => {
    const [listing_id, seller_id, amount] = entry.split(':');
    return { listing_id, seller_id, cents: parseInt(amount, 10) };
  });
  return { lines: oldLines, shipping: null };
}

// Retire une commande qui n'a pas pu être enregistrée en entier, et remet en stock ce qui avait été pris.
// (ses versements et ses articles partent avec elle)
async function rollbackOrder(orderId, taken) {
  await giveBackStock(taken);
  const { error: rollbackError } = await supabase.from('orders').delete().eq('id', orderId);
  if (rollbackError) {
    console.error('Impossible de retirer la commande incomplète :', rollbackError.message);
  }
}

// Remet en stock les unités prises : [{ listing_id, qty }]
async function giveBackStock(taken) {
  for (const t of taken) {
    const { error } = await supabase.rpc('give_back_listing_stock', { p_listing_id: t.listing_id, p_quantity: t.qty });
    if (error) {
      console.error('Impossible de remettre le stock de ' + t.listing_id + ' :', error.message);
    }
  }
}

// Prend du stock pour chaque annonce du panier. La base le fait d'un seul geste indivisible :
// même si deux acheteurs paient en même temps, personne ne prend une unité qui n'existe plus.
// Renvoie { taken, missing } : ce qui a été pris, et les numéros des articles qu'on ne peut pas servir.
async function takeStock(lines) {
  const indexesByListing = {};
  lines.forEach((l, i) => {
    (indexesByListing[l.listing_id] = indexesByListing[l.listing_id] || []).push(i);
  });

  const taken = [];
  const missing = new Set();

  try {
    for (const [listingId, indexes] of Object.entries(indexesByListing)) {
      const { data, error } = await supabase.rpc('take_listing_stock', {
        p_listing_id: listingId,
        p_quantity: indexes.length,
      });
      if (error) {
        throw new Error('stock : ' + error.message);
      }

      const got = Math.max(0, Math.min(Number(data) || 0, indexes.length));
      if (got > 0) {
        taken.push({ listing_id: listingId, qty: got });
      }
      // Les dernières unités de cette annonce, dans l'ordre du panier, ne sont pas servies
      indexes.slice(got).forEach((i) => missing.add(i));
    }
  } catch (err) {
    await giveBackStock(taken);
    throw err;
  }

  return { taken, missing };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Méthode non autorisée');
  }

  let event;

  try {
    const rawBody = await buffer(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Erreur de vérification du webhook :', err.message);
    return res.status(400).send(`Erreur webhook : ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const buyerId = session.metadata?.buyer_id || '';

    if (!buyerId) {
      console.error(`Paiement ${session.id} sans acheteur identifié : commande non enregistrée.`);
      return res.status(200).json({ received: true });
    }

    // 1. Retrouver les articles de ce paiement
    let lines;
    let shipping = null;
    try {
      ({ lines, shipping } = await loadLines(session));
    } catch (err) {
      console.error('Erreur lecture du panier :', err.message);
      // Stripe réessaiera plus tard
      return res.status(500).json({ error: 'Panier illisible, nouvel essai attendu.' });
    }

    const linesAreValid =
      lines.length > 0 &&
      lines.every((l) => l && l.listing_id && l.seller_id && Number.isInteger(l.cents) && l.cents > 0);

    if (!linesAreValid) {
      console.error(`Paiement ${session.id} : articles absents ou invalides, rien à enregistrer.`);
      return res.status(200).json({ received: true });
    }

    const serviceFeeCents = readServiceFee(session);

    // Les frais d'expédition (par annonce expédiée) et l'adresse de livraison de l'acheteur
    const shippingFees = readShippingFees(shipping);
    const hasShipping = Object.keys(shippingFees).length > 0;
    const shippingTotalCents = Object.values(shippingFees).reduce((sum, c) => sum + c, 0);

    // 2. Anti-doublon : on réserve la commande avec l'identifiant du paiement Stripe.
    //    Si ce paiement a déjà été traité, la base refuse (identifiant déjà présent) et on s'arrête là.
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        buyer_id: buyerId,
        total_amount: session.amount_total / 100,
        service_fee_cents: serviceFeeCents,
        stripe_session_id: session.id,
        shipping_address: hasShipping && shipping.address && typeof shipping.address === 'object' ? shipping.address : null,
      })
      .select()
      .single();

    if (orderError) {
      if (orderError.code === '23505') {
        console.log(`Paiement ${session.id} déjà traité, message ignoré.`);
        return res.status(200).json({ received: true, duplicate: true });
      }
      console.error('Erreur création commande :', orderError.message);
      return res.status(500).json({ error: 'Commande non enregistrée, nouvel essai attendu.' });
    }

    // Petite vérification de cohérence (informative)
    const linesTotal = lines.reduce((sum, l) => sum + l.cents, 0);
    if (linesTotal + serviceFeeCents + shippingTotalCents !== session.amount_total) {
      console.warn(`Paiement ${session.id} : total des articles (${linesTotal}), frais de service (${serviceFeeCents}) et frais d'expédition (${shippingTotalCents}) différents du montant payé (${session.amount_total}).`);
    }

    // 3. Le stock : on prend les unités achetées (jamais plus que ce qui reste)
    let stock;
    try {
      stock = await takeStock(lines);
    } catch (err) {
      console.error('Erreur stock :', err.message);
      const { error: removeError } = await supabase.from('orders').delete().eq('id', order.id);
      if (removeError) {
        console.error('Impossible de retirer la commande incomplète :', removeError.message);
      }
      return res.status(500).json({ error: 'Commande non enregistrée, nouvel essai attendu.' });
    }

    // Les articles réellement servis, et ce qu'il faudra rembourser pour les autres
    const servedLines = lines.filter((_, i) => !stock.missing.has(i));
    // Une annonce expédiée dont plus aucune unité n'est servie : ses frais d'expédition sont remboursés aussi
    const servedListingIds = new Set(servedLines.map((l) => String(l.listing_id)));
    const servedShippingFees = {};
    let unservedShippingCents = 0;
    Object.entries(shippingFees).forEach(([listingId, cents]) => {
      if (servedListingIds.has(String(listingId))) {
        servedShippingFees[listingId] = cents;
      } else {
        unservedShippingCents += cents;
      }
    });
    const servedShippingTotal = Object.values(servedShippingFees).reduce((sum, c) => sum + c, 0);
    const refundCents = lines.reduce((sum, l, i) => sum + (stock.missing.has(i) ? l.cents : 0), 0) + unservedShippingCents;

    // 4. Retrouver le paiement (charge) chez Stripe : il servira au versement plus tard
    let chargeId = null;
    try {
      if (session.payment_intent) {
        const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
        const latest = paymentIntent.latest_charge;
        chargeId = typeof latest === 'string' ? latest : (latest && latest.id) || null;
      }
    } catch (err) {
      // Pas bloquant : il sera retrouvé au moment du versement
      console.error('Impossible de lire la charge Stripe :', err.message);
    }

    // Les VRAIS frais de Stripe sur ce paiement, connus dès que l'acheteur a payé : chaque vendeur en verra
    // sa part tout de suite (jamais une supposition). Si Stripe ne donne pas le chiffre, on note « inconnu »
    // et le versement le relèvera plus tard. Jamais bloquant.
    const servedTotalCents = servedLines.reduce((sum, l) => sum + l.cents, 0) + servedShippingTotal;
    let totalCardFee = null;
    let chargedTotalCents = null;
    try {
      if (chargeId) {
        const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
        const balanceTransaction = charge && charge.balance_transaction;
        if (balanceTransaction && typeof balanceTransaction === 'object' && Number.isInteger(balanceTransaction.fee)) {
          totalCardFee = balanceTransaction.fee;
          // Même base de calcul que le versement : le montant TOTAL payé (articles + frais de service)
          chargedTotalCents = Math.max(Number(charge.amount) || 0, servedTotalCents);
        }
      }
    } catch (err) {
      console.error('Impossible de lire les frais Stripe (relevés plus tard, au versement) :', err.message);
    }

    // Les horaires de retrait des articles servis : ils fixent le début du signalement possible et la date de
    // libération automatique. Jamais bloquant : si la lecture échoue, la règle de 3 jours s'applique.
    const slotsByListing = {};
    try {
      // Seules les annonces retirées chez le vendeur ont des horaires qui comptent
      const pickupListingIds = [...new Set(servedLines.map((l) => l.listing_id).filter((id) => !(String(id) in shippingFees)))];
      const { data: slotRows, error: slotsError } = pickupListingIds.length === 0
        ? { data: [], error: null }
        : await supabase
          .from('listing_pickup_hours')
          .select('listing_id, day_of_week, start_time, end_time')
          .in('listing_id', pickupListingIds);
      if (slotsError) {
        throw new Error(slotsError.message);
      }
      (slotRows || []).forEach((r) => {
        (slotsByListing[r.listing_id] = slotsByListing[r.listing_id] || []).push(r);
      });
    } catch (err) {
      console.error('Impossible de lire les horaires de retrait (règle de 3 jours appliquée) :', err.message);
    }
    const purchaseMs = Number.isInteger(session.created) ? session.created * 1000 : Date.now();

    try {
      // 5. Un versement en attente par vendeur : l'argent reste chez Agrivoisin (seulement pour les articles servis)
      const amountBySeller = {};
      servedLines.forEach((l) => {
        amountBySeller[l.seller_id] = (amountBySeller[l.seller_id] || 0) + l.cents;
      });

      const legacyReleaseAt = new Date(Date.now() + AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // Particulier ou professionnel ? La commission en dépend. Si la lecture échoue, on n'invente rien :
      // la commande est retirée et Stripe réessaiera (le vendeur n'est jamais facturé au mauvais taux).
      const sellerTypes = {};
      if (Object.keys(amountBySeller).length > 0) {
        const { data: sellerRows, error: sellerTypesError } = await supabase
          .from('sellers')
          .select('id, seller_type')
          .in('id', Object.keys(amountBySeller));
        if (sellerTypesError) {
          throw new Error('type de vendeur : ' + sellerTypesError.message);
        }
        (sellerRows || []).forEach((r) => { sellerTypes[r.id] = r.seller_type; });
      }

      const payouts = Object.entries(amountBySeller).map(([sellerId, amount]) => {
        const sellerListingIds = [...new Set(servedLines.filter((l) => l.seller_id === sellerId).map((l) => l.listing_id))];
        const pickupListingIds = sellerListingIds.filter((id) => !(String(id) in shippingFees));
        const shippedListingIds = sellerListingIds.filter((id) => String(id) in shippingFees);
        const pickupWindow = computePickupWindow(pickupListingIds, slotsByListing, purchaseMs);
        // Les frais d'expédition de ce vendeur : ils lui sont reversés, moins le forfait de 0,50 € par commande
        const sellerShippingCents = shippedListingIds.reduce((sum, id) => sum + (servedShippingFees[id] || 0), 0);
        // Une commande expédiée n'est pas libérée à la date d'un retrait : on laisse 30 jours, le temps que le vendeur envoie le colis
        let releaseAt = pickupWindow ? pickupWindow.release.toISOString() : legacyReleaseAt;
        if (shippedListingIds.length > 0) {
          const shippedRelease = new Date(Date.now() + SHIPPED_RELEASE_DAYS * 24 * 60 * 60 * 1000).toISOString();
          releaseAt = releaseAt > shippedRelease ? releaseAt : shippedRelease;
        }
        return {
          order_id: order.id,
          seller_id: sellerId,
          amount_cents: amount,
          shipping_cents: sellerShippingCents,
          // La commission sur les produits, plus le forfait de 0,50 € si le vendeur expédie (plafonné aux frais d'expédition)
          commission_cents: commissionCents(amount, sellerTypes[sellerId]) + (sellerShippingCents > 0 ? Math.min(SHIPPING_FLAT_FEE_CENTS, sellerShippingCents) : 0),
          stripe_fee_cents: totalCardFee !== null && chargedTotalCents > 0 ? Math.floor((totalCardFee * (amount + sellerShippingCents)) / chargedTotalCents) : null,
          stripe_charge_id: chargeId,
          status: 'en_attente',
          // Avec horaires de retrait : libération 48 h après la fin du créneau, signalement possible dès son début.
          // Sans horaires : la règle de 3 jours, et aucune attente avant de signaler.
          auto_release_at: releaseAt,
          pickup_start_at: pickupWindow ? pickupWindow.start.toISOString() : null,
        };
      });

      if (servedLines.length > 0) {
        const { error: payoutsError } = await supabase.from('payouts').insert(payouts);
        if (payoutsError) {
          throw new Error('versements : ' + payoutsError.message);
        }

        // 6. Détail des articles de la commande
        const items = servedLines.map((l) => ({
          order_id: order.id,
          listing_id: l.listing_id,
          seller_id: l.seller_id,
          price_at_purchase: l.cents / 100,
          delivery_mode: String(l.listing_id) in shippingFees ? 'expedition' : 'retrait',
        }));

        const { error: itemsError } = await supabase.from('order_items').insert(items);
        if (itemsError) {
          throw new Error('articles : ' + itemsError.message);
        }

        // Si des articles ne sont pas servis, le total de la commande est ce qui reste après remboursement
        if (refundCents > 0) {
          const { error: totalError } = await supabase
            .from('orders')
            .update({ total_amount: (session.amount_total - refundCents) / 100 })
            .eq('id', order.id);
          if (totalError) {
            throw new Error('total : ' + totalError.message);
          }
        }

        console.log(`Commande ${order.id} enregistrée, ${payouts.length} versement(s) en attente.`);
      }
    } catch (failure) {
      console.error('Erreur enregistrement de la commande :', failure.message);

      // On retire la commande réservée (ses versements partent avec elle) et on remet le stock,
      // pour que le prochain essai de Stripe puisse la refaire proprement
      await rollbackOrder(order.id, stock.taken);

      return res.status(500).json({ error: 'Commande non enregistrée, nouvel essai attendu.' });
    }

    // 7. Le remboursement des articles qui n'étaient plus en stock vient EN DERNIER :
    //    tout le reste est déjà enregistré. La clé empêche de rembourser deux fois si Stripe réessaie.
    if (refundCents > 0) {
      // Plus rien à livrer : les frais de service de l'acheteur sont remboursés avec le reste
      const totalRefundCents = refundCents + (servedLines.length === 0 ? serviceFeeCents : 0);
      try {
        if (!session.payment_intent) {
          throw new Error('paiement Stripe introuvable');
        }
        await stripe.refunds.create(
          {
            payment_intent: session.payment_intent,
            amount: totalRefundCents,
            metadata: { raison: 'stock_epuise', paiement: session.id },
          },
          { idempotencyKey: 'stock-refund-' + session.id }
        );
        console.log(`Paiement ${session.id} : ${totalRefundCents} centimes remboursés (articles plus en stock).`);
      } catch (err) {
        console.error('Remboursement impossible :', err.message);
        await rollbackOrder(order.id, stock.taken);
        return res.status(500).json({ error: 'Commande non enregistrée, nouvel essai attendu.' });
      }

      if (servedLines.length === 0) {
        // Plus rien à livrer : tout a été remboursé, il n'y a pas de commande
        const { error: removeError } = await supabase.from('orders').delete().eq('id', order.id);
        if (removeError) {
          console.error('Impossible de retirer la commande entièrement remboursée :', removeError.message);
        }
        return res.status(200).json({ received: true, refunded: true });
      }
    }
  }

  res.status(200).json({ received: true });
}
