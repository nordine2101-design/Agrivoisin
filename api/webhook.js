import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// --- Réglages de l'argent retenu ---
const COMMISSION_RATE = 0.15; // commission d'Agrivoisin : 15 % du prix, par vendeur et par commande
const AUTO_RELEASE_DAYS = 3;  // délai avant le versement automatique au vendeur

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

// Retrouve les articles d'un paiement : [{ listing_id, seller_id, cents }]
async function loadLines(session) {
  const cartId = session.metadata?.cart_id;

  if (cartId) {
    const { data, error } = await supabase
      .from('checkout_carts')
      .select('lines')
      .eq('id', cartId)
      .single();

    if (error || !data) {
      throw new Error('Panier introuvable (' + cartId + ') : ' + (error ? error.message : 'aucune ligne'));
    }
    return Array.isArray(data.lines) ? data.lines : [];
  }

  // Anciens paiements (faits avant ce changement) : le détail était dans le message de Stripe
  const itemsRaw = session.metadata?.items || '';
  return itemsRaw.split(',').filter(Boolean).map((entry) => {
    const [listing_id, seller_id, amount] = entry.split(':');
    return { listing_id, seller_id, cents: parseInt(amount, 10) };
  });
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
    try {
      lines = await loadLines(session);
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

    // 2. Anti-doublon : on réserve la commande avec l'identifiant du paiement Stripe.
    //    Si ce paiement a déjà été traité, la base refuse (identifiant déjà présent) et on s'arrête là.
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        buyer_id: buyerId,
        total_amount: session.amount_total / 100,
        service_fee_cents: serviceFeeCents,
        stripe_session_id: session.id,
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
    if (linesTotal + serviceFeeCents !== session.amount_total) {
      console.warn(`Paiement ${session.id} : total des articles (${linesTotal}) et frais de service (${serviceFeeCents}) différents du montant payé (${session.amount_total}).`);
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
    const refundCents = lines.reduce((sum, l, i) => sum + (stock.missing.has(i) ? l.cents : 0), 0);

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

    try {
      // 5. Un versement en attente par vendeur : l'argent reste chez Agrivoisin (seulement pour les articles servis)
      const amountBySeller = {};
      servedLines.forEach((l) => {
        amountBySeller[l.seller_id] = (amountBySeller[l.seller_id] || 0) + l.cents;
      });

      const releaseAt = new Date(Date.now() + AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000).toISOString();

      const payouts = Object.entries(amountBySeller).map(([sellerId, amount]) => ({
        order_id: order.id,
        seller_id: sellerId,
        amount_cents: amount,
        commission_cents: Math.round(amount * COMMISSION_RATE),
        stripe_charge_id: chargeId,
        status: 'en_attente',
        auto_release_at: releaseAt,
      }));

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
