import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const MAX_ITEMS = 50; // nombre maximum d'articles par paiement
const SERVICE_FEE_CENTS = 25;   // frais de service payés par l'acheteur : 0,25 €, une seule fois par commande
const MIN_ORDER_CENTS = 500;    // commande minimum : 5 € d'articles (sans compter les frais de service)

function formatEuros(cents) {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}

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

// Découpe d'une commande en colis pour l'expédition.
// Chaque colis doit tomber dans un palier du vendeur (c'est le prix de ce palier qui est compté pour ce colis).
// Si le vendeur n'accepte pas plusieurs colis, il n'y en a qu'un seul. S'il les accepte, on choisit la découpe la moins chère
// (à prix égal : le moins de colis possible, puis des colis de tailles les plus proches).
// Renvoie { feeCents, parcels: [quantités] } ou null si aucune découpe n'est possible.
// IMPORTANT : le même calcul est fait dans panier.html (pour l'affichage) ; le serveur reste seul juge du prix.
function planParcels(tiers, quantity, allowMulti) {
  const list = (Array.isArray(tiers) ? tiers : [])
    .map((t) => ({ min: Number(t.min), max: Number(t.max), cents: Math.round(Number(t.price) * 100) }))
    .filter((t) => Number.isInteger(t.min) && Number.isInteger(t.max) && t.min >= 1 && t.max >= t.min && Number.isFinite(t.cents) && t.cents >= 0);
  const priceOf = (size) => {
    let best = null;
    list.forEach((t) => {
      if (size >= t.min && size <= t.max && (best === null || t.cents < best)) best = t.cents;
    });
    return best;
  };
  if (!Number.isInteger(quantity) || quantity < 1) return null;

  const single = priceOf(quantity);
  if (!allowMulti) return single === null ? null : { feeCents: single, parcels: [quantity] };
  if (quantity > 500) return single === null ? null : { feeCents: single, parcels: [quantity] };

  const cost = [0];
  const count = [0];
  const prev = [0];
  for (let q = 1; q <= quantity; q++) {
    cost[q] = Infinity;
    count[q] = Infinity;
    prev[q] = 0;
    for (let p = 1; p <= q; p++) {
      const pr = priceOf(p);
      if (pr === null || cost[q - p] === Infinity) continue;
      const c = cost[q - p] + pr;
      const n = count[q - p] + 1;
      if (c < cost[q] || (c === cost[q] && n < count[q])) {
        cost[q] = c;
        count[q] = n;
        prev[q] = p;
      }
    }
  }
  if (cost[quantity] === Infinity) return null;

  // Des colis de tailles les plus proches possible, si cela ne coûte pas plus cher
  const k = count[quantity];
  const base = Math.floor(quantity / k);
  const extra = quantity - base * k;
  const balanced = [];
  for (let i = 0; i < k; i++) balanced.push(base + (i < extra ? 1 : 0));
  const balancedPrices = balanced.map(priceOf);
  if (balancedPrices.every((x) => x !== null) && balancedPrices.reduce((a, b) => a + b, 0) === cost[quantity]) {
    return { feeCents: cost[quantity], parcels: balanced.sort((a, b) => b - a) };
  }

  const parcels = [];
  let rest = quantity;
  while (rest > 0) {
    parcels.push(prev[rest]);
    rest -= prev[rest];
  }
  return { feeCents: cost[quantity], parcels: parcels.sort((a, b) => b - a) };
}

// Texte des colis, avec l'unité : « Colis 1 : 4 pots de 500g · Colis 2 : 4 pots de 500g »
function parcelsText(parcels, unit) {
  return parcels.map((n, i) => `Colis ${i + 1} : ${n} ${unitLabel(unit, n)}`).join(' · ');
}

// L'adresse de livraison de l'acheteur (expédition) : on ne se fie jamais au navigateur, tout est vérifié ici.
// Renvoie { address } (adresse propre) ou { error }.
function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function validateShippingAddress(input) {
  if (!input || typeof input !== 'object') {
    return { error: 'Indiquez votre adresse de livraison pour commander avec expédition.' };
  }
  const name = cleanText(input.name, 100);
  const street = cleanText(input.address, 150);
  const address2 = cleanText(input.address2, 100);
  const postalCode = cleanText(input.postal_code, 10);
  const city = cleanText(input.city, 80);
  const phone = cleanText(input.phone, 30);

  if (name.length < 2) return { error: 'Adresse de livraison : indiquez votre nom et prénom.' };
  if (street.length < 5) return { error: 'Adresse de livraison : indiquez votre adresse.' };
  if (!/^\d{5}$/.test(postalCode)) return { error: 'Adresse de livraison : le code postal doit comporter 5 chiffres.' };
  if (city.length < 2) return { error: 'Adresse de livraison : indiquez votre ville.' };
  const digits = phone.replace(/[\s.\-()]/g, '');
  if (!/^(\+33|0033|0)[1-9]\d{8}$/.test(digits)) {
    return { error: 'Adresse de livraison : indiquez un numéro de téléphone français valide (pour le transporteur).' };
  }

  return { address: { name, address: street, address2, postal_code: postalCode, city, country: 'France', phone } };
}

