import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const MAX_ITEMS = 50; // nombre maximum d'articles par paiement

// Une quantité s'écrit toujours avec son unité : « 3 kg », « 1 botte », « 3 bottes », « 2 bocaux »
const INVARIABLE_UNITS = ['kg', 'g', 'mg', 'l', 'cl', 'ml', 'dl', 'm', 'cm', 'mm'];

function pluralWord(word) {
  if (INVARIABLE_UNITS.includes(word.toLowerCase())) return word;
  if (/[sxz]$/i.test(word)) return word;
  if (/al$/i.test(word)) return word.slice(0, -2) + 'aux';
  return word + 's';
}

function unitLabel(unit, count) {
  const u = String(unit == null ? '' : unit).trim() || 'kg';
  if (count <= 1) return u;
  const withDe = u.match(/^([^\s\d]+)(\s+(?:de |du |des |d').*)$/i);
  if (withDe) return pluralWord(withDe[1]) + withDe[2];
  if (/[\s\d]/.test(u)) return u;
  return pluralWord(u);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { cart } = req.body;

    // Le paiement est réservé aux personnes connectées
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Vous devez être connecté pour payer.' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    if (userError || !userData || !userData.user) {
      return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
    }

    const buyerId = userData.user.id;

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Le panier est vide' });
    }

    if (cart.length > MAX_ITEMS) {
      return res.status(400).json({
        error: `Votre panier contient trop d'articles (maximum ${MAX_ITEMS} par paiement). Réglez-en une partie, puis revenez pour le reste.`,
      });
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
      .select('id, title, price, unit, quantity_available, sellers(id, city, latitude, longitude, stripe_account_id)')
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

    // Le stock : jamais plus d'unités achetées qu'il n'en reste (la quantité est relue dans notre base)
    const requested = {};
    cart.forEach((item) => {
      const key = String(item.listingId);
      requested[key] = (requested[key] || 0) + 1;
    });

    const stockProblems = [];
    Object.keys(requested).forEach((key) => {
      const listing = listingsById[key];
      if (!listing || listing.quantity_available == null) return; // annonce sans limite
      const stock = Number(listing.quantity_available);
      const title = String(listing.title || 'cette annonce').slice(0, 60);
      if (stock <= 0) {
        stockProblems.push(`L'annonce « ${title} » est épuisée. Retirez-la de votre panier.`);
      } else if (requested[key] > stock) {
        stockProblems.push(
          `Il ne reste que ${stock} ${unitLabel(listing.unit, stock)} de « ${title} », ` +
          `et votre panier en contient ${requested[key]} ${unitLabel(listing.unit, requested[key])}. Réduisez la quantité.`
        );
      }
    });

    if (stockProblems.length > 0) {
      return res.status(409).json({ error: stockProblems.join(' ') });
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

    // Le détail du panier est rangé dans notre base (calculé par le serveur, jamais par le navigateur).
    // Stripe ne reçoit que le numéro de ce panier : plus de limite due à la taille du message.
    const cartLines = lines.map(({ listing, seller, cents }) => ({
      listing_id: listing.id,
      seller_id: seller.id,
      cents,
    }));

    const { data: savedCart, error: cartError } = await supabase
      .from('checkout_carts')
      .insert({ buyer_id: buyerId, lines: cartLines })
      .select('id')
      .single();

    if (cartError || !savedCart) {
      console.error('Erreur Supabase (enregistrement du panier) :', cartError);
      return res.status(500).json({
        error: "Impossible d'enregistrer votre panier pour le moment. Réessayez dans quelques instants.",
      });
    }

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: lineItems,
        metadata: {
          cart_id: savedCart.id,
          buyer_id: buyerId,
        },
        success_url: `${req.headers.origin}/paiement-succes.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${req.headers.origin}/panier.html`,
      });
    } catch (stripeError) {
      // Le paiement n'a pas pu être créé : on retire le panier rangé pour rien
      await supabase.from('checkout_carts').delete().eq('id', savedCart.id);
      throw stripeError;
    }

    res.status(200).json({ checkoutUrl: session.url });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
