import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// --- Réglages de l'argent retenu ---
const COMMISSION_RATE = 0.10; // commission d'Agrivoisin : 10 % du prix, par vendeur et par commande
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

    // 2. Anti-doublon : on réserve la commande avec l'identifiant du paiement Stripe.
    //    Si ce paiement a déjà été traité, la base refuse (identifiant déjà présent) et on s'arrête là.
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        buyer_id: buyerId,
        total_amount: session.amount_total / 100,
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
    if (linesTotal !== session.amount_total) {
      console.warn(`Paiement ${session.id} : total des articles (${linesTotal}) différent du montant payé (${session.amount_total}).`);
    }

    // 3. Retrouver le paiement (charge) chez Stripe : il servira au versement plus tard
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
      // 4. Un versement en attente par vendeur : l'argent reste chez Agrivoisin
      const amountBySeller = {};
      lines.forEach((l) => {
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

      const { error: payoutsError } = await supabase.from('payouts').insert(payouts);
      if (payoutsError) {
        throw new Error('versements : ' + payoutsError.message);
      }

      // 5. Détail des articles de la commande
      const items = lines.map((l) => ({
        order_id: order.id,
        listing_id: l.listing_id,
        seller_id: l.seller_id,
        price_at_purchase: l.cents / 100,
      }));

      const { error: itemsError } = await supabase.from('order_items').insert(items);
      if (itemsError) {
        throw new Error('articles : ' + itemsError.message);
      }

      console.log(`Commande ${order.id} enregistrée, ${payouts.length} versement(s) en attente.`);
    } catch (failure) {
      console.error('Erreur enregistrement de la commande :', failure.message);

      // On retire la commande réservée (ses versements partent avec elle),
      // pour que le prochain essai de Stripe puisse la refaire proprement
      const { error: rollbackError } = await supabase.from('orders').delete().eq('id', order.id);
      if (rollbackError) {
        console.error('Impossible de retirer la commande incomplète :', rollbackError.message);
      }

      return res.status(500).json({ error: 'Commande non enregistrée, nouvel essai attendu.' });
    }
  }

  res.status(200).json({ received: true });
}
