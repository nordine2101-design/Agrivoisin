import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { cart } = req.body;

    if (!cart || cart.length === 0) {
      return res.status(400).json({ error: 'Le panier est vide' });
    }

    // Retrouver l'acheteur connecté (si présent)
    let buyerId = '';
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (token) {
      const { data: userData } = await supabase.auth.getUser(token);
      if (userData && userData.user) {
        buyerId = userData.user.id;
      }
    }

    // Transformer chaque article du panier en ligne de paiement Stripe
    const lineItems = cart.map((item) => {
      const priceMatch = item.price.replace(',', '.').match(/[\d.]+/);
      const priceInEuros = priceMatch ? parseFloat(priceMatch[0]) : 0;

      return {
        price_data: {
          currency: 'eur',
          product_data: {
            name: item.name,
          },
          unit_amount: Math.round(priceInEuros * 100),
        },
        quantity: 1,
      };
    });

    // Répartition des paiements par vendeur (déjà existant)
    const transferInfo = cart
      .filter((item) => item.stripeAccountId)
      .map((item) => {
        const priceMatch = item.price.replace(',', '.').match(/[\d.]+/);
        const priceInEuros = priceMatch ? parseFloat(priceMatch[0]) : 0;
        return `${item.stripeAccountId}:${Math.round(priceInEuros * 100)}`;
      })
      .join(',');

    // Retrouver le seller_id (Supabase) correspondant à chaque stripeAccountId
    const stripeAccountIds = [...new Set(cart.map((i) => i.stripeAccountId).filter(Boolean))];
    let sellersByStripeId = {};
    if (stripeAccountIds.length > 0) {
      const { data: sellersData } = await supabase
        .from('sellers')
        .select('id, stripe_account_id')
        .in('stripe_account_id', stripeAccountIds);
      if (sellersData) {
        sellersData.forEach((s) => {
          sellersByStripeId[s.stripe_account_id] = s.id;
        });
      }
    }

    // Détail des articles pour créer order_items après paiement
    const itemsInfo = cart
      .map((item) => {
        const priceMatch = item.price.replace(',', '.').match(/[\d.]+/);
        const priceInEuros = priceMatch ? parseFloat(priceMatch[0]) : 0;
        const sellerId = sellersByStripeId[item.stripeAccountId] || '';
        return `${item.listingId || ''}:${sellerId}:${Math.round(priceInEuros * 100)}`;
      })
      .join(',');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      metadata: {
        transfers: transferInfo,
        buyer_id: buyerId,
        items: itemsInfo,
      },
      success_url: `${req.headers.origin}/paiement-succes.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/panier.html`,
    });

    res.status(200).json({ checkoutUrl: session.url });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
