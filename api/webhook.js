import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

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
    const transfersRaw = session.metadata?.transfers || '';
    const buyerId = session.metadata?.buyer_id || '';
    const itemsRaw = session.metadata?.items || '';

    // 1. Transferts d'argent aux vendeurs (déjà existant)
    if (transfersRaw) {
      const transfers = transfersRaw.split(',').filter(Boolean);

      for (const entry of transfers) {
        const [accountId, amount] = entry.split(':');

        try {
          await stripe.transfers.create({
            amount: parseInt(amount, 10),
            currency: 'eur',
            destination: accountId,
          });
          console.log(`Transfert de ${amount} centimes envoyé à ${accountId}`);
        } catch (transferError) {
          console.error(`Erreur de transfert vers ${accountId} :`, transferError.message);
        }
      }
    }

    // 2. Enregistrement de la commande dans Supabase
    if (buyerId && itemsRaw) {
      try {
        const { data: order, error: orderError } = await supabase
          .from('orders')
          .insert({
            buyer_id: buyerId,
            total_amount: session.amount_total / 100,
          })
          .select()
          .single();

        if (orderError) {
          console.error('Erreur création commande :', orderError.message);
        } else {
          const items = itemsRaw.split(',').filter(Boolean).map((entry) => {
            const [listingId, sellerId, amount] = entry.split(':');
            return {
              order_id: order.id,
              listing_id: listingId || null,
              seller_id: sellerId || null,
              price_at_purchase: amount ? parseInt(amount, 10) / 100 : 0,
            };
          });

          const { error: itemsError } = await supabase.from('order_items').insert(items);

          if (itemsError) {
            console.error('Erreur création articles de commande :', itemsError.message);
          } else {
            console.log('Commande enregistrée avec succès :', order.id);
          }
        }
      } catch (dbError) {
        console.error('Erreur base de données :', dbError.message);
      }
    } else {
      console.log('Pas d\'acheteur connecté identifié, commande non enregistrée dans Supabase.');
    }
  }

  res.status(200).json({ received: true });
}
