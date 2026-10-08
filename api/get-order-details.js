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
          .select('id, city, address')
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
          .select('id, city, address')
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

    // L'adresse du vendeur n'est donnée que tant que l'acheteur n'a pas confirmé la réception
    // (même règle que dans « Mes commandes ») : rouvrir ce lien plus tard ne la redonne pas.
    let orderRow = null;
    let payoutRows = [];
    let ruleAvailable = true; // devient faux si l'état du paiement n'a pas pu être vérifié : par prudence, pas d'adresse

    const { data: orderData, error: orderError } = await supabase
      .from('orders')
      .select('id, created_at')
      .eq('stripe_session_id', session_id)
      .maybeSingle();

    if (orderError) {
      console.error('Erreur Supabase (commande du paiement) :', orderError);
      ruleAvailable = false;
    } else if (orderData) {
      orderRow = orderData;
      const { data: payoutsData, error: payoutsError } = await supabase
        .from('payouts')
        .select('seller_id, status')
        .eq('order_id', orderData.id);

      if (payoutsError) {
        console.error('Erreur Supabase (versements du paiement) :', payoutsError);
        ruleAvailable = false;
      } else {
        payoutRows = payoutsData || [];
      }
    }

    const RECENT_ORDER_MS = 15 * 60 * 1000;
    // Heure du paiement chez Stripe (sert si la commande n'est pas dans notre base)
    const paymentAgeMs = session.created ? Date.now() - session.created * 1000 : 0;

    function addressStillVisible(sellerId) {
      if (!ruleAvailable) return false;
      // Commande pas encore enregistrée : adresse seulement si le paiement vient tout juste d'être fait
      if (!orderRow) return paymentAgeMs < RECENT_ORDER_MS;
      const payout = payoutRows.find((p) => p.seller_id === sellerId);
      if (payout) return payout.status === 'en_attente';
      // Pas encore de versement enregistré : adresse seulement pour une commande toute récente
      return Date.now() - new Date(orderRow.created_at).getTime() < RECENT_ORDER_MS;
    }

    // Seuls la ville, l'adresse (si elle est encore visible) et les articles sont envoyés :
    // ni e-mail, ni compte de paiement, ni numéro interne du vendeur
    const sellersOut = sellersInfo.map((seller) => ({
      city: seller.city || null,
      address: addressStillVisible(seller.id) ? (seller.address || null) : null,
      items: itemsBySeller[seller.id] || [],
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
