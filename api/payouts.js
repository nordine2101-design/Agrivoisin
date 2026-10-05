import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// Un versement "en cours" depuis plus d'une heure après son échéance est considéré comme bloqué et repris
const STUCK_AFTER_MS = 60 * 60 * 1000;
// Nombre maximum de versements traités à chaque passage automatique
const BATCH_SIZE = 50;
// Temps maximum consacré à un passage automatique (en millisecondes)
const DEFAULT_TIME_BUDGET_MS = 50000;

// ---------------------------------------------------------------------------
// Verse l'argent d'un versement au vendeur (commission et frais Stripe déduits).
// fromStatuses : états dans lesquels le versement peut être pris en charge.
// Sûr même en cas de double demande : un seul traitement peut réserver le versement.
// ---------------------------------------------------------------------------
async function releasePayout(payoutId, fromStatuses) {
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
    // Arrondi vers le bas : le vendeur ne paie jamais plus que sa part
    const feeShare = orderTotal > 0 ? Math.floor((totalFee * payout.amount_cents) / orderTotal) : 0;
    const sellerCents = payout.amount_cents - payout.commission_cents - feeShare;

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

    // On le remet en attente pour qu'il soit retenté (la raison est gardée)
    await supabase
      .from('payouts')
      .update({ status: 'en_attente', last_error: String(err.message).slice(0, 500) })
      .eq('id', payout.id);

    return { ok: false, reason: 'error', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Actions de l'acheteur : "J'ai bien reçu ma commande" / "Signaler un problème"
// ---------------------------------------------------------------------------
async function handleBuyerAction(req, res) {
  try {
    const { action, orderId, sellerId } = req.body || {};

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
      .select('id, status')
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

    const { data: updated, error: reportError } = await supabase
      .from('payouts')
      .update({ status: 'probleme', problem_reported_at: new Date().toISOString() })
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
    return handleBuyerAction(req, res);
  }
  return res.status(405).json({ error: 'Méthode non autorisée' });
}
