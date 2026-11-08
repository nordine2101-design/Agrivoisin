import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// Les vendeurs sont virés à leur banque une seule fois par mois, le 5
const MONTHLY_PAYOUT_DAY = 5;

// Un versement "en cours" depuis plus d'une heure après son échéance est considéré comme bloqué et repris
const STUCK_AFTER_MS = 60 * 60 * 1000;
// Nombre maximum de versements traités à chaque passage automatique
const BATCH_SIZE = 50;
// Temps maximum consacré à un passage automatique (en millisecondes)
const DEFAULT_TIME_BUDGET_MS = 50000;

// « lundi 12 octobre à 18 h » ou « lundi 12 octobre à 18 h 30 » (heure de Paris)
function formatParisMoment(iso) {
  const parts = {};
  new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).forEach((p) => { parts[p.type] = p.value; });
  const minutes = parts.minute === '00' ? '' : ' ' + parts.minute;
  return parts.weekday + ' ' + parts.day + ' ' + parts.month + ' à ' + parseInt(parts.hour, 10) + ' h' + minutes;
}

// ---------------------------------------------------------------------------
// S'assure que le compte de paiement du vendeur est viré à sa banque une seule fois par mois, le 5.
// Les comptes créés avant ce choix reçoivent le réglage au prochain versement.
// Jamais bloquant : si cela échoue, le versement continue normalement (l'argent du vendeur passe avant).
// ---------------------------------------------------------------------------
async function ensureMonthlyPayouts(accountId) {
  try {
    const account = await stripe.accounts.retrieve(accountId);
    const schedule = account && account.settings && account.settings.payouts && account.settings.payouts.schedule;
    if (schedule && schedule.interval === 'monthly' && schedule.monthly_anchor === MONTHLY_PAYOUT_DAY) {
      return;
    }
    await stripe.accounts.update(accountId, {
      settings: {
        payouts: {
          schedule: { interval: 'monthly', monthly_anchor: MONTHLY_PAYOUT_DAY },
        },
      },
    });
    console.log(`Compte ${accountId} : virement mensuel le ${MONTHLY_PAYOUT_DAY} activé.`);
  } catch (err) {
    console.error(`Compte ${accountId} : virement mensuel non appliqué (le versement continue) :`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Verse l'argent d'un versement au vendeur (commission, frais de carte et frais de service mensuels déduits).
// fromStatuses : états dans lesquels le versement peut être pris en charge.
// restoreStatus : l'état dans lequel on le remet si le versement échoue (« en_attente » : il sera retenté ;
// « probleme » : quand c'est l'administrateur qui l'a décidé, il ne doit jamais repartir tout seul).
// Sûr même en cas de double demande : un seul traitement peut réserver le versement.
// ---------------------------------------------------------------------------
async function releasePayout(payoutId, fromStatuses, restoreStatus = 'en_attente') {
  // 1. Réserver le versement (une seule demande à la fois peut réussir)
  const { data: payout, error: claimError } = await supabase
    .from('payouts')
    .update({ status: 'en_cours', last_error: null })
    .eq('id', payoutId)
    .in('status', fromStatuses)
    .select()
    .maybeSingle();

  if (claimError) {
    throw new Error('Réservation du versement impossible : ' + claimError.message);
  }
  if (!payout) {
    return { ok: false, reason: 'not_claimable' };
  }

  try {
    // 2. Le compte de paiement du vendeur
    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id, stripe_account_id')
      .eq('id', payout.seller_id)
      .maybeSingle();

    if (sellerError || !seller || !seller.stripe_account_id) {
      throw new Error('Vendeur sans compte de paiement');
    }

    await ensureMonthlyPayouts(seller.stripe_account_id);

    // 3. Le paiement de l'acheteur chez Stripe (retrouvé si on ne l'avait pas noté)
    let chargeId = payout.stripe_charge_id;
    if (!chargeId) {
      const { data: order } = await supabase
        .from('orders')
        .select('stripe_session_id')
        .eq('id', payout.order_id)
        .maybeSingle();

      if (!order || !order.stripe_session_id) {
        throw new Error('Paiement Stripe introuvable pour cette commande');
      }

      const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
      const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
      const latest = paymentIntent.latest_charge;
      chargeId = typeof latest === 'string' ? latest : (latest && latest.id) || null;

      if (!chargeId) {
        throw new Error('Paiement Stripe introuvable pour cette commande');
      }
    }

    // 4. Les frais Stripe de tout le paiement, répartis entre les vendeurs au prorata de leurs ventes
    const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
    const balanceTransaction = charge.balance_transaction;
    const totalFee = balanceTransaction && typeof balanceTransaction === 'object' ? balanceTransaction.fee : null;

    if (totalFee === null || totalFee === undefined) {
      throw new Error('Frais Stripe indisponibles pour le moment');
    }

    const { data: siblings, error: siblingsError } = await supabase
      .from('payouts')
      .select('amount_cents, shipping_cents')
      .eq('order_id', payout.order_id);

    if (siblingsError || !siblings || siblings.length === 0) {
      throw new Error('Versements de la commande illisibles');
    }

    // Les frais d'expédition (reversés en entier au vendeur, sans commission) font partie de ce que l'acheteur a payé
    const orderTotal = siblings.reduce((sum, p) => sum + p.amount_cents + (Number(p.shipping_cents) || 0), 0);
    const shippingCents = Number(payout.shipping_cents) || 0;
    // Chaque vendeur paie sa part des frais de carte, au prorata du montant TOTAL payé par l'acheteur
    // (articles + frais de service). Agrivoisin garde à sa charge la part des frais de service de l'acheteur
    // et des articles remboursés. Pour une ancienne commande (sans frais de service), le total payé
    // est la somme des articles : le calcul est le même qu'avant.
    const chargedTotal = Math.max(Number(charge.amount) || 0, orderTotal);
    // Arrondi vers le bas : le vendeur ne paie jamais plus que sa part
    // La part des frais de carte du vendeur porte sur ses produits ET sur ses frais d'expédition
    // Retrait annulé par l'acheteur : le vendeur ne garde que la moitié, mais il paie les frais de carte sur la totalité
    // de sa part d'origine (Stripe ne rend pas ses frais lors d'un remboursement)
    const feeBaseCents = Number(payout.original_amount_cents) > 0 ? Number(payout.original_amount_cents) : payout.amount_cents;
    const feeShare = chargedTotal > 0 ? Math.floor((totalFee * (feeBaseCents + shippingCents)) / chargedTotal) : 0;
    // La commission ne porte que sur les produits : les frais d'expédition lui sont reversés en entier
    const beforeMonthlyFee = payout.amount_cents + shippingCents - payout.commission_cents - feeShare;

    // Les 2 € de frais de service vendeur actif : une seule fois par vendeur et par mois,
    // prélevés sur ce versement sans jamais dépasser ce qu'il rapporte (le reste, s'il y en a un,
    // sera pris sur les ventes suivantes du même mois). Un versement retenté ne paie jamais deux fois.
    const available = Math.max(beforeMonthlyFee, 0);
    const { data: collectedFee, error: monthlyFeeError } = await supabase.rpc('collect_monthly_fee', {
      p_payout_id: payout.id,
      p_available_cents: available,
    });
    if (monthlyFeeError) {
      throw new Error('Frais de service mensuels : ' + monthlyFeeError.message);
    }
    const monthlyFeeCents = Math.max(0, Math.min(Number(collectedFee) || 0, available));

    // Les frais de carte des remboursements « vendeur absent » de CE vendeur, jamais rendus par Stripe :
    // retirés ici, sans dépasser ce que rapporte ce versement (le reste attend le suivant).
    // Un versement retenté ne paie jamais deux fois (la fonction rend le même montant).
    const availableForRefundFees = Math.max(beforeMonthlyFee - monthlyFeeCents, 0);
    const { data: collectedRefundFees, error: refundFeesError } = await supabase.rpc('collect_refund_fees', {
      p_seller_id: String(payout.seller_id),
      p_payout_id: String(payout.id),
      p_available_cents: availableForRefundFees,
    });
    if (refundFeesError) {
      throw new Error('Frais de remboursement : ' + refundFeesError.message);
    }
    const refundFeesCents = Math.max(0, Math.min(Number(collectedRefundFees) || 0, availableForRefundFees));
    const sellerCents = beforeMonthlyFee - monthlyFeeCents - refundFeesCents;

    // 5. Montant nul après commission et frais : rien à envoyer
    if (sellerCents <= 0) {
      const { error: zeroError } = await supabase
        .from('payouts')
        .update({
          status: 'verse',
          released_at: new Date().toISOString(),
          stripe_charge_id: chargeId,
          stripe_fee_cents: feeShare,
          seller_cents: 0,
          last_error: 'Montant nul après commission et frais : aucun virement envoyé',
        })
        .eq('id', payout.id);

      if (zeroError) {
        throw new Error('Enregistrement impossible : ' + zeroError.message);
      }
      return { ok: true, sellerCents: 0, transferId: null };
    }

    // 6. Le virement au vendeur. On vérifie d'abord qu'il n'existe pas déjà (reprise après une panne).
    let transfer = null;
    const recent = await stripe.transfers.list({ destination: seller.stripe_account_id, limit: 100 });
    transfer = (recent.data || []).find((t) => t.metadata && t.metadata.payout_id === payout.id) || null;

    if (!transfer) {
      transfer = await stripe.transfers.create(
        {
          amount: sellerCents,
          currency: 'eur',
          destination: seller.stripe_account_id,
          source_transaction: chargeId,
          metadata: {
            payout_id: payout.id,
            order_id: payout.order_id,
            seller_id: payout.seller_id,
          },
        },
        { idempotencyKey: 'payout_' + payout.id }
      );
    }

    // 7. On note que le vendeur a été payé
    const { error: doneError } = await supabase
      .from('payouts')
      .update({
        status: 'verse',
        released_at: new Date().toISOString(),
        stripe_transfer_id: transfer.id,
        stripe_charge_id: chargeId,
        stripe_fee_cents: feeShare,
        seller_cents: sellerCents,
        last_error: null,
      })
      .eq('id', payout.id);

    if (doneError) {
      throw new Error(`Virement ${transfer.id} envoyé mais non enregistré : ${doneError.message}`);
    }

    console.log(`Versement ${payout.id} : ${sellerCents} centimes envoyés au vendeur ${payout.seller_id} (virement ${transfer.id}).`);
    return { ok: true, sellerCents, transferId: transfer.id };
  } catch (err) {
    console.error(`Versement ${payout.id} en échec :`, err.message);

    // On le remet dans son état d'origine pour qu'il soit retenté (la raison est gardée)
    await supabase
      .from('payouts')
      .update({ status: restoreStatus, last_error: String(err.message).slice(0, 500) })
      .eq('id', payout.id);

    return { ok: false, reason: 'error', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Administration : traiter les problèmes signalés (rembourser l'acheteur ou payer le vendeur).
// Réservé aux adresses e-mail de la variable ADMIN_EMAILS (séparées par des virgules), avec e-mail confirmé.
// ---------------------------------------------------------------------------
function isAdminEmail(email) {
  const list = String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return !!email && list.includes(String(email).trim().toLowerCase());
}

// Renvoie l'administrateur connecté, ou répond (401 / 403) et renvoie null
async function requireAdmin(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ error: 'Vous devez être connecté.' });
    return null;
  }
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData || !userData.user) {
    res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
    return null;
  }
  const user = userData.user;
  if (!isAdminEmail(user.email) || !user.email_confirmed_at) {
    res.status(403).json({ error: 'Accès réservé.' });
    return null;
  }
  return user;
}

const uniqueValues = (values) => [...new Set(values.filter(Boolean))];

// La liste : les problèmes à traiter (les plus anciens d'abord) et les 20 dernières décisions
async function adminList() {
  const { data: problems, error: problemsError } = await supabase
    .from('payouts')
    .select('id, order_id, seller_id, amount_cents, shipping_cents, problem_reason, problem_reported_at, pickup_start_at, last_error')
    .eq('status', 'probleme')
    .order('problem_reported_at', { ascending: true })
    .limit(100);
  if (problemsError) throw new Error('Lecture des problèmes impossible : ' + problemsError.message);

  const { data: decided, error: decidedError } = await supabase
    .from('payouts')
    .select('id, order_id, seller_id, amount_cents, shipping_cents, problem_reason, problem_reported_at, resolution, resolved_at, resolution_note, refunded_cents, stripe_refund_id')
    .not('resolution', 'is', null)
    .order('resolved_at', { ascending: false })
    .limit(20);
  if (decidedError) throw new Error('Lecture des décisions impossible : ' + decidedError.message);

  const rows = [...(problems || []), ...(decided || [])];
  const orderIds = uniqueValues(rows.map((r) => r.order_id));
  const sellerIds = uniqueValues(rows.map((r) => r.seller_id));

  let orders = [];
  let sellers = [];
  let items = [];
  let listings = [];
  const buyerEmails = {};

  if (rows.length > 0) {
    const ordersResult = await supabase.from('orders').select('id, buyer_id, created_at').in('id', orderIds);
    if (ordersResult.error) throw new Error('Lecture des commandes impossible : ' + ordersResult.error.message);
    orders = ordersResult.data || [];

    const sellersResult = await supabase.from('sellers').select('id, city, email').in('id', sellerIds);
    if (sellersResult.error) throw new Error('Lecture des vendeurs impossible : ' + sellersResult.error.message);
    sellers = sellersResult.data || [];

    const itemsResult = await supabase.from('order_items').select('order_id, seller_id, listing_id, price_at_purchase').in('order_id', orderIds);
    if (itemsResult.error) throw new Error('Lecture des articles impossible : ' + itemsResult.error.message);
    items = itemsResult.data || [];

    const listingIds = uniqueValues(items.map((it) => it.listing_id));
    if (listingIds.length > 0) {
      const listingsResult = await supabase.from('listings').select('id, title, unit').in('id', listingIds);
      if (listingsResult.error) throw new Error('Lecture des annonces impossible : ' + listingsResult.error.message);
      listings = listingsResult.data || [];
    }

    // L'e-mail de chaque acheteur (il n'est jamais montré à personne d'autre que l'administrateur)
    await Promise.all(uniqueValues(orders.map((o) => o.buyer_id)).map(async (buyerId) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(buyerId);
        buyerEmails[buyerId] = (data && data.user && data.user.email) || null;
      } catch (err) {
        buyerEmails[buyerId] = null;
      }
    }));
  }

  const describe = (r) => {
    const order = orders.find((o) => o.id === r.order_id) || {};
    const seller = sellers.find((s) => s.id === r.seller_id) || {};
    const grouped = [];
    items.filter((it) => it.order_id === r.order_id && it.seller_id === r.seller_id).forEach((it) => {
      const listing = listings.find((l) => l.id === it.listing_id);
      const key = it.listing_id || 'supprimee';
      const cents = Math.round(Number(it.price_at_purchase || 0) * 100);
      let line = grouped.find((g) => g.key === key);
      if (!line) {
        line = {
          key,
          title: listing ? listing.title : 'Annonce supprimée',
          unit: listing ? (String(listing.unit == null ? '' : listing.unit).trim() || 'kg') : 'unité',
          quantity: 0,
          cents: 0,
        };
        grouped.push(line);
      }
      line.quantity += 1;
      line.cents += cents;
    });
    return {
      payoutId: r.id,
      orderDate: order.created_at || null,
      reportedAt: r.problem_reported_at || null,
      reason: r.problem_reason || '',
      amount: ((Number(r.amount_cents) || 0) + (Number(r.shipping_cents) || 0)) / 100,
      shippingAmount: (Number(r.shipping_cents) || 0) / 100,
      items: grouped.map((g) => ({ title: g.title, unit: g.unit, quantity: g.quantity, amount: g.cents / 100 })),
      seller: { city: seller.city || null, email: seller.email || null },
      buyer: { email: buyerEmails[order.buyer_id] || null },
    };
  };

  return {
    problems: (problems || []).map((r) => ({ ...describe(r), pickupStartAt: r.pickup_start_at || null, lastError: r.last_error || null })),
    resolved: (decided || []).map((r) => ({
      ...describe(r),
      resolution: r.resolution,
      resolvedAt: r.resolved_at || null,
      note: r.resolution_note || null,
      refundedAmount: r.refunded_cents != null ? (Number(r.refunded_cents) || 0) / 100 : null,
      refundId: r.stripe_refund_id || null,
    })),
  };
}

// « Rembourser l'acheteur » : seuls les articles de ce vendeur et ses frais d'expédition sont remboursés (jamais les 0,25 € de frais de service).
// Le remboursement part chez Stripe avec une clé anti-doublon : cliquer deux fois ne rembourse jamais deux fois.
// extra (facultatif) : { extraCents } = des centimes en plus des articles (les frais de service de l'acheteur quand toute la commande est remboursée),
// { cancelReason } = la raison de l'annulation notée sur le versement (par exemple « vendeur_absent »).
async function adminRefund(res, payout, note, extra = {}) {
  if (payout.status === 'rembourse') {
    return res.status(200).json({ status: 'rembourse', alreadyDone: true });
  }
  if (payout.status === 'verse') {
    return res.status(409).json({ error: 'Le vendeur a déjà été payé : ce problème ne peut plus être remboursé ici.' });
  }
  if (payout.status !== 'probleme') {
    return res.status(409).json({ error: "Ce versement n'est pas dans l'état « problème signalé »." });
  }

  const extraCents = Number(extra.extraCents) > 0 ? Math.floor(Number(extra.extraCents)) : 0;
  const amount = Number(payout.amount_cents) + (Number(payout.shipping_cents) || 0) + extraCents;
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Montant à rembourser invalide.' });
  }

  // Le paiement de l'acheteur chez Stripe (retrouvé si on ne l'avait pas noté)
  let chargeId = payout.stripe_charge_id;
  try {
    if (!chargeId) {
      const { data: order } = await supabase.from('orders').select('stripe_session_id').eq('id', payout.order_id).maybeSingle();
      if (!order || !order.stripe_session_id) {
        throw new Error('Paiement Stripe introuvable pour cette commande');
      }
      const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
      const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
      const latest = paymentIntent.latest_charge;
      chargeId = typeof latest === 'string' ? latest : (latest && latest.id) || null;
      if (!chargeId) {
        throw new Error('Paiement Stripe introuvable pour cette commande');
      }
    }
  } catch (err) {
    console.error(`Remboursement du versement ${payout.id} impossible :`, err.message);
    return res.status(502).json({ error: 'Paiement introuvable chez Stripe : ' + err.message });
  }

  let refund;
  try {
    refund = await stripe.refunds.create(
      {
        charge: chargeId,
        amount,
        metadata: { payout_id: payout.id, order_id: payout.order_id, seller_id: payout.seller_id, raison: 'probleme_signale' },
      },
      // Avec des frais de service en plus, le montant fait partie de la clé : une clé ne sert jamais pour deux montants différents
      { idempotencyKey: extraCents > 0 ? 'absence-refund-' + payout.id + '-' + amount : 'problem-refund-' + payout.id }
    );
  } catch (err) {
    console.error(`Remboursement du versement ${payout.id} refusé :`, err.message);
    await supabase
      .from('payouts')
      .update({ last_error: ('Remboursement refusé : ' + err.message).slice(0, 500) })
      .eq('id', payout.id)
      .eq('status', 'probleme');
    return res.status(502).json({ error: 'Stripe a refusé le remboursement : ' + err.message });
  }

  // Remboursement pour absence du vendeur : Stripe ne rend pas ses frais de carte, c'est le vendeur qui les paie
  // (retirés de son prochain versement). Part des frais correspondant aux produits remboursés, calculée comme pour un versement.
  // Jamais bloquant : si le calcul échoue, le remboursement est enregistré quand même (Agrivoisin absorbe).
  let refundFeeCents = null;
  if (extra.cancelReason === 'vendeur_absent') {
    try {
      const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
      const bt = charge.balance_transaction;
      const totalFee = bt && typeof bt === 'object' ? bt.fee : null;
      const { data: siblingRows } = await supabase.from('payouts').select('amount_cents, shipping_cents').eq('order_id', payout.order_id);
      if (totalFee !== null && totalFee !== undefined && siblingRows && siblingRows.length > 0) {
        const orderTotal = siblingRows.reduce((sum, row) => sum + (Number(row.amount_cents) || 0) + (Number(row.shipping_cents) || 0), 0);
        const chargedTotal = Math.max(Number(charge.amount) || 0, orderTotal);
        const sellerPart = (Number(payout.amount_cents) || 0) + (Number(payout.shipping_cents) || 0);
        refundFeeCents = chargedTotal > 0 ? Math.floor((totalFee * sellerPart) / chargedTotal) : 0;
      }
    } catch (feeError) {
      console.error(`Frais de carte du remboursement ${payout.id} non calculés (Agrivoisin les absorbe) :`, feeError.message);
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from('payouts')
    .update({
      status: 'rembourse',
      resolution: 'rembourse',
      resolved_at: new Date().toISOString(),
      refunded_cents: amount,
      stripe_refund_id: refund.id,
      resolution_note: note || null,
      ...(extra.cancelReason ? { cancel_reason: extra.cancelReason } : {}),
      ...(refundFeeCents !== null ? { refund_fee_cents: refundFeeCents } : {}),
      last_error: null,
    })
    .eq('id', payout.id)
    .eq('status', 'probleme')
    .select()
    .maybeSingle();

  if (updateError) {
    console.error(`Remboursement ${refund.id} créé mais non enregistré :`, updateError.message);
    return res.status(500).json({
      error: "Le remboursement est bien parti chez Stripe, mais il n'a pas pu être enregistré. Cliquez de nouveau sur « Rembourser l'acheteur » : il ne sera pas fait deux fois.",
    });
  }

  if (!updated) {
    // Un autre clic (ou une autre décision) est passé entre-temps
    const { data: current } = await supabase.from('payouts').select('status, stripe_refund_id').eq('id', payout.id).maybeSingle();
    if (current && current.status === 'rembourse' && current.stripe_refund_id === refund.id) {
      return res.status(200).json({ status: 'rembourse', alreadyDone: true });
    }
    console.error(`ALERTE : remboursement ${refund.id} créé chez Stripe mais le versement ${payout.id} a changé d'état entre-temps.`);
    return res.status(409).json({
      error: "Attention : un remboursement a été créé chez Stripe (" + refund.id + "), mais l'état du versement a changé entre-temps. Vérifiez dans Stripe et dans Supabase.",
    });
  }

  return res.status(200).json({ status: 'rembourse', refundedAmount: amount / 100 });
}

// « Payer le vendeur » : le versement reprend comme si l'acheteur avait confirmé la réception.
// S'il échoue, il revient à « problème signalé » (jamais « en attente » : il ne doit pas repartir tout seul).
async function adminPaySeller(res, payout, note) {
  if (payout.status === 'verse') {
    return res.status(200).json({ status: 'verse', alreadyDone: true });
  }
  if (payout.status === 'rembourse') {
    return res.status(409).json({ error: "L'acheteur a déjà été remboursé : le vendeur ne peut plus être payé." });
  }
  if (payout.status !== 'probleme') {
    return res.status(409).json({ error: "Ce versement n'est pas dans l'état « problème signalé »." });
  }

  const result = await releasePayout(payout.id, ['probleme'], 'probleme');

  if (!result.ok) {
    if (result.reason === 'not_claimable') {
      return res.status(409).json({ error: 'Le versement est déjà en cours de traitement ou a changé d\'état. Actualisez la page.' });
    }
    return res.status(502).json({ error: "Le versement n'a pas pu partir : " + result.error + '. Le problème reste en attente, vous pouvez réessayer.' });
  }

  const { error: decisionError } = await supabase
    .from('payouts')
    .update({ resolution: 'verse', resolved_at: new Date().toISOString(), resolution_note: note || null })
    .eq('id', payout.id);

  if (decisionError) {
    // Le vendeur est payé : seule la trace de la décision manque
    console.error(`Versement ${payout.id} envoyé mais décision non enregistrée :`, decisionError.message);
    return res.status(200).json({ status: 'verse', sellerAmount: result.sellerCents / 100, decisionSaved: false });
  }

  return res.status(200).json({ status: 'verse', sellerAmount: result.sellerCents / 100 });
}

async function handleAdminAction(req, res) {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { action, payoutId, note, alertId } = req.body || {};

    if (action === 'admin_list') {
      return res.status(200).json(await adminList());
    }
    if (action === 'admin_list_alerts') {
      return res.status(200).json(await adminListFraudAlerts());
    }
    if (action === 'admin_handle_alert') {
      if (typeof alertId !== 'string' || !alertId.trim() || alertId.length > 64) {
        return res.status(400).json({ error: 'Alerte manquante.' });
      }
      if (note !== undefined && note !== null && typeof note !== 'string') {
        return res.status(400).json({ error: 'Note invalide.' });
      }
      const alertNote = typeof note === 'string' ? note.trim() : '';
      if (alertNote.length > FRAUD_ALERT_NOTE_MAX) {
        return res.status(400).json({ error: 'La note est trop longue (' + FRAUD_ALERT_NOTE_MAX + ' caractères au maximum).' });
      }
      return await adminHandleFraudAlert(res, alertId.trim(), alertNote);
    }
    if (action !== 'admin_refund' && action !== 'admin_pay_seller') {
      return res.status(400).json({ error: 'Action inconnue.' });
    }
    if (typeof payoutId !== 'string' || !payoutId.trim()) {
      return res.status(400).json({ error: 'Versement manquant.' });
    }
    if (note !== undefined && note !== null && typeof note !== 'string') {
      return res.status(400).json({ error: 'Note invalide.' });
    }
    const noteText = typeof note === 'string' ? note.trim() : '';
    if (noteText.length > 500) {
      return res.status(400).json({ error: 'La note est trop longue (500 caractères au maximum).' });
    }

    const { data: payout, error: payoutError } = await supabase
      .from('payouts')
      .select('id, status, order_id, seller_id, amount_cents, shipping_cents, stripe_charge_id')
      .eq('id', payoutId.trim())
      .maybeSingle();
    if (payoutError) {
      console.error('Erreur Supabase (versement, administration) :', payoutError);
      return res.status(500).json({ error: 'Impossible de lire le versement pour le moment. Réessayez.' });
    }
    if (!payout) {
      return res.status(404).json({ error: 'Versement introuvable.' });
    }

    if (action === 'admin_refund') return await adminRefund(res, payout, noteText);
    return await adminPaySeller(res, payout, noteText);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// « Le vendeur n'était pas là » : possible seulement à partir de la FIN du créneau de retrait, tant que
// le code n'a pas été validé. L'acheteur est remboursé tout de suite des produits de ce retrait ; ses frais de service
// ne lui sont rendus que si toute la commande finit remboursée. La déclaration est gardée (absence_reported_at).
// Le versement passe d'abord en « problème » : si le remboursement échoue chez Stripe, il reste visible pour l'administrateur.
// ---------------------------------------------------------------------------
// Réponse « factice » : permet de réutiliser adminRefund en dehors d'une requête (passage automatique, refus de l'acheteur)
function captureRes() {
  return {
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// Les frais de service (payés une seule fois par commande) : rendus seulement si tous les AUTRES versements de la commande sont déjà remboursés
async function serviceFeeToRefund(payout) {
  const { data: siblings, error: siblingsError } = await supabase
    .from('payouts')
    .select('id, status')
    .eq('order_id', payout.order_id);
  if (siblingsError || !siblings || !siblings.every((p) => String(p.id) === String(payout.id) || p.status === 'rembourse')) {
    return 0;
  }
  const { data: orderRow } = await supabase.from('orders').select('service_fee_cents').eq('id', payout.order_id).maybeSingle();
  return Math.max(0, Number(orderRow && orderRow.service_fee_cents) || 0);
}

// Fin d'une demande d'autre créneau SANS retrait : l'acheteur est remboursé (comme pour une absence du vendeur).
// fromStates : les états de la demande acceptés au départ ; newState : l'état noté ensuite (refusee, expiree).
// Une seule exécution peut réussir : le versement est « réservé » avant le remboursement.
async function refundAfterReschedule(payout, fromStates, newState, reasonText) {
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from('payouts')
    .update({
      status: 'probleme',
      problem_reported_at: nowIso,
      problem_reason: reasonText,
      reschedule_status: newState,
      reschedule_answered_at: nowIso,
    })
    .eq('id', payout.id)
    .eq('status', 'en_attente')
    .is('picked_up_at', null)
    .in('reschedule_status', fromStates)
    .select()
    .maybeSingle();
  if (claimError) {
    console.error('Erreur Supabase (fin de la demande d\'autre créneau) :', claimError);
    return { ok: false, code: 500, error: 'Impossible d\'enregistrer votre réponse pour le moment. Réessayez.' };
  }
  if (!claimed) {
    return { ok: false, code: 409, error: 'Cette commande vient de changer d\'état. Actualisez la page.' };
  }
  const serviceFeeCents = await serviceFeeToRefund(claimed);
  const out = captureRes();
  await adminRefund(out, claimed, reasonText, { extraCents: serviceFeeCents, cancelReason: 'vendeur_absent' });
  return {
    ok: out.code === 200,
    code: out.code,
    refundedAmount: out.body && out.body.refundedAmount != null ? out.body.refundedAmount : null,
    error: out.body && out.body.error ? out.body.error : null,
  };
}

async function reportSellerAbsent(res, payout) {
  if (!payout.pickup_end_at) {
    return res.status(400).json({ error: "Cette commande n'a pas de créneau de retrait." });
  }
  if (payout.status === 'rembourse') {
    return res.status(200).json({ status: 'rembourse', alreadyDone: true });
  }
  if (payout.status !== 'en_attente') {
    return res.status(409).json({ error: 'Cette commande ne peut plus être modifiée. Actualisez la page.' });
  }
  if (payout.picked_up_at) {
    return res.status(409).json({ error: "Le vendeur a validé votre code : la commande est retirée. Choisissez « Autre problème » si elle n'est pas conforme." });
  }
  if (payout.reschedule_status === 'demandee' || payout.reschedule_status === 'proposee') {
    return res.status(409).json({ error: 'Vous avez demandé un autre créneau : cette demande doit d\'abord être réglée. Actualisez la page.' });
  }
  if (new Date(payout.pickup_end_at).getTime() > Date.now()) {
    return res.status(409).json({ error: "Vous pourrez déclarer l'absence du vendeur à partir du " + formatParisMoment(payout.pickup_end_at) + '.' });
  }

  // Une seule déclaration peut réussir (deux clics ne remboursent jamais deux fois)
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from('payouts')
    .update({
      status: 'probleme',
      problem_reported_at: nowIso,
      problem_reason: "Vendeur absent (déclaré par l'acheteur après la fin du créneau)",
      absence_reported_at: nowIso,
    })
    .eq('id', payout.id)
    .eq('status', 'en_attente')
    .is('picked_up_at', null)
    .select()
    .maybeSingle();
  if (claimError) {
    console.error('Erreur Supabase (vendeur absent) :', claimError);
    return res.status(500).json({ error: "Impossible d'enregistrer votre déclaration pour le moment. Réessayez." });
  }
  if (!claimed) {
    return res.status(409).json({ error: 'Cette commande vient de changer d\'état. Actualisez la page.' });
  }

  const serviceFeeCents = await serviceFeeToRefund(payout);

  return adminRefund(res, claimed, 'Vendeur absent : remboursement automatique', { extraCents: serviceFeeCents, cancelReason: 'vendeur_absent' });
}

// ---------------------------------------------------------------------------
// « Le vendeur n'était pas là, je veux un autre créneau » : mêmes conditions que l'absence (à partir de la FIN du créneau,
// code pas encore validé). Rien n'est remboursé : le vendeur a 24 h pour proposer un nouveau créneau. Une seule demande
// par retrait. L'absence est gardée (absence_reported_at) comme pour un remboursement. L'argent reste bloqué :
// le versement automatique est repoussé de 14 jours le temps que la demande soit réglée.
// ---------------------------------------------------------------------------
// Un autre créneau ne se demande que dans les 24 h qui suivent la FIN du premier créneau ; le vendeur a jusque-là pour répondre.
const RESCHEDULE_WINDOW_HOURS = 24;
const RESCHEDULE_BRAKE_DAYS = 14;
// Après un nouveau créneau accepté : sans code, l'argent est libéré 7 jours après sa fin (comme un premier créneau)
const RESCHEDULE_RELEASE_DAYS = 7;

async function requestReschedule(res, payout) {
  if (!payout.pickup_end_at) {
    return res.status(400).json({ error: "Cette commande n'a pas de créneau de retrait." });
  }
  if (payout.status !== 'en_attente') {
    return res.status(409).json({ error: 'Cette commande ne peut plus être modifiée. Actualisez la page.' });
  }
  if (payout.picked_up_at) {
    return res.status(409).json({ error: "Le vendeur a validé votre code : la commande est retirée. Choisissez « Autre problème » si elle n'est pas conforme." });
  }
  if (payout.reschedule_status) {
    return res.status(409).json({ error: 'Vous avez déjà demandé un autre créneau pour ce retrait. Actualisez la page.' });
  }
  if (new Date(payout.pickup_end_at).getTime() > Date.now()) {
    return res.status(409).json({ error: "Vous pourrez le demander à partir du " + formatParisMoment(payout.pickup_end_at) + '.' });
  }
  const limitMs = new Date(payout.pickup_end_at).getTime() + RESCHEDULE_WINDOW_HOURS * 60 * 60 * 1000;
  if (Date.now() > limitMs) {
    return res.status(409).json({ error: 'Trop tard : plus de 24 h se sont écoulées depuis la fin du créneau. Un autre créneau n\'est plus possible, vous pouvez seulement être remboursé. Actualisez la page.' });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const brakeIso = new Date(now.getTime() + RESCHEDULE_BRAKE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from('payouts')
    .update({
      reschedule_status: 'demandee',
      reschedule_requested_at: nowIso,
      absence_reported_at: nowIso,
      auto_release_at: brakeIso,
    })
    .eq('id', payout.id)
    .eq('status', 'en_attente')
    .is('picked_up_at', null)
    .is('reschedule_status', null)
    .select('id, reschedule_requested_at')
    .maybeSingle();
  if (claimError) {
    console.error('Erreur Supabase (demande d\'un autre créneau) :', claimError);
    return res.status(500).json({ error: "Impossible d'enregistrer votre demande pour le moment. Réessayez." });
  }
  if (!claimed) {
    return res.status(409).json({ error: 'Cette commande vient de changer d\'état. Actualisez la page.' });
  }

  const deadline = new Date(limitMs).toISOString();
  return res.status(200).json({ status: 'reschedule_requested', requestedAt: nowIso, deadlineAt: deadline });
}

// ---------------------------------------------------------------------------
// « Annuler » (retrait) : l'acheteur annule sa commande chez UN vendeur, entre le paiement et le début du créneau.
// Tout ou rien par vendeur : tous les retraits de ce vendeur dans la commande sont annulés ensemble.
// L'acheteur perd 50 % de la partie annulée (les produits de ce vendeur) : cette moitié va au vendeur, commission
// de 15 % prélevée dessus, et le vendeur paie en entier les frais de carte. Les 0,25 € de frais de service restent à Agrivoisin.
// Exception : un produit non périssable d'un professionnel (catégorie réservée aux professionnels) est remboursé en totalité
// (rétractation de 14 jours), frais de service compris si toute la commande finit remboursée.
// ---------------------------------------------------------------------------
// Catégories de produits frais : la retenue de 50 % s'applique (les autres sont réservées aux professionnels)
const FRESH_CATEGORIES = ['Fruits', 'Légumes', 'Aromates', 'Fleurs du jardin'];

// Le paiement de l'acheteur chez Stripe (retrouvé si on ne l'avait pas noté)
async function findChargeId(payout) {
  if (payout.stripe_charge_id) return payout.stripe_charge_id;
  const { data: order } = await supabase.from('orders').select('stripe_session_id').eq('id', payout.order_id).maybeSingle();
  if (!order || !order.stripe_session_id) {
    throw new Error('Paiement Stripe introuvable pour cette commande');
  }
  const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
  const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
  const latest = paymentIntent.latest_charge;
  const chargeId = typeof latest === 'string' ? latest : (latest && latest.id) || null;
  if (!chargeId) {
    throw new Error('Paiement Stripe introuvable pour cette commande');
  }
  return chargeId;
}

// Ce que coûte l'annulation d'un retrait : { refund, retained, commission, full } (en centimes)
async function computeCancellation(payout) {
  const amount = Number(payout.amount_cents) || 0;
  let freshCents = amount;

  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select('listing_id, price_at_purchase')
    .eq('payout_id', payout.id);
  if (itemsError) throw new Error('Lecture des articles impossible : ' + itemsError.message);

  if (items && items.length > 0) {
    const listingIds = uniqueValues(items.map((it) => it.listing_id));
    let categories = {};
    if (listingIds.length > 0) {
      const { data: listingRows, error: listingError } = await supabase.from('listings').select('id, category').in('id', listingIds);
      if (listingError) throw new Error('Lecture des annonces impossible : ' + listingError.message);
      (listingRows || []).forEach((l) => { categories[l.id] = l.category; });
    }
    let totalCents = 0;
    let freshItemsCents = 0;
    items.forEach((it) => {
      const cents = Math.round(Number(it.price_at_purchase || 0) * 100);
      totalCents += cents;
      // Une annonce introuvable est traitée comme un produit frais
      const category = categories[it.listing_id];
      if (!category || FRESH_CATEGORIES.includes(category)) freshItemsCents += cents;
    });
    if (totalCents > 0) freshCents = Math.round((amount * freshItemsCents) / totalCents);
  }

  // Arrondi vers le bas : l'acheteur ne perd jamais plus de la moitié
  const retained = Math.min(amount, Math.floor(freshCents / 2));
  const refund = amount - retained;
  const commission = amount > 0 ? Math.round(((Number(payout.commission_cents) || 0) * retained) / amount) : 0;
  return { refund, retained, commission, full: retained === 0 };
}

// Remet en vente les quantités d'un retrait annulé (une ligne d'article = une unité).
// Jamais bloquant : le remboursement est déjà parti, une erreur est seulement notée dans les journaux.
async function giveBackCancelledStock(payoutId) {
  try {
    const { data: items, error } = await supabase
      .from('order_items')
      .select('listing_id')
      .eq('payout_id', payoutId);
    if (error) throw new Error(error.message);
    const byListing = {};
    (items || []).forEach((it) => {
      if (it.listing_id) byListing[it.listing_id] = (byListing[it.listing_id] || 0) + 1;
    });
    for (const [listingId, qty] of Object.entries(byListing)) {
      const { error: giveError } = await supabase.rpc('give_back_listing_stock', { p_listing_id: listingId, p_quantity: qty });
      if (giveError) console.error('Annulation : impossible de remettre le stock de ' + listingId + ' :', giveError.message);
    }
  } catch (err) {
    console.error('Annulation ' + payoutId + ' : stock non remis en vente :', err.message);
  }
}

async function buyerCancelVendor(res, payoutRows, previewOnly) {
  const rows = payoutRows || [];
  // Seuls les retraits (avec créneau) sont concernés : un colis a sa propre règle
  const pickupRows = rows.filter((r) => r.pickup_end_at);
  const todo = pickupRows.filter((r) => !r.buyer_cancelled_at);

  if (todo.length === 0) {
    if (pickupRows.length > 0) {
      return res.status(200).json({ status: 'annule', alreadyDone: true });
    }
    return res.status(400).json({ error: "Cette commande n'est pas un retrait : elle ne peut pas être annulée ici." });
  }

  const nowMs = Date.now();
  for (const r of todo) {
    if (r.status !== 'en_attente') {
      return res.status(409).json({ error: 'Cette commande ne peut plus être annulée. Actualisez la page.' });
    }
    if (r.picked_up_at) {
      return res.status(409).json({ error: 'Le vendeur a validé votre code : la commande est retirée, elle ne peut plus être annulée.' });
    }
    if (r.reschedule_status) {
      return res.status(409).json({ error: "Un autre créneau a été demandé pour ce retrait : il ne peut plus être annulé ici. Actualisez la page." });
    }
    if (!r.pickup_start_at || new Date(r.pickup_start_at).getTime() <= nowMs) {
      return res.status(409).json({ error: "Le créneau de retrait a commencé : vous ne pouvez plus annuler. Retirez votre commande, ou signalez un problème après la fin du créneau si le vendeur n'était pas là." });
    }
  }

  let totalRefund = 0;
  let totalRetained = 0;
  const plans = [];
  try {
    for (const r of todo) {
      const plan = await computeCancellation(r);
      plans.push({ row: r, plan });
      totalRefund += plan.refund;
      totalRetained += plan.retained;
    }
  } catch (err) {
    console.error('Calcul de l\'annulation impossible :', err.message);
    return res.status(500).json({ error: "Impossible de calculer l'annulation pour le moment. Réessayez." });
  }

  // Simple aperçu (pour la fenêtre de confirmation) : rien n'est changé
  if (previewOnly) {
    return res.status(200).json({ refundAmount: totalRefund / 100, retainedAmount: totalRetained / 100, full: totalRetained === 0 });
  }

  let doneRefund = 0;
  let doneRetained = 0;
  for (const { row, plan } of plans) {
    const nowIso = new Date().toISOString();
    const original = Number(row.amount_cents) || 0;

    // 1. Réserver ce retrait : un seul clic peut réussir, et seulement avant le début du créneau
    const claimChanges = {
      status: 'en_cours',
      cancel_reason: 'acheteur_annule',
      buyer_cancelled_at: nowIso,
      // Pas d'échéance tant que le remboursement n'est pas parti : le passage automatique ne doit pas y toucher
      auto_release_at: null,
    };
    if (!plan.full) {
      claimChanges.original_amount_cents = original;
      claimChanges.amount_cents = plan.retained;
      claimChanges.commission_cents = plan.commission;
    }
    const { data: claimed, error: claimError } = await supabase
      .from('payouts')
      .update(claimChanges)
      .eq('id', row.id)
      .eq('status', 'en_attente')
      .is('picked_up_at', null)
      .is('reschedule_status', null)
      .gt('pickup_start_at', nowIso)
      .select()
      .maybeSingle();
    if (claimError) {
      console.error('Erreur Supabase (annulation) :', claimError);
      return res.status(500).json({ error: "Impossible d'enregistrer votre annulation pour le moment. Réessayez." });
    }
    if (!claimed) {
      return res.status(409).json({ error: 'Cette commande vient de changer d\'état (le créneau a peut-être commencé). Actualisez la page.' });
    }

    // Remet le retrait comme avant si le remboursement ne peut pas partir
    const restore = async (message) => {
      await supabase
        .from('payouts')
        .update({
          status: 'en_attente',
          cancel_reason: row.cancel_reason || null,
          buyer_cancelled_at: null,
          original_amount_cents: row.original_amount_cents || null,
          amount_cents: row.amount_cents,
          commission_cents: row.commission_cents,
          auto_release_at: row.auto_release_at || null,
          last_error: String(message).slice(0, 500),
        })
        .eq('id', row.id);
    };

    // 2. Le remboursement de l'acheteur (partiel, ou total pour un produit non périssable d'un professionnel)
    let extraCents = 0;
    if (plan.full) {
      try { extraCents = await serviceFeeToRefund(claimed); } catch (err) { extraCents = 0; }
    }
    const refundCents = plan.refund + extraCents;
    let refund;
    try {
      const chargeId = await findChargeId(claimed);
      refund = await stripe.refunds.create(
        {
          charge: chargeId,
          amount: refundCents,
          metadata: { payout_id: row.id, order_id: row.order_id, seller_id: row.seller_id, raison: 'annulation_acheteur' },
        },
        { idempotencyKey: 'buyer-cancel-' + row.id + '-' + refundCents }
      );
    } catch (err) {
      console.error(`Annulation du versement ${row.id} : remboursement refusé :`, err.message);
      await restore('Annulation : remboursement refusé : ' + err.message);
      return res.status(502).json({ error: "Le remboursement n'a pas pu partir : " + err.message + ' Réessayez dans quelques instants.' });
    }

    doneRefund += refundCents;
    doneRetained += plan.retained;

    // Le remboursement est parti : les quantités annulées retournent en vente
    await giveBackCancelledStock(row.id);

    // 3. On note le remboursement
    if (plan.full) {
      const { error: fullError } = await supabase
        .from('payouts')
        .update({
          status: 'rembourse',
          resolution: 'rembourse',
          resolved_at: new Date().toISOString(),
          refunded_cents: refundCents,
          stripe_refund_id: refund.id,
          resolution_note: "Annulation par l'acheteur (produit non périssable : remboursement total)",
          last_error: null,
        })
        .eq('id', row.id);
      if (fullError) {
        console.error(`ALERTE : remboursement ${refund.id} créé mais le versement ${row.id} n'a pas pu être noté :`, fullError.message);
      }
      continue;
    }

    const { error: noteError } = await supabase
      .from('payouts')
      .update({
        refunded_cents: refundCents,
        stripe_refund_id: refund.id,
        resolution_note: "Annulation par l'acheteur : 50 % retenus au profit du vendeur",
        // Le remboursement est parti : le versement du vendeur est dû tout de suite (retenté au prochain passage s'il échoue)
        auto_release_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (noteError) {
      console.error(`ALERTE : remboursement ${refund.id} créé mais le versement ${row.id} n'a pas pu être noté :`, noteError.message);
    }

    // 4. La moitié retenue est versée au vendeur tout de suite (commission et frais de carte déduits).
    // Si le versement échoue, il est remis « en attente » et sera retenté au prochain passage automatique.
    const released = await releasePayout(row.id, ['en_cours']);
    if (!released.ok) {
      console.error(`Annulation ${row.id} : versement du vendeur différé :`, released.error || released.reason);
    }
  }

  return res.status(200).json({ status: 'annule', refundedAmount: doneRefund / 100, retainedAmount: doneRetained / 100 });
}

// ---------------------------------------------------------------------------
// Actions de l'acheteur : "J'ai bien reçu ma commande" / "Signaler un problème"
// ---------------------------------------------------------------------------
// L'acheteur répond à l'autre créneau proposé par le vendeur : « accept » (le nouveau créneau remplace l'ancien, le même code reste valable)
// ou « refuse » (remboursement). Le refus reste possible tant que la demande n'est pas réglée ; l'acceptation, jusqu'au début du nouveau créneau.
async function answerReschedule(res, payout, answer) {
  if (answer !== 'accept' && answer !== 'refuse') {
    return res.status(400).json({ error: 'Réponse inconnue.' });
  }
  if (payout.status === 'rembourse') {
    return res.status(200).json({ status: 'rembourse', alreadyDone: true });
  }
  if (payout.status !== 'en_attente' || payout.picked_up_at || payout.reschedule_status !== 'proposee'
      || !payout.reschedule_proposed_start_at || !payout.reschedule_proposed_end_at) {
    return res.status(409).json({ error: 'Cette proposition n\'est plus d\'actualité. Actualisez la page.' });
  }

  if (answer === 'refuse') {
    const result = await refundAfterReschedule(payout, ['proposee'], 'refusee', "Autre créneau refusé par l'acheteur : remboursement");
    if (result.ok) return res.status(200).json({ status: 'rembourse', refundedAmount: result.refundedAmount });
    return res.status(result.code).json({ error: result.error || 'Le remboursement n\'a pas pu être fait. Réessayez.' });
  }

  const startMs = new Date(payout.reschedule_proposed_start_at).getTime();
  if (Date.now() >= startMs) {
    return res.status(409).json({ error: 'Le créneau proposé a déjà commencé : vous serez remboursé automatiquement. Actualisez la page.' });
  }

  const nowIso = new Date().toISOString();
  const releaseIso = new Date(new Date(payout.reschedule_proposed_end_at).getTime() + RESCHEDULE_RELEASE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: accepted, error: acceptError } = await supabase
    .from('payouts')
    .update({
      original_pickup_start_at: payout.pickup_start_at,
      original_pickup_end_at: payout.pickup_end_at,
      pickup_start_at: payout.reschedule_proposed_start_at,
      pickup_end_at: payout.reschedule_proposed_end_at,
      reschedule_status: 'acceptee',
      reschedule_answered_at: nowIso,
      auto_release_at: releaseIso,
    })
    .eq('id', payout.id)
    .eq('status', 'en_attente')
    .is('picked_up_at', null)
    .eq('reschedule_status', 'proposee')
    .select('id')
    .maybeSingle();
  if (acceptError) {
    console.error('Erreur Supabase (acceptation d\'un autre créneau) :', acceptError);
    return res.status(500).json({ error: 'Impossible d\'enregistrer votre réponse pour le moment. Réessayez.' });
  }
  if (!accepted) {
    return res.status(409).json({ error: 'Cette commande vient de changer d\'état. Actualisez la page.' });
  }
  return res.status(200).json({ status: 'reschedule_accepted', startAt: payout.reschedule_proposed_start_at, endAt: payout.reschedule_proposed_end_at });
}

async function handleBuyerAction(req, res) {
  try {
    const { action, orderId, sellerId, payoutId, reason, kind, answer } = req.body || {};

    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Vous devez être connecté.' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData || !userData.user) {
      return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
    }

    if (action !== 'confirm' && action !== 'report' && action !== 'reschedule_answer' && action !== 'cancel_vendor' && action !== 'cancel_info') {
      return res.status(400).json({ error: 'Action inconnue.' });
    }
    if (!orderId || !sellerId) {
      return res.status(400).json({ error: 'Commande ou vendeur manquant.' });
    }

    // Signaler un problème demande une explication écrite : 10 caractères au moins, 1000 au plus
    // (la page le vérifie aussi, mais le serveur ne se fie jamais à la page)
    // « Le vendeur n'était pas là » : aucune explication écrite demandée
    const isAbsence = action === 'report' && kind === 'absent';
    const isReschedule = action === 'report' && kind === 'reschedule';
    let reasonText = '';
    if (action === 'report' && !isAbsence && !isReschedule) {
      reasonText = typeof reason === 'string' ? reason.trim() : '';
      if (reasonText.length < 10) {
        return res.status(400).json({ error: "Merci d'expliquer le problème (au moins 10 caractères)." });
      }
      if (reasonText.length > 1000) {
        return res.status(400).json({ error: "L'explication est trop longue (1000 caractères au maximum)." });
      }
    }

    // La commande doit appartenir à l'acheteur connecté
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, buyer_id')
      .eq('id', orderId)
      .maybeSingle();

    if (orderError) {
      console.error('Erreur Supabase (commande) :', orderError);
      return res.status(500).json({ error: 'Impossible de lire votre commande pour le moment. Réessayez.' });
    }
    if (!order || order.buyer_id !== userData.user.id) {
      return res.status(404).json({ error: 'Commande introuvable.' });
    }

    // Un vendeur peut avoir plusieurs versements sur une même commande (un par créneau de retrait) :
    // la page peut donc préciser lequel (payoutId). Sans précision, on ne répond que s'il n'y en a qu'un.
    const { data: payoutRows, error: payoutError } = await supabase
      .from('payouts')
      .select('id, status, order_id, seller_id, amount_cents, shipping_cents, commission_cents, stripe_charge_id, pickup_start_at, pickup_end_at, picked_up_at, reschedule_status, reschedule_proposed_start_at, reschedule_proposed_end_at, auto_release_at, cancel_reason, buyer_cancelled_at, original_amount_cents')
      .eq('order_id', orderId)
      .eq('seller_id', sellerId);

    if (payoutError) {
      console.error('Erreur Supabase (versement) :', payoutError);
      return res.status(500).json({ error: 'Impossible de lire le versement pour le moment. Réessayez.' });
    }

    // ---- Annuler (retrait) : tous les retraits de ce vendeur dans la commande, ensemble ----
    if (action === 'cancel_vendor' || action === 'cancel_info') {
      if (!payoutRows || payoutRows.length === 0) {
        return res.status(404).json({ error: 'Aucun versement trouvé pour ce vendeur.' });
      }
      return await buyerCancelVendor(res, payoutRows, action === 'cancel_info');
    }
    let payout = null;
    if (typeof payoutId === 'string' && payoutId.trim()) {
      payout = (payoutRows || []).find((r) => String(r.id) === payoutId.trim()) || null;
    } else if ((payoutRows || []).length === 1) {
      payout = payoutRows[0];
    } else if ((payoutRows || []).length > 1) {
      return res.status(409).json({ error: 'Cette commande compte plusieurs retraits. Actualisez la page puis réessayez.' });
    }
    if (!payout) {
      return res.status(404).json({ error: 'Aucun versement à confirmer pour ce vendeur.' });
    }

    // ---- Réponse à l'autre créneau proposé par le vendeur ----
    if (action === 'reschedule_answer') {
      return await answerReschedule(res, payout, answer);
    }

    // ---- J'ai bien reçu ma commande ----
    if (action === 'confirm') {
      if (payout.status === 'verse') {
        return res.status(200).json({ status: 'verse', alreadyReleased: true });
      }
      if (payout.status === 'probleme') {
        return res.status(409).json({
          error: 'Un problème a été signalé pour cette commande : le versement est suspendu. Agrivoisin va examiner la situation.',
        });
      }
      if (payout.status === 'en_cours') {
        return res.status(409).json({ error: 'Le versement est en cours de traitement. Réessayez dans un instant.' });
      }

      // Retrait avec créneau et code : c'est le vendeur qui valide le code, l'acheteur ne peut pas libérer l'argent lui-même
      if (payout.pickup_end_at) {
        return res.status(409).json({
          error: 'Pour un retrait, c\'est le code donné au vendeur qui confirme la remise : votre paiement lui est versé 24 h après. Vous pouvez signaler un problème d\'ici là.',
        });
      }

      const result = await releasePayout(payout.id, ['en_attente']);

      if (result.ok) {
        return res.status(200).json({ status: 'verse' });
      }
      if (result.reason === 'not_claimable') {
        return res.status(409).json({ error: 'Le versement est déjà en cours de traitement ou a changé d\'état. Actualisez la page.' });
      }

      // Échec technique : la confirmation de l'acheteur est gardée, le versement sera retenté au prochain passage
      await supabase
        .from('payouts')
        .update({ auto_release_at: new Date().toISOString() })
        .eq('id', payout.id)
        .eq('status', 'en_attente');

      return res.status(502).json({
        error: "Merci, votre confirmation est bien enregistrée. Le versement n'a pas pu partir tout de suite, il sera retenté automatiquement.",
      });
    }

    // ---- Le vendeur n'était pas là, je veux un autre créneau ----
    if (isReschedule) {
      return await requestReschedule(res, payout);
    }

    // ---- Le vendeur n'était pas là ----
    if (isAbsence) {
      return await reportSellerAbsent(res, payout);
    }

    // ---- Signaler un problème ----
    if (payout.status === 'probleme') {
      return res.status(200).json({ status: 'probleme' });
    }
    if (payout.status === 'verse') {
      return res.status(409).json({ error: 'Le vendeur a déjà reçu son paiement. Contactez Agrivoisin pour ce problème.' });
    }
    if (payout.status === 'en_cours') {
      return res.status(409).json({ error: 'Le versement est en cours de traitement. Réessayez dans un instant.' });
    }

    // Signaler un problème n'est possible qu'à partir du début du créneau de retrait : avant, la commande
    // n'a pas pu être retirée. Sans début de créneau (anciennes commandes, annonces sans horaires), aucune attente.
    if (payout.pickup_start_at && new Date(payout.pickup_start_at).getTime() > Date.now()) {
      return res.status(409).json({
        error: 'Vous pourrez signaler un problème à partir du ' + formatParisMoment(payout.pickup_start_at) + '.',
      });
    }

    const { data: updated, error: reportError } = await supabase
      .from('payouts')
      .update({ status: 'probleme', problem_reported_at: new Date().toISOString(), problem_reason: reasonText })
      .eq('id', payout.id)
      .eq('status', 'en_attente')
      .select()
      .maybeSingle();

    if (reportError) {
      console.error('Erreur Supabase (signalement) :', reportError);
      return res.status(500).json({ error: 'Impossible d\'enregistrer votre signalement pour le moment. Réessayez.' });
    }
    if (!updated) {
      return res.status(409).json({ error: 'Le versement vient de changer d\'état. Actualisez la page.' });
    }

    return res.status(200).json({ status: 'probleme' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}

// ---------------------------------------------------------------------------
// Passage automatique (une fois par jour) : verse ce dont l'échéance est passée
// ---------------------------------------------------------------------------
// Annonces retirées de la vente par leur vendeur (commande en cours) : une fois toutes leurs commandes terminées
// (argent versé ou remboursé), elles sont effacées pour de bon. Une erreur ici ne bloque jamais les versements.
const OPEN_PAYOUT_STATUSES = ['en_attente', 'en_cours', 'probleme'];

async function listingHasOpenOrders(listingId) {
  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select('order_id, seller_id, payout_id')
    .eq('listing_id', listingId);
  if (itemsError) throw itemsError;
  if (!items || items.length === 0) return false;

  const payoutIds = [...new Set(items.map((it) => it.payout_id).filter(Boolean))];
  if (payoutIds.length > 0) {
    const { data: rows, error: rowsError } = await supabase
      .from('payouts')
      .select('id')
      .in('id', payoutIds)
      .in('status', OPEN_PAYOUT_STATUSES)
      .limit(1);
    if (rowsError) throw rowsError;
    if (rows && rows.length > 0) return true;
  }

  // Anciennes commandes (article sans versement noté) : les versements du vendeur sur cette commande
  const legacy = items.filter((it) => !it.payout_id);
  if (legacy.length > 0) {
    const orderIds = [...new Set(legacy.map((it) => it.order_id).filter(Boolean))];
    const sellerIds = [...new Set(legacy.map((it) => it.seller_id).filter(Boolean))];
    if (orderIds.length > 0 && sellerIds.length > 0) {
      const { data: rows, error: rowsError } = await supabase
        .from('payouts')
        .select('id')
        .in('order_id', orderIds)
        .in('seller_id', sellerIds)
        .in('status', OPEN_PAYOUT_STATUSES)
        .limit(1);
      if (rowsError) throw rowsError;
      if (rows && rows.length > 0) return true;
    }
  }
  return false;
}

async function deleteFinishedWithdrawnListings() {
  let deleted = 0;
  try {
    const { data: withdrawn, error } = await supabase
      .from('listings')
      .select('id')
      .not('withdrawn_at', 'is', null)
      .limit(100);
    if (error) throw error;
    for (const listing of withdrawn || []) {
      if (await listingHasOpenOrders(listing.id)) continue;
      const { error: deleteError } = await supabase.from('listings').delete().eq('id', listing.id);
      if (deleteError) throw deleteError;
      deleted++;
    }
  } catch (cleanupError) {
    console.error('Effacement des annonces retirées impossible :', cleanupError);
  }
  return deleted;
}

// Autres créneaux restés sans réponse (le passage a lieu une fois par jour : le remboursement peut venir au plus tard le lendemain matin) :
// - le vendeur n'a rien proposé dans les 24 h qui suivent la FIN du premier créneau ;
// - le vendeur a proposé un créneau mais l'acheteur n'a pas répondu avant son début.
async function expireReschedules(now, deadline, summary) {
  try {
    const nowIso = now.toISOString();
    const sellerLimitIso = new Date(now.getTime() - RESCHEDULE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const { data: noProposal, error: noProposalError } = await supabase
      .from('payouts')
      .select('id, status, order_id, seller_id, amount_cents, shipping_cents, stripe_charge_id')
      .eq('status', 'en_attente')
      .eq('reschedule_status', 'demandee')
      .is('picked_up_at', null)
      .lte('pickup_end_at', sellerLimitIso)
      .limit(BATCH_SIZE);
    if (noProposalError) console.error('Lecture des demandes sans proposition impossible :', noProposalError.message);

    const { data: noAnswer, error: noAnswerError } = await supabase
      .from('payouts')
      .select('id, status, order_id, seller_id, amount_cents, shipping_cents, stripe_charge_id')
      .eq('status', 'en_attente')
      .eq('reschedule_status', 'proposee')
      .is('picked_up_at', null)
      .lte('reschedule_proposed_start_at', nowIso)
      .limit(BATCH_SIZE);
    if (noAnswerError) console.error('Lecture des propositions sans réponse impossible :', noAnswerError.message);

    const jobs = [
      ...(noProposal || []).map((p) => ({ p, from: ['demandee'], text: "Le vendeur n'a pas proposé d'autre créneau à temps : remboursement automatique" })),
      ...(noAnswer || []).map((p) => ({ p, from: ['proposee'], text: "L'acheteur n'a pas répondu avant le début du nouveau créneau : remboursement automatique" })),
    ];
    for (const job of jobs) {
      if (Date.now() >= deadline) break;
      const result = await refundAfterReschedule(job.p, job.from, 'expiree', job.text);
      if (result.ok) summary.rescheduleRefunded++;
      else if (result.code !== 409) summary.rescheduleFailed++;
    }
  } catch (error) {
    console.error('Remboursements des autres créneaux sans réponse impossibles :', error);
  }
}

// ---------------------------------------------------------------------------
// Alertes de fraude : le passage automatique de la nuit repère des cas à regarder, et prévient l'administrateur.
// Il ne bloque, ne sanctionne et ne rembourse jamais rien tout seul : une alerte montre des FAITS (dates, montants, nombres),
// jamais une note, et c'est l'administrateur qui examine chaque cas (la personne peut contester).
// Les seuils ne sont pas publiés. Une alerte est effacée après 12 mois.
// ---------------------------------------------------------------------------
const FRAUD_DAY_MS = 24 * 60 * 60 * 1000;
const FRAUD_BUYER_PROBLEMS = 3;       // un acheteur : 3 remboursements ou problèmes signalés...
const FRAUD_BUYER_DAYS = 30;          // ...en 30 jours
const FRAUD_SELLER_ABSENCES = 2;      // un vendeur : 2 absences déclarées...
const FRAUD_SELLER_ABSENCE_DAYS = 30; // ...en 30 jours
const FRAUD_SELLER_MIN_ORDERS = 5;    // un vendeur : au moins 5 commandes...
const FRAUD_SELLER_SHARE = 0.3;       // ...dont 30 % ou plus finissent remboursées ou signalées...
const FRAUD_SELLER_DAYS = 60;         // ...sur 60 jours
const FRAUD_REPEAT_DAYS = 30;         // pas de nouvelle alerte du même type pour la même personne pendant 30 jours
const FRAUD_KEEP_DAYS = 365;          // durée de conservation d'une alerte
const FRAUD_ALERT_NOTE_MAX = 500;
const FRAUD_MAX_LISTED_FACTS = 10;

// Les cas à signaler, à partir des versements récents.
// rows : les versements ; buyerByOrder : { identifiant de la commande -> identifiant de l'acheteur } ; nowMs : l'heure du passage.
function fraudCandidates(rows, buyerByOrder, nowMs) {
  const ms = (iso) => (iso ? new Date(iso).getTime() : NaN);
  const within = (iso, days) => ms(iso) >= nowMs - days * FRAUD_DAY_MS;
  const money = (r) => ((Number(r.amount_cents) || 0) + (Number(r.shipping_cents) || 0)) / 100;
  const candidates = [];

  // 1. Un acheteur avec beaucoup de remboursements ou de problèmes signalés (hors annulations qu'il a faites lui-même)
  const byBuyer = {};
  rows.forEach((r) => {
    if (!r.problem_reported_at || !within(r.problem_reported_at, FRAUD_BUYER_DAYS) || r.buyer_cancelled_at) return;
    const buyerId = buyerByOrder[r.order_id];
    if (!buyerId) return;
    (byBuyer[buyerId] = byBuyer[buyerId] || []).push(r);
  });
  Object.keys(byBuyer).forEach((buyerId) => {
    const list = byBuyer[buyerId];
    if (list.length < FRAUD_BUYER_PROBLEMS) return;
    const absences = list.filter((r) => r.absence_reported_at).length;
    candidates.push({
      kind: 'acheteur_problemes',
      subject_type: 'acheteur',
      subject_id: String(buyerId),
      facts: {
        periodeJours: FRAUD_BUYER_DAYS,
        nombre: list.length,
        absencesDeclarees: absences,
        autresProblemes: list.length - absences,
        signalements: list.slice(0, FRAUD_MAX_LISTED_FACTS).map((r) => ({ date: r.problem_reported_at, montant: money(r), absence: !!r.absence_reported_at })),
      },
    });
  });

  // 2. Un vendeur absent à plusieurs reprises
  const absentBySeller = {};
  rows.forEach((r) => {
    if (!r.absence_reported_at || !within(r.absence_reported_at, FRAUD_SELLER_ABSENCE_DAYS) || !r.seller_id) return;
    (absentBySeller[r.seller_id] = absentBySeller[r.seller_id] || []).push(r);
  });
  Object.keys(absentBySeller).forEach((sellerId) => {
    const list = absentBySeller[sellerId];
    if (list.length < FRAUD_SELLER_ABSENCES) return;
    candidates.push({
      kind: 'vendeur_absences',
      subject_type: 'vendeur',
      subject_id: String(sellerId),
      facts: {
        periodeJours: FRAUD_SELLER_ABSENCE_DAYS,
        nombre: list.length,
        absences: list.slice(0, FRAUD_MAX_LISTED_FACTS).map((r) => ({ date: r.absence_reported_at, montant: money(r) })),
      },
    });
  });

  // 3. Un vendeur dont une grande part des commandes finit remboursée ou signalée (les annulations faites par l'acheteur ne comptent pas)
  const ordersBySeller = {};
  rows.forEach((r) => {
    if (!r.seller_id || r.buyer_cancelled_at || !within(r.created_at, FRAUD_SELLER_DAYS)) return;
    (ordersBySeller[r.seller_id] = ordersBySeller[r.seller_id] || []).push(r);
  });
  Object.keys(ordersBySeller).forEach((sellerId) => {
    const list = ordersBySeller[sellerId];
    if (list.length < FRAUD_SELLER_MIN_ORDERS) return;
    const flagged = list.filter((r) => r.problem_reported_at).length;
    if (flagged / list.length < FRAUD_SELLER_SHARE) return;
    candidates.push({
      kind: 'vendeur_taux',
      subject_type: 'vendeur',
      subject_id: String(sellerId),
      facts: {
        periodeJours: FRAUD_SELLER_DAYS,
        commandes: list.length,
        signalees: flagged,
        pourcentage: Math.round((flagged / list.length) * 100),
      },
    });
  });

  return candidates;
}

// Lecture, repérage, enregistrement. Ne bloque jamais le reste du passage : en cas de panne, on réessaie la nuit suivante.
async function runFraudDetection() {
  try {
    const nowMs = Date.now();
    const sinceShort = new Date(nowMs - Math.max(FRAUD_BUYER_DAYS, FRAUD_SELLER_ABSENCE_DAYS) * FRAUD_DAY_MS).toISOString();
    const sinceLong = new Date(nowMs - FRAUD_SELLER_DAYS * FRAUD_DAY_MS).toISOString();

    const rows = [];
    const PAGE = 1000;
    for (let page = 0; page < 20; page += 1) {
      const { data, error } = await supabase
        .from('payouts')
        .select('id, order_id, seller_id, created_at, problem_reported_at, absence_reported_at, buyer_cancelled_at, amount_cents, shipping_cents')
        .or('created_at.gte.' + sinceLong + ',problem_reported_at.gte.' + sinceShort + ',absence_reported_at.gte.' + sinceShort)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw new Error('lecture des versements : ' + error.message);
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }

    const orderIds = uniqueValues(rows.map((r) => r.order_id));
    const buyerByOrder = {};
    for (let i = 0; i < orderIds.length; i += 200) {
      const { data, error } = await supabase.from('orders').select('id, buyer_id').in('id', orderIds.slice(i, i + 200));
      if (error) throw new Error('lecture des commandes : ' + error.message);
      (data || []).forEach((o) => { buyerByOrder[o.id] = o.buyer_id; });
    }

    const candidates = fraudCandidates(rows, buyerByOrder, nowMs);

    // Pas de nouvelle alerte du même type pour la même personne tant que la précédente est récente
    const { data: recent, error: recentError } = await supabase
      .from('fraud_alerts')
      .select('kind, subject_id')
      .gte('created_at', new Date(nowMs - FRAUD_REPEAT_DAYS * FRAUD_DAY_MS).toISOString());
    if (recentError) throw new Error('lecture des alertes : ' + recentError.message);
    const seen = new Set((recent || []).map((a) => a.kind + '|' + a.subject_id));
    const fresh = candidates.filter((c) => !seen.has(c.kind + '|' + c.subject_id));

    if (fresh.length > 0) {
      const { error: insertError } = await supabase.from('fraud_alerts').insert(fresh);
      if (insertError) throw new Error('enregistrement des alertes : ' + insertError.message);
    }

    // Les alertes de plus de 12 mois sont effacées
    const { error: cleanError } = await supabase
      .from('fraud_alerts')
      .delete()
      .lt('created_at', new Date(nowMs - FRAUD_KEEP_DAYS * FRAUD_DAY_MS).toISOString());
    if (cleanError) console.error('Effacement des anciennes alertes impossible :', cleanError.message);

    return fresh.length;
  } catch (error) {
    console.error('Repérage des fraudes impossible (réessayé la nuit suivante) :', error.message);
    return 0;
  }
}

// La liste pour l'administrateur : les alertes à examiner (les plus anciennes d'abord) et les 20 dernières examinées
async function adminListFraudAlerts() {
  const { data: open, error: openError } = await supabase
    .from('fraud_alerts')
    .select('id, kind, subject_type, subject_id, facts, status, note, created_at, handled_at')
    .eq('status', 'nouvelle')
    .order('created_at', { ascending: true })
    .limit(100);
  if (openError) throw new Error('Lecture des alertes impossible : ' + openError.message);

  const { data: done, error: doneError } = await supabase
    .from('fraud_alerts')
    .select('id, kind, subject_type, subject_id, facts, status, note, created_at, handled_at')
    .eq('status', 'examinee')
    .order('handled_at', { ascending: false })
    .limit(20);
  if (doneError) throw new Error('Lecture des alertes examinées impossible : ' + doneError.message);

  const rows = [...(open || []), ...(done || [])];
  const sellerIds = uniqueValues(rows.filter((r) => r.subject_type === 'vendeur').map((r) => r.subject_id));
  const buyerIds = uniqueValues(rows.filter((r) => r.subject_type === 'acheteur').map((r) => r.subject_id));

  const sellers = {};
  if (sellerIds.length > 0) {
    const { data, error } = await supabase.from('sellers').select('id, city, pseudo, email').in('id', sellerIds);
    if (error) throw new Error('Lecture des vendeurs impossible : ' + error.message);
    (data || []).forEach((s) => { sellers[String(s.id)] = s; });
  }
  const buyerEmails = {};
  await Promise.all(buyerIds.map(async (buyerId) => {
    try {
      const { data } = await supabase.auth.admin.getUserById(buyerId);
      buyerEmails[buyerId] = (data && data.user && data.user.email) || null;
    } catch (err) {
      buyerEmails[buyerId] = null;
    }
  }));

  const describe = (r) => ({
    id: r.id,
    kind: r.kind,
    subjectType: r.subject_type,
    createdAt: r.created_at,
    handledAt: r.handled_at || null,
    note: r.note || null,
    facts: r.facts || {},
    person: r.subject_type === 'vendeur'
      ? { city: (sellers[r.subject_id] || {}).city || null, pseudo: (sellers[r.subject_id] || {}).pseudo || null, email: (sellers[r.subject_id] || {}).email || null }
      : { email: buyerEmails[r.subject_id] || null },
  });
  return { alerts: (open || []).map(describe), examined: (done || []).map(describe) };
}

// « J'ai examiné » : l'alerte passe dans les alertes examinées, avec une note facultative
async function adminHandleFraudAlert(res, alertId, note) {
  const { data, error } = await supabase
    .from('fraud_alerts')
    .update({ status: 'examinee', handled_at: new Date().toISOString(), note: note || null })
    .eq('id', alertId)
    .eq('status', 'nouvelle')
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('Erreur Supabase (alerte de fraude) :', error);
    return res.status(500).json({ error: "Impossible d'enregistrer pour le moment. Réessayez." });
  }
  if (!data) {
    return res.status(409).json({ error: 'Cette alerte a déjà été examinée, ou elle n\'existe plus.' });
  }
  return res.status(200).json({ status: 'examinee' });
}

async function runAutomaticReleases(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'CRON_SECRET non configuré.' });
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Non autorisé.' });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const stuckIso = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();

    const { data: due, error: dueError } = await supabase
      .from('payouts')
      .select('id, status')
      .eq('status', 'en_attente')
      .lte('auto_release_at', nowIso)
      .order('auto_release_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (dueError) {
      throw new Error('Lecture des versements échus impossible : ' + dueError.message);
    }

    const { data: stuck, error: stuckError } = await supabase
      .from('payouts')
      .select('id, status')
      .eq('status', 'en_cours')
      .lte('auto_release_at', stuckIso)
      .order('auto_release_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (stuckError) {
      throw new Error('Lecture des versements bloqués impossible : ' + stuckError.message);
    }

    const queue = [...(due || []), ...(stuck || [])];
    const summary = { found: queue.length, released: 0, failed: 0, skipped: 0, remaining: 0, rescheduleRefunded: 0, rescheduleFailed: 0 };

    const budget = process.env.PAYOUTS_TIME_BUDGET_MS !== undefined
      ? Number(process.env.PAYOUTS_TIME_BUDGET_MS)
      : DEFAULT_TIME_BUDGET_MS;
    const deadline = Date.now() + budget;

    // D'abord les autres créneaux restés sans réponse : remboursement automatique de l'acheteur
    await expireReschedules(now, deadline, summary);

    for (let i = 0; i < queue.length; i++) {
      if (Date.now() >= deadline) {
        summary.remaining = queue.length - i;
        break;
      }

      const item = queue[i];
      const result = await releasePayout(item.id, [item.status]);

      if (result.ok) summary.released++;
      else if (result.reason === 'not_claimable') summary.skipped++;
      else summary.failed++;
    }

    summary.listingsDeleted = await deleteFinishedWithdrawnListings();

    // Repérage des cas à examiner (alertes pour l'administrateur ; jamais de sanction automatique)
    summary.fraudAlerts = Date.now() < deadline ? await runFraudDetection() : 'reporté';

    console.log('Passage automatique des versements :', JSON.stringify(summary));
    return res.status(200).json(summary);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return runAutomaticReleases(req, res);
  }
  if (req.method === 'POST') {
    const action = req.body && req.body.action;
    if (typeof action === 'string' && action.startsWith('admin_')) {
      return handleAdminAction(req, res);
    }
    return handleBuyerAction(req, res);
  }
  return res.status(405).json({ error: 'Méthode non autorisée' });
}