// Date d'aujourd'hui à Paris, « AAAA-MM-JJ »
function todayInParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

// Le prix à payer aujourd'hui pour une annonce : le prix promotionnel si une promotion
// d'un vendeur professionnel est en cours (début et fin inclus), sinon le prix normal.
function currentPrice(listing, seller) {
  const normal = Number(listing.price);
  if (!seller || seller.seller_type !== 'professionnel') return normal;
  // Un déstockage n'a pas de date de fin : il dure tant qu'il reste du stock
  const clearance = listing.promo_clearance === true;
  if (!listing.promo_starts_at || (!listing.promo_ends_at && !clearance)) return normal;

  const today = todayInParis();
  if (today < listing.promo_starts_at || (listing.promo_ends_at && today > listing.promo_ends_at)) return normal;

  let promo = null;
  if (listing.promo_percent != null) {
    promo = Math.round(normal * (100 - Number(listing.promo_percent))) / 100;
  } else if (listing.promo_price != null) {
    promo = Number(listing.promo_price);
  }
  if (promo == null || !Number.isFinite(promo) || promo <= 0 || promo >= normal) return normal;
  return promo;
}

// Le lot en cours d'une annonce (par exemple 3 kg pour 7 €), ou null.
// Réservé aux vendeurs professionnels, aux mêmes dates qu'une promotion (début et fin inclus).
function activeLot(listing, seller) {
  if (!seller || seller.seller_type !== 'professionnel') return null;
  if (listing.lot_quantity == null || listing.lot_price == null) return null;
  if (!listing.promo_starts_at || !listing.promo_ends_at) return null;

  const today = todayInParis();
  if (today < listing.promo_starts_at || today > listing.promo_ends_at) return null;

  const quantity = Number(listing.lot_quantity);
  const cents = Math.round(Number(listing.lot_price) * 100);
  if (!Number.isInteger(quantity) || quantity < 2 || !Number.isFinite(cents) || cents <= 0) return null;
  if (cents >= Math.round(Number(listing.price) * 100) * quantity) return null;
  return { quantity, cents };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { cart, delivery } = req.body;

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
      .select('id, title, price, unit, quantity_available, delivery_mode, shipping_tiers, multi_parcel, promo_percent, promo_price, promo_starts_at, promo_ends_at, promo_clearance, lot_quantity, lot_price, sellers(id, city, latitude, longitude, stripe_account_id, seller_type)')
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

      // Le prix payé est celui d'aujourd'hui : le prix promotionnel pendant une promotion, sinon le prix normal
      const cents = Math.round(currentPrice(listing, seller) * 100);
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

    // L'expédition : pour chaque annonce, le mode de remise est celui du vendeur (retrait, expédition, ou les deux au choix de
    // l'acheteur). Les frais viennent des paliers de l'annonce, selon la quantité commandée (relue plus haut, jamais crue sur parole).
    const choices = delivery && typeof delivery === 'object' && delivery.choices && typeof delivery.choices === 'object' ? delivery.choices : {};
    const shippingFees = {};
    const shippingParcels = {};
    const shippingLines = [];
    for (const key of Object.keys(requested)) {
      const listing = listingsById[key];
      const mode = listing.delivery_mode === 'expedition' || listing.delivery_mode === 'les_deux' ? listing.delivery_mode : 'retrait';
      const shipped = mode === 'expedition' || (mode === 'les_deux' && choices[key] === 'expedition');
      if (!shipped) continue;

      const quantity = requested[key];
      const title = String(listing.title || 'cette annonce').slice(0, 60);
      // Un ou plusieurs colis, sans limite : la découpe la moins chère est choisie ici, par le serveur
      const plan = planParcels(listing.shipping_tiers, quantity, true);
      if (!plan) {
        return res.status(400).json({
          error: `Les frais d'expédition de « ${title} » ne sont pas disponibles pour ${quantity} ${unitLabel(listing.unit, quantity)}. Modifiez la quantité ou choisissez le retrait.`,
        });
      }
      shippingFees[key] = plan.feeCents;
      shippingParcels[key] = plan.parcels;
      shippingLines.push({ listing, quantity, feeCents: plan.feeCents, parcels: plan.parcels });
    }

    let shippingAddress = null;
    if (shippingLines.length > 0) {
      const checked = validateShippingAddress(delivery && delivery.address);
      if (checked.error) {
        return res.status(400).json({ error: checked.error });
      }
      shippingAddress = checked.address;
    }

    // Les lots : pour chaque annonce, autant de lots complets que possible (3 kg pour 7 €, 6 kg = 2 lots),
    // le reste au prix normal. Le prix du lot est réparti sur ses unités, centime par centime,
    // pour que le total des lignes soit exactement le prix du lot.
    const linesByListing = {};
    lines.forEach((line) => {
      const key = String(line.listing.id);
      (linesByListing[key] = linesByListing[key] || []).push(line);
    });

    const lotsByListing = {};
    Object.keys(linesByListing).forEach((key) => {
      const group = linesByListing[key];
      const lot = activeLot(group[0].listing, group[0].seller);
      if (!lot) return;
      const lotCount = Math.floor(group.length / lot.quantity);
      if (lotCount < 1) return;

      lotsByListing[key] = { quantity: lot.quantity, cents: lot.cents, count: lotCount, unitCents: group[0].cents };

      const base = Math.floor(lot.cents / lot.quantity);
      const extra = lot.cents - base * lot.quantity;
      let index = 0;
      for (let i = 0; i < lotCount; i++) {
        for (let j = 0; j < lot.quantity; j++) {
          group[index].cents = base + (j < extra ? 1 : 0);
          index += 1;
        }
      }
    });

    // Commande minimum : 5 € d'articles, sans compter les frais de service
    const itemsTotalCents = lines.reduce((sum, line) => sum + line.cents, 0);
    if (itemsTotalCents < MIN_ORDER_CENTS) {
      return res.status(400).json({
        error: `Le minimum de commande est de ${formatEuros(MIN_ORDER_CENTS)} d'articles (sans compter les frais de service). ` +
          `Il vous manque ${formatEuros(MIN_ORDER_CENTS - itemsTotalCents)}.`,
      });
    }

    // Une seule ligne de paiement par annonce, avec sa quantité (comme sur un ticket de caisse) :
    // « Tomates, quantité 2 » et non deux fois « Tomates ». Le total payé reste exactement le même.
    const grouped = [];
    const groupedByListing = {};
    lines.forEach(({ listing, cents }) => {
      const key = String(listing.id);
      if (!groupedByListing[key]) {
        groupedByListing[key] = { listing, cents, quantity: 0 };
        grouped.push(groupedByListing[key]);
      }
      groupedByListing[key].quantity += 1;
    });

    const lineItems = [];
    grouped.forEach(({ listing, cents, quantity }) => {
      const unit = String(listing.unit == null ? '' : listing.unit).trim() || 'kg';
      const lot = lotsByListing[String(listing.id)];
      let singleQuantity = quantity;
      let singleCents = cents;

      if (lot) {
        // Une ligne pour les lots : « Tomates, lot de 3 kg », puis le reste au prix normal
        lineItems.push({
          price_data: {
            currency: 'eur',
            product_data: {
              name: `${listing.title || 'Récolte Agrivoisin'} — lot de ${lot.quantity} ${unitLabel(unit, lot.quantity)}`,
              description: `${lot.count} × lot de ${lot.quantity} ${unitLabel(unit, lot.quantity)} = ${lot.count * lot.quantity} ${unitLabel(unit, lot.count * lot.quantity)}`,
            },
            unit_amount: lot.cents,
          },
          quantity: lot.count,
        });
        singleQuantity = quantity - lot.count * lot.quantity;
        singleCents = lot.unitCents;
      }

      if (singleQuantity > 0) {
        lineItems.push({
          price_data: {
            currency: 'eur',
            product_data: {
              name: listing.title || 'Récolte Agrivoisin',
              // Sous le nom, Stripe affiche le détail avec l'unité : « 2 × 1 kg = 2 kg »
              description: `${singleQuantity} × 1 ${unit} = ${singleQuantity} ${unitLabel(unit, singleQuantity)}`,
            },
            unit_amount: singleCents,
          },
          quantity: singleQuantity,
        });
      }
    });

    // Les frais d'expédition : une ligne par annonce expédiée (un frais à 0 € n'a pas de ligne de paiement)
    shippingLines.forEach(({ listing, quantity, feeCents, parcels }) => {
      if (feeCents <= 0) return;
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Expédition — ${listing.title || 'Récolte Agrivoisin'}`.slice(0, 120),
            description: (parcels.length > 1
              ? `Frais d'expédition en ${parcels.length} colis — ${parcelsText(parcels, listing.unit)}`
              : `Frais d'expédition pour ${quantity} ${unitLabel(listing.unit, quantity)}`).slice(0, 450),
          },
          unit_amount: feeCents,
        },
        quantity: 1,
      });
    });

    // Les frais de service de l'acheteur : une seule ligne par commande, même avec plusieurs vendeurs
    lineItems.push({
      price_data: {
        currency: 'eur',
        product_data: {
          name: 'Frais de service Agrivoisin',
          description: 'Une seule fois par commande',
        },
        unit_amount: SERVICE_FEE_CENTS,
      },
      quantity: 1,
    });

    // Le détail du panier est rangé dans notre base (calculé par le serveur, jamais par le navigateur).
    // Stripe ne reçoit que le numéro de ce panier : plus de limite due à la taille du message.
    const cartLines = lines.map(({ listing, seller, cents }) => ({
      listing_id: listing.id,
      seller_id: seller.id,
      cents,
    }));

    const { data: savedCart, error: cartError } = await supabase
      .from('checkout_carts')
      .insert({
        buyer_id: buyerId,
        lines: cartLines,
        shipping: shippingAddress ? { address: shippingAddress, fees: shippingFees, parcels: shippingParcels } : null,
      })
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
          service_fee_cents: String(SERVICE_FEE_CENTS),
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
