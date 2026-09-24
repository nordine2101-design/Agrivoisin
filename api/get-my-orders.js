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
      .select('id, order_id, seller_id, listing_id, listings(title, image_url), sellers(email)')
      .in('order_id', orderIds);

    if (itemsError) throw itemsError;

    const { data: reviews, error: reviewsError } = await supabase
      .from('reviews')
      .select('order_id, seller_id, rating, comment')
      .eq('buyer_id', buyerId)
      .in('order_id', orderIds);

    if (reviewsError) throw reviewsError;

    const result = orders.map((order) => {
      const orderItems = items.filter((it) => it.order_id === order.id);

      const sellersMap = {};
      orderItems.forEach((it) => {
        if (!sellersMap[it.seller_id]) {
          sellersMap[it.seller_id] = {
            sellerId: it.seller_id,
            sellerEmail: it.sellers ? it.sellers.email : 'Vendeur',
            products: [],
          };
        }
        sellersMap[it.seller_id].products.push(it.listings ? it.listings.title : 'Produit');
      });

      const sellersList = Object.values(sellersMap).map((s) => {
        const existingReview = reviews.find((r) => r.order_id === order.id && r.seller_id === s.sellerId);
        return { ...s, review: existingReview || null };
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
