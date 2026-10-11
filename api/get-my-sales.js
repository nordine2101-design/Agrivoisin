import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// Nombre maximum de ventes renvoyées (les plus récentes)
const MAX_SALES = 100;

// Pour l'estimation de ce que le vendeur recevra : frais d'une carte européenne chez Stripe
// (1,5 % + 0,25 € du paiement total de l'acheteur), et frais de service mensuel du vendeur (2 €)
const CARD_FEE_PERCENT = 0.015;
const CARD_FEE_FIXED_CENTS = 25;
const MONTHLY_FEE_CENTS = 200;

// Le mois d'une vente, à l'heure de Paris (comme dans la base) : « 2026-10 »
function parisMonth(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).slice(0, 7);
}

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
      .select('order_id, listing_id, price_at_purchase, listings(title, unit)')
      .eq('seller_id', seller.id);

    if (itemsError) throw itemsError;

    const orderIds = [...new Set((items || []).map((it) => it.order_id).filter(Boolean))];

    if (orderIds.length === 0) {
      return res.status(200).json({ sales: [] });
    }

    // Les ventes les plus récentes d'abord (seulement la date : rien sur l'acheteur)
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id, created_at, total_amount, service_fee_cents')
      .in('id', orderIds)
      .order('created_at', { ascending: false })
      .limit(MAX_SALES);

    if (ordersError) throw ordersError;

    const shownOrderIds = orders.map((o) => o.id);

    // État de l'argent pour CE vendeur : retenu, en cours de versement, versé ou suspendu
    let payouts = [];
    const { data: payoutsData, error: payoutsError } = await supabase
      .from('payouts')
      .select('order_id, status, auto_release_at, released_at, amount_cents, commission_cents, stripe_fee_cents, monthly_fee_cents, seller_cents')
      .eq('seller_id', seller.id)
      .in('order_id', shownOrderIds);

    if (payoutsError) {
      // Pas bloquant : la page s'affiche, sans l'état de l'argent
      console.error('Erreur Supabase (versements) :', payoutsError);
    } else {
      payouts = payoutsData || [];
    }

    // Les frais de service mensuel de CE vendeur déjà payés, mois par mois (pour estimer ce qu'il recevra).
    // Pas bloquant : si la lecture échoue, on suppose que les 2 € ne sont pas encore payés.
    let feesByMonth = {};
    const months = [...new Set(orders.map((o) => parisMonth(o.created_at)))];
    const { data: feesData, error: feesError } = await supabase
      .from('seller_monthly_fees')
      .select('month, due_cents, collected_cents')
      .eq('seller_id', seller.id)
      .in('month', months);

    if (feesError) {
      console.error('Erreur Supabase (frais de service mensuel) :', feesError);
    } else {
      (feesData || []).forEach((f) => { feesByMonth[f.month] = f; });
    }

    const sales = orders.map((order) => {
      const orderItems = items.filter((it) => it.order_id === order.id);

      // Les articles regroupés par annonce : quantité vendue, unité et montant de la ligne
      const byListing = {};
      let totalCents = 0;
      orderItems.forEach((it) => {
        const key = it.listing_id || 'annonce-supprimee';
        if (!byListing[key]) {
          byListing[key] = {
            title: it.listings ? it.listings.title : 'Annonce supprimée',
            // L'unité de l'annonce (kg par défaut) ; « unité » si l'annonce a été supprimée depuis la vente
            unit: it.listings ? (String(it.listings.unit == null ? '' : it.listings.unit).trim() || 'kg') : 'unité',
            quantity: 0,
            amountCents: 0,
          };
        }
        const cents = Math.round(Number(it.price_at_purchase || 0) * 100);
        byListing[key].quantity += 1;
        byListing[key].amountCents += cents;
        totalCents += cents;
      });

      const payoutRow = payouts.find((p) => p.order_id === order.id);

      // Ce que le vendeur voit de son argent (ses propres chiffres, jamais rien sur l'acheteur) :
      // - argent versé : la commission, les frais retirés et le montant reçu
      // - argent en attente : la commission et ce qui reste après elle (les frais de carte et les 2 € du mois
      //   ne sont connus qu'au versement)
      // - problème signalé : aucun chiffre tant que la situation n'est pas réglée
      const toEuros = (cents) => (Number(cents) || 0) / 100;
      let money = null;
      if (payoutRow && payoutRow.status === 'verse') {
        money = {
          commission: toEuros(payoutRow.commission_cents),
          cardFee: toEuros(payoutRow.stripe_fee_cents),
          monthlyFee: toEuros(payoutRow.monthly_fee_cents),
          received: payoutRow.seller_cents == null ? null : toEuros(payoutRow.seller_cents),
        };
      } else if (payoutRow && (payoutRow.status === 'en_attente' || payoutRow.status === 'en_cours')) {
        const amountCents = Number(payoutRow.amount_cents) || 0;
        const commissionCents = Number(payoutRow.commission_cents) || 0;

        // Estimation (« environ ») : frais de carte au prorata du paiement TOTAL de l'acheteur (articles + frais de
        // service), calculés comme au versement réel, puis les 2 € du mois s'ils ne sont pas déjà payés.
        const chargedCents = Math.max(Math.round(Number(order.total_amount) * 100) || 0, amountCents);
        const totalCardFee = Math.round(chargedCents * CARD_FEE_PERCENT) + CARD_FEE_FIXED_CENTS;
        const cardFeeShare = chargedCents > 0 ? Math.floor((totalCardFee * amountCents) / chargedCents) : 0;
        const beforeMonthlyFee = Math.max(0, amountCents - commissionCents - cardFeeShare);

        const feeRow = feesByMonth[parisMonth(order.created_at)];
        const monthlyFeeDue = Math.max(0, feeRow ? (Number(feeRow.due_cents) || 0) - (Number(feeRow.collected_cents) || 0) : MONTHLY_FEE_CENTS);

        money = {
          commission: toEuros(commissionCents),
          afterCommission: toEuros(amountCents - commissionCents),
          estimate: {
            received: toEuros(beforeMonthlyFee),
            // Seulement s'il reste des frais de service du mois à payer : ce que le vendeur recevrait si cette vente est la prochaine versée
            receivedWithMonthlyFee: monthlyFeeDue > 0 ? toEuros(beforeMonthlyFee - Math.min(monthlyFeeDue, beforeMonthlyFee)) : null,
            monthlyFeeDue: toEuros(monthlyFeeDue),
          },
        };
      }

      return {
        createdAt: order.created_at,
        items: Object.values(byListing).map((l) => ({
          title: l.title,
          unit: l.unit,
          quantity: l.quantity,
          amount: l.amountCents / 100,
        })),
        totalAmount: totalCents / 100,
        payout: payoutRow
          ? { status: payoutRow.status, autoReleaseAt: payoutRow.auto_release_at, releasedAt: payoutRow.released_at, money }
          : null,
      };
    });

    res.status(200).json({ sales });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
