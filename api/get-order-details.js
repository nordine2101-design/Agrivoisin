import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { session_id } = req.query;

    if (!session_id) {
      return res.status(400).json({ error: 'Identifiant de session manquant' });
    }

    // Vérifier auprès de Stripe que ce paiement a bien été payé
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return res.status(403).json({ error: 'Paiement non confirmé' });
    }

    const transfersRaw = session.metadata?.transfers || '';
    const accountIds = transfersRaw
      .split(',')
      .filter(Boolean)
      .map((entry) => entry.split(':')[0]);

    let sellersInfo = [];

    if (accountIds.length > 0) {
      const { data: sellers, error } = await supabase
        .from('sellers')
        .select('email, address, city, stripe_account_id')
        .in('stripe_account_id', accountIds);

      if (!error && sellers) {
        sellersInfo = sellers;
      }
    }

    res.status(200).json({
      paid: true,
      amountTotal: session.amount_total,
      sellers: sellersInfo,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
