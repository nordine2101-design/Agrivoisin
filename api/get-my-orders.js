import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

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

    const buyerId = userData.user.id;

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id, total_amount, created_at')
      .eq('buyer_id', buyerId)
      .order('created_at', { ascending: false });

    if (ordersError) throw ordersError;

    const orderIds = orders.map((o) => o.id);

    if (orderIds.length === 0) {
      return res.status(200).json({ orders: [] });
    }

    const { data: items, error: itemsError } = await supabase
      .from('order_items')
      .select('id, order_id, seller_id, listing_id, listings(title, image_url, listing_pickup_hours(day_of_week, slot, start_time, end_time))')
      .in('order_id', orderIds);

    if (itemsError) throw itemsError;

    const sellerIds = [...new Set(items.map((it) => it.seller_id).filter(Boolean))];
    let citiesById = {};
    let addressesById = {};
    if (sellerIds.length > 0) {
      // L'e-mail des vendeurs n'est jamais lu ni envoyé à l'acheteur : pas de contact direct possible
      const { data: sellersData, error: sellersError } = await supabase
        .from('sellers')
        .select('id, city, address')
        .in('id', sellerIds);
      if (sellersError) throw sellersError;
      sellersData.forEach((s) => {
        citiesById[s.id] = s.city;
        addressesById[s.id] = s.address;
      });
    }

    const { data: reviews, error: reviewsError } = await supabase
      .from('reviews')
      .select('order_id, seller_id, rating, comment')
      .eq('buyer_id', buyerId)
      .in('order_id', orderIds);

    if (reviewsError) throw reviewsError;

    // État du versement de chaque vendeur (l'argent est retenu jusqu'à la confirmation de réception)
    let payouts = [];
    const { data: payoutsData, error: payoutsError } = await supabase
      .from('payouts')
      .select('order_id, seller_id, status, auto_release_at, released_at')
      .in('order_id', orderIds);

    if (payoutsError) {
      // Pas bloquant : la page s'affiche, sans les boutons de versement
      console.error('Erreur Supabase (versements) :', payoutsError);
    } else {
      payouts = payoutsData || [];
    }

    const result = orders.map((order) => {
      const orderItems = items.filter((it) => it.order_id === order.id);

      const sellersMap = {};
      orderItems.forEach((it) => {
        if (!sellersMap[it.seller_id]) {
          sellersMap[it.seller_id] = {
            sellerId: it.seller_id,
            sellerCity: citiesById[it.seller_id] || null,
            products: [],
            items: [],
          };
        }
        sellersMap[it.seller_id].products.push(it.listings ? it.listings.title : 'Produit');

        // Les articles avec leurs horaires de retrait (une seule fois par annonce, même achetée plusieurs fois)
        const alreadyListed = sellersMap[it.seller_id].items.some((x) => x.listingId === it.listing_id);
        if (!alreadyListed) {
          sellersMap[it.seller_id].items.push({
            listingId: it.listing_id,
            title: it.listings ? it.listings.title : 'Produit',
            pickup_hours: (it.listings && it.listings.listing_pickup_hours) || [],
          });
        }
      });

      const sellersList = Object.values(sellersMap).map((s) => {
        const existingReview = reviews.find((r) => r.order_id === order.id && r.seller_id === s.sellerId);
        const payoutRow = payouts.find((p) => p.order_id === order.id && p.seller_id === s.sellerId);

        // L'adresse du vendeur n'est donnée que tant que l'acheteur n'a pas confirmé la réception :
        // dès que le paiement est versé (ou suspendu), elle disparaît et n'est plus jamais renvoyée
        const addressStillVisible = payoutRow && payoutRow.status === 'en_attente';

        return {
          ...s,
          sellerAddress: addressStillVisible ? (addressesById[s.sellerId] || null) : null,
          review: existingReview || null,
          // null pour les anciennes commandes (payées avant l'argent retenu)
          payout: payoutRow
            ? { status: payoutRow.status, autoReleaseAt: payoutRow.auto_release_at, releasedAt: payoutRow.released_at }
            : null,
        };
      });

      return {
        orderId: order.id,
        totalAmount: order.total_amount,
        createdAt: order.created_at,
        sellers: sellersList,
      };
    });

    res.status(200).json({ orders: result });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
