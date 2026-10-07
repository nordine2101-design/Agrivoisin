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

    // Retrouver les vendeurs concernés par ce paiement
    let sellersInfo = [];
    let listingIds = [];
    const cartId = session.metadata?.cart_id;

    if (cartId) {
      // Nouveaux paiements : le détail du panier est rangé dans notre base
      const { data: cart } = await supabase
        .from('checkout_carts')
        .select('lines')
        .eq('id', cartId)
        .single();

      const sellerIds = cart && Array.isArray(cart.lines)
        ? [...new Set(cart.lines.map((line) => line.seller_id).filter(Boolean))]
        : [];

      listingIds = cart && Array.isArray(cart.lines)
        ? [...new Set(cart.lines.map((line) => line.listing_id).filter(Boolean))]
        : [];

      if (sellerIds.length > 0) {
        const { data: sellers, error } = await supabase
          .from('sellers')
          .select('id, email, address, city, stripe_account_id')
          .in('id', sellerIds);

        if (!error && sellers) {
          sellersInfo = sellers;
        }
      }
    } else {
      // Anciens paiements : la liste des vendeurs était dans le message de Stripe
      const transfersRaw = session.metadata?.transfers || '';
      const accountIds = transfersRaw
        .split(',')
        .filter(Boolean)
        .map((entry) => entry.split(':')[0]);

      listingIds = [...new Set(
        (session.metadata?.items || '')
          .split(',')
          .filter(Boolean)
          .map((entry) => entry.split(':')[0])
          .filter(Boolean)
      )];

      if (accountIds.length > 0) {
        const { data: sellers, error } = await supabase
          .from('sellers')
          .select('id, email, address, city, stripe_account_id')
          .in('stripe_account_id', accountIds);

        if (!error && sellers) {
          sellersInfo = sellers;
        }
      }
    }

    // Les articles achetés chez chaque vendeur, avec leurs horaires de retrait
    const itemsBySeller = {};
    if (listingIds.length > 0) {
      const { data: listings, error: listingsError } = await supabase
        .from('listings')
        .select('id, title, seller_id, listing_pickup_hours(day_of_week, slot, start_time, end_time)')
        .in('id', listingIds);

      if (listingsError) {
        // Pas bloquant : l'adresse du vendeur reste affichée même sans les horaires
        console.error('Erreur Supabase (articles du paiement) :', listingsError);
      } else {
        const byId = {};
        (listings || []).forEach((l) => { byId[l.id] = l; });
        listingIds.forEach((id) => {
          const l = byId[id];
          if (!l) return;
          (itemsBySeller[l.seller_id] = itemsBySeller[l.seller_id] || []).push({
            title: l.title,
            pickup_hours: l.listing_pickup_hours || [],
          });
        });
      }
    }

    // Le numéro interne du vendeur ne sert qu'à relier les articles : il n'est pas envoyé à la page
    const sellersOut = sellersInfo.map(({ id, ...seller }) => ({
      ...seller,
      items: itemsBySeller[id] || [],
    }));

    res.status(200).json({
      paid: true,
      amountTotal: session.amount_total,
      sellers: sellersOut,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
