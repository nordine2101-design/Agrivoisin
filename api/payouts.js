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
      .select('amount_cents')
      .eq('order_id', payout.order_id);

    if (siblingsError || !siblings || siblings.length === 0) {
      throw new Error('Versements de la commande illisibles');
    }

    const orderTotal = siblings.reduce((sum, p) => sum + p.amount_cents, 0);
    // Chaque vendeur paie sa part des frais de carte, au prorata du montant TOTAL payé par l'acheteur
    // (articles + frais de service). Agrivoisin garde à sa charge la part des frais de service de l'acheteur
    // et des articles remboursés. Pour une ancienne commande (sans frais de service), le total payé
    // est la somme des articles : le calcul est le même qu'avant.
    const chargedTotal = Math.max(Number(charge.amount) || 0, orderTotal);
    // Arrondi vers le bas : le vendeur ne paie jamais plus que sa part
    const feeShare = chargedTotal > 0 ? Math.floor((totalFee * payout.amount_cents) / chargedTotal) : 0;
    const beforeMonthlyFee = payout.amount_cents - payout.commission_cents - feeShare;

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
    const sellerCents = beforeMonthlyFee - monthlyFeeCents;

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
    .select('id, order_id, seller_id, amount_cents, problem_reason, problem_reported_at, pickup_start_at, last_error')
    .eq('status', 'probleme')
    .order('problem_reported_at', { ascending: true })
    .limit(100);
  if (problemsError) throw new Error('Lecture des problèmes impossible : ' + problemsError.message);

  const { data: decided, error: decidedError } = await supabase
    .from('payouts')
    .select('id, order_id, seller_id, amount_cents, problem_reason, problem_reported_at, resolution, resolved_at, resolution_note, refunded_cents, stripe_refund_id')
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
      amount: (Number(r.amount_cents) || 0) / 100,
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

// « Rembourser l'acheteur » : seuls les articles de ce vendeur sont remboursés (jamais les 0,25 € de frais de service).
// Le remboursement part chez Stripe avec une clé anti-doublon : cliquer deux fois ne rembourse jamais deux fois.
async function adminRefund(res, payout, note) {
  if (payout.status === 'rembourse') {
    return res.status(200).json({ status: 'rembourse', alreadyDone: true });
  }
  if (payout.status === 'verse') {
    return res.status(409).json({ error: 'Le vendeur a déjà été payé : ce problème ne peut plus être remboursé ici.' });
  }
  if (payout.status !== 'probleme') {
    return res.status(409).json({ error: "Ce versement n'est pas dans l'état « problème signalé »." });
  }

  const amount = Number(payout.amount_cents);
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
      { idempotencyKey: 'problem-refund-' + payout.id }
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

  const { data: updated, error: updateError } = await supabase
    .from('payouts')
    .update({
      status: 'rembourse',
      resolution: 'rembourse',
      resolved_at: new Date().toISOString(),
      refunded_cents: amount,
      stripe_refund_id: refund.id,
      resolution_note: note || null,
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

    const { action, payoutId, note } = req.body || {};

    if (action === 'admin_list') {
      return res.status(200).json(await adminList());
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
      .select('id, status, order_id, seller_id, amount_cents, stripe_charge_id')
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
// Actions de l'acheteur : "J'ai bien reçu ma commande" / "Signaler un problème"
// ---------------------------------------------------------------------------
async function handleBuyerAction(req, res) {
  try {
    const { action, orderId, sellerId, reason } = req.body || {};

    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Vous devez être connecté.' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData || !userData.user) {
      return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
    }

    if (action !== 'confirm' && action !== 'report') {
      return res.status(400).json({ error: 'Action inconnue.' });
    }
    if (!orderId || !sellerId) {
      return res.status(400).json({ error: 'Commande ou vendeur manquant.' });
    }

    // Signaler un problème demande une explication écrite : 10 caractères au moins, 1000 au plus
    // (la page le vérifie aussi, mais le serveur ne se fie jamais à la page)
    let reasonText = '';
    if (action === 'report') {
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

    const { data: payout, error: payoutError } = await supabase
      .from('payouts')
      .select('id, status, pickup_start_at')
      .eq('order_id', orderId)
      .eq('seller_id', sellerId)
      .maybeSingle();

    if (payoutError) {
      console.error('Erreur Supabase (versement) :', payoutError);
      return res.status(500).json({ error: 'Impossible de lire le versement pour le moment. Réessayez.' });
    }
    if (!payout) {
      return res.status(404).json({ error: 'Aucun versement à confirmer pour ce vendeur.' });
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
    const summary = { found: queue.length, released: 0, failed: 0, skipped: 0, remaining: 0 };

    const budget = process.env.PAYOUTS_TIME_BUDGET_MS !== undefined
      ? Number(process.env.PAYOUTS_TIME_BUDGET_MS)
      : DEFAULT_TIME_BUDGET_MS;
    const deadline = Date.now() + budget;

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
