import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// Nombre maximum de ventes renvoyées (les plus récentes)
const MAX_SALES = 100;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Non authentifié' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    if (userError || !userData.user) {
      return res.status(401).json({ error: 'Session invalide' });
    }

    const userId = userData.user.id;

    // Retrouver le vendeur lié à ce compte connecté
    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sellerError || !seller) {
      return res.status(400).json({ error: "Aucun compte vendeur trouvé pour ce compte. Devenez d'abord vendeur." });
    }

    // Les articles vendus par CE vendeur (jamais l'identité de l'acheteur)
    const { data: items, error: itemsError } = await supabase
      .from('order_items')
      .select('order_id, listing_id, price_at_purchase, listings(title)')
      .eq('seller_id', seller.id);

    if (itemsError) throw itemsError;

    const orderIds = [...new Set((items || []).map((it) => it.order_id).filter(Boolean))];

    if (orderIds.length === 0) {
      return res.status(200).json({ sales: [] });
    }

    // Les ventes les plus récentes d'abord (seulement la date : rien sur l'acheteur)
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id, created_at')
      .in('id', orderIds)
      .order('created_at', { ascending: false })
      .limit(MAX_SALES);

    if (ordersError) throw ordersError;

    const shownOrderIds = orders.map((o) => o.id);

    // État de l'argent pour CE vendeur : retenu, en cours de versement, versé ou suspendu
    let payouts = [];
    const { data: payoutsData, error: payoutsError } = await supabase
      .from('payouts')
      .select('order_id, status, auto_release_at, released_at')
      .eq('seller_id', seller.id)
      .in('order_id', shownOrderIds);

    if (payoutsError) {
      // Pas bloquant : la page s'affiche, sans l'état de l'argent
      console.error('Erreur Supabase (versements) :', payoutsError);
    } else {
      payouts = payoutsData || [];
    }

    const sales = orders.map((order) => {
      const orderItems = items.filter((it) => it.order_id === order.id);

      // Les articles regroupés par annonce, avec la quantité vendue
      const byListing = {};
      let totalCents = 0;
      orderItems.forEach((it) => {
        const key = it.listing_id || 'annonce-supprimee';
        if (!byListing[key]) {
          byListing[key] = {
            title: it.listings ? it.listings.title : 'Annonce supprimée',
            quantity: 0,
          };
        }
        byListing[key].quantity += 1;
        totalCents += Math.round(Number(it.price_at_purchase || 0) * 100);
      });

      const payoutRow = payouts.find((p) => p.order_id === order.id);

      return {
        createdAt: order.created_at,
        items: Object.values(byListing),
        totalAmount: totalCents / 100,
        payout: payoutRow
          ? { status: payoutRow.status, autoReleaseAt: payoutRow.auto_release_at, releasedAt: payoutRow.released_at }
          : null,
      };
    });

    res.status(200).json({ sales });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
