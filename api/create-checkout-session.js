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

    if (!Array.isArray(cart) || cart.length === 0) {
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

    // Le navigateur ne nous donne que l'identifiant des annonces choisies.
    // Le prix, le titre et le vendeur sont relus dans notre base : on ne les croit jamais sur parole.
    const listingIds = [...new Set(cart.map((item) => item && item.listingId).filter(Boolean))];

    if (listingIds.length === 0 || cart.some((item) => !item || !item.listingId)) {
      return res.status(400).json({
        error: "Un article de votre panier n'est pas valide. Retirez-le puis ajoutez-le de nouveau.",
      });
    }

    const { data: listings, error: listingsError } = await supabase
      .from('listings')
      .select('id, title, price, sellers(id, city, latitude, longitude, stripe_account_id)')
      .in('id', listingIds);

    if (listingsError) {
      console.error('Erreur Supabase (lecture des annonces du panier) :', listingsError);
      return res.status(500).json({
        error: 'Impossible de vérifier votre panier pour le moment. Réessayez dans quelques instants.',
      });
    }

    const listingsById = {};
    (listings || []).forEach((listing) => {
      listingsById[String(listing.id)] = listing;
    });

    // Une ligne de paiement par article du panier, avec le vrai prix et le vrai vendeur
    const lines = [];
    for (const item of cart) {
      const listing = listingsById[String(item.listingId)];
      const seller = listing ? (Array.isArray(listing.sellers) ? listing.sellers[0] : listing.sellers) : null;
      const label = String(item.name || 'cette annonce').slice(0, 60);

      // Une annonce n'est achetable que si elle existe encore et si son vendeur est complet
      // (compte de paiement + ville reconnue), comme pour son affichage sur le site.
      const sellerIsValid =
        seller &&
        seller.stripe_account_id &&
        seller.city &&
        seller.latitude != null &&
        seller.longitude != null;

      if (!listing || !sellerIsValid) {
        return res.status(400).json({
          error: `L'annonce « ${label} » n'est plus disponible. Retirez-la de votre panier.`,
        });
      }

      const cents = Math.round(Number(listing.price) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        return res.status(400).json({
          error: `Le prix de l'annonce « ${label} » est invalide. Retirez-la de votre panier.`,
        });
      }

      lines.push({ listing, seller, cents });
    }

    // Transformer chaque article en ligne de paiement Stripe
    const lineItems = lines.map(({ listing, cents }) => ({
      price_data: {
        currency: 'eur',
        product_data: {
          name: listing.title || 'Récolte Agrivoisin',
        },
        unit_amount: cents,
      },
      quantity: 1,
    }));

    // Répartition des paiements par vendeur (calculée par le serveur, jamais par le navigateur)
    const transferInfo = lines
      .map(({ seller, cents }) => `${seller.stripe_account_id}:${cents}`)
      .join(',');

    // Détail des articles pour créer order_items après paiement
    const itemsInfo = lines
      .map(({ listing, seller, cents }) => `${listing.id}:${seller.id}:${cents}`)
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
