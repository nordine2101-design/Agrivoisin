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

    // 1. Anti-doublon : on réserve la commande avec l'identifiant du paiement Stripe.
    //    Si ce paiement a déjà été traité, la base refuse (identifiant déjà présent) et on s'arrête là.
    //    Stripe peut envoyer le même message plusieurs fois (nouveaux essais, renvois).
    let order = null;
    if (buyerId && itemsRaw) {
      const { data: newOrder, error: orderError } = await supabase
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
        // Stripe réessaiera plus tard : rien n'a encore été versé aux vendeurs
        return res.status(500).json({ error: "Commande non enregistrée, nouvel essai attendu." });
      }

      order = newOrder;
    }

    // 2. Transferts d'argent aux vendeurs
    //    La clé d'idempotence empêche Stripe de verser deux fois pour le même paiement.
    if (transfersRaw) {
      const transfers = transfersRaw.split(',').filter(Boolean);

      for (let index = 0; index < transfers.length; index++) {
        const [accountId, amount] = transfers[index].split(':');

        try {
          await stripe.transfers.create(
            {
              amount: parseInt(amount, 10),
              currency: 'eur',
              destination: accountId,
            },
            { idempotencyKey: `transfer_${session.id}_${index}` }
          );
          console.log(`Transfert de ${amount} centimes envoyé à ${accountId}`);
        } catch (transferError) {
          console.error(`Erreur de transfert vers ${accountId} :`, transferError.message);
        }
      }
    }

    // 3. Détail des articles de la commande
    if (order) {
      try {
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
          throw new Error(itemsError.message);
        }

        console.log('Commande enregistrée avec succès :', order.id);
      } catch (itemsFailure) {
        console.error('Erreur création articles de commande :', itemsFailure.message);

        // On retire la commande réservée, pour que le prochain essai de Stripe puisse la refaire proprement
        const { error: rollbackError } = await supabase.from('orders').delete().eq('id', order.id);
        if (rollbackError) {
          console.error('Impossible de retirer la commande incomplète :', rollbackError.message);
        }

        return res.status(500).json({ error: "Articles non enregistrés, nouvel essai attendu." });
      }
    } else {
      console.log('Pas d\'acheteur connecté identifié, commande non enregistrée dans Supabase.');
    }
  }

  res.status(200).json({ received: true });
}
