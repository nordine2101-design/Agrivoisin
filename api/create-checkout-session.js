import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { cart } = req.body;

    if (!cart || cart.length === 0) {
      return res.status(400).json({ error: 'Le panier est vide' });
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

    // On garde la liste des vendeurs/montants concernés pour la répartition après paiement
    const transferInfo = cart
      .filter((item) => item.stripeAccountId)
      .map((item) => {
        const priceMatch = item.price.replace(',', '.').match(/[\d.]+/);
        const priceInEuros = priceMatch ? parseFloat(priceMatch[0]) : 0;
        return `${item.stripeAccountId}:${Math.round(priceInEuros * 100)}`;
      })
      .join(',');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      metadata: {
        transfers: transferInfo,
      },
      success_url: `${req.headers.origin}/paiement-succes.html`,
      cancel_url: `${req.headers.origin}/panier.html`,
    });

    res.status(200).json({ checkoutUrl: session.url });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
