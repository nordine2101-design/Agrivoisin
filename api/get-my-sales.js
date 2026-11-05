import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// Nombre maximum de ventes renvoyées (les plus récentes)
const MAX_SALES = 100;

// Frais de service mensuel d'un vendeur actif : 2 €, retirés une seule fois par mois
const MONTHLY_FEE_CENTS = 200;

// Retrait avec code : 5 codes faux et le retrait est bloqué ; l'argent est libéré 24 h après la saisie du bon code
const MAX_CODE_ATTEMPTS = 5;
const RELEASE_AFTER_PICKUP_HOURS = 24;

// Une commande expédiée : l'argent rejoint le compte de paiement 14 jours après l'envoi du colis
const SHIPPED_RELEASE_DAYS = 14;
// Forfait d'Agrivoisin par commande expédiée (déjà compris dans la commission enregistrée)
const SHIPPING_FLAT_FEE_CENTS = 50;

// Découpe d'une commande expédiée en colis : le même calcul que celui du paiement (api/create-checkout-session.js).
// Chaque colis tombe dans un palier du vendeur ; s'il accepte plusieurs colis, on prend la découpe la moins chère
// (à prix égal : le moins de colis, puis des colis de tailles proches). Renvoie la liste des quantités, ou null.
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
  if (!allowMulti || quantity > 500) return single === null ? null : [quantity];

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

  const k = count[quantity];
  const base = Math.floor(quantity / k);
  const extra = quantity - base * k;
  const balanced = [];
  for (let i = 0; i < k; i++) balanced.push(base + (i < extra ? 1 : 0));
  const balancedPrices = balanced.map(priceOf);
  if (balancedPrices.every((x) => x !== null) && balancedPrices.reduce((a, b) => a + b, 0) === cost[quantity]) {
    return balanced.sort((a, b) => b - a);
  }

  const parcels = [];
  let rest = quantity;
  while (rest > 0) {
    parcels.push(prev[rest]);
    rest -= prev[rest];
  }
  return parcels.sort((a, b) => b - a);
}

// Le vendeur déclare que le colis est parti (avec, s'il le souhaite, un numéro de suivi)
async function markShipped(req, res, seller) {
  const body = req.body || {};
  const orderId = String(body.orderId == null ? '' : body.orderId).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) {
    return res.status(400).json({ error: 'Commande inconnue.' });
  }

  const tracking = String(body.trackingNumber == null ? '' : body.trackingNumber).replace(/\s+/g, ' ').trim();
  if (tracking.length > 40 || (tracking && !/^[A-Za-z0-9][A-Za-z0-9 \-]*$/.test(tracking))) {
    return res.status(400).json({ error: 'Le numéro de suivi ne doit contenir que des lettres, des chiffres et des tirets (40 caractères au plus).' });
  }

  const { data: payout, error: payoutError } = await supabase
    .from('payouts')
    .select('id, status, shipping_cents, shipped_at')
    .eq('seller_id', seller.id)
    .eq('order_id', orderId)
    .gt('shipping_cents', 0)
    .maybeSingle();
  if (payoutError) {
    console.error('Erreur Supabase (colis parti) :', payoutError.message);
    return res.status(500).json({ error: "Impossible d'enregistrer l'envoi pour le moment. Réessayez." });
  }
  if (!payout || !(Number(payout.shipping_cents) > 0)) {
    return res.status(404).json({ error: "Cette vente n'est pas une commande à expédier." });
  }
  if (payout.shipped_at) {
    return res.status(409).json({ error: 'Cet envoi est déjà enregistré.' });
  }
  if (payout.status !== 'en_attente') {
    return res.status(409).json({ error: "Cette vente ne peut plus être modifiée." });
  }

  const shippedAt = new Date();
  const releaseAt = new Date(shippedAt.getTime() + SHIPPED_RELEASE_DAYS * 24 * 60 * 60 * 1000);
  // Condition « pas encore expédié » dans la requête : deux clics ne comptent qu'une fois
  const { data: updated, error: updateError } = await supabase
    .from('payouts')
    .update({ shipped_at: shippedAt.toISOString(), tracking_number: tracking || null, auto_release_at: releaseAt.toISOString() })
    .eq('id', payout.id)
    .eq('status', 'en_attente')
    .is('shipped_at', null)
    .select('id');
  if (updateError) {
    console.error('Erreur Supabase (colis parti) :', updateError.message);
    return res.status(500).json({ error: "Impossible d'enregistrer l'envoi pour le moment. Réessayez." });
  }
  if (!updated || updated.length === 0) {
    return res.status(409).json({ error: 'Cet envoi est déjà enregistré.' });
  }

  return res.status(200).json({ shipment: { shippedAt: shippedAt.toISOString(), trackingNumber: tracking || null, autoReleaseAt: releaseAt.toISOString() } });
}

// Un moment à l'heure de Paris : « samedi 7 novembre à 18 h 00 »
function formatParisMoment(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
  const time = d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).replace(':', ' h ');
  return date + ' à ' + time;
}

// Le vendeur tape les 4 chiffres donnés par l'acheteur : la commande est alors « retirée »
// et l'argent sera libéré 24 h plus tard (le temps, pour l'acheteur, de signaler un problème).
async function confirmPickup(req, res, seller) {
  const body = req.body || {};
  const payoutId = String(body.payoutId == null ? '' : body.payoutId).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(payoutId)) {
    return res.status(400).json({ error: 'Retrait inconnu.' });
  }
  const code = String(body.code == null ? '' : body.code).replace(/\s+/g, '');
  if (!/^\d{4}$/.test(code)) {
    return res.status(400).json({ error: 'Le code comporte 4 chiffres.' });
  }

  const columns = 'id, status, pickup_code, pickup_start_at, picked_up_at, code_attempts';
  const { data: first, error: readError } = await supabase
    .from('payouts')
    .select(columns)
    .eq('id', payoutId)
    .eq('seller_id', seller.id)
    .maybeSingle();
  if (readError) {
    console.error('Erreur Supabase (code de retrait) :', readError.message);
    return res.status(500).json({ error: 'Impossible de vérifier le code pour le moment. Réessayez.' });
  }
  if (!first || !first.pickup_code) {
    return res.status(404).json({ error: "Ce retrait est introuvable." });
  }
  if (first.picked_up_at) {
    return res.status(409).json({ error: 'Cette commande est déjà marquée comme retirée.' });
  }
  if (first.status !== 'en_attente') {
    return res.status(409).json({ error: 'Cette vente ne peut plus être modifiée.' });
  }
  if (first.pickup_start_at && new Date(first.pickup_start_at).getTime() > Date.now()) {
    return res.status(409).json({ error: 'Le code pourra être saisi à partir du ' + formatParisMoment(first.pickup_start_at) + '.' });
  }

  // Chaque essai est compté AVANT d'être vérifié : plusieurs essais envoyés en même temps ne contournent pas la limite
  let attempts = Number(first.code_attempts) || 0;
  let reserved = false;
  for (let i = 0; i < 5 && !reserved; i += 1) {
    if (attempts >= MAX_CODE_ATTEMPTS) {
      return res.status(423).json({ error: "Trop de codes incorrects : ce retrait est bloqué. Écrivez-nous depuis la page Contact.", locked: true, attemptsLeft: 0 });
    }
    const { data: bumped, error: bumpError } = await supabase
      .from('payouts')
      .update({ code_attempts: attempts + 1 })
      .eq('id', payoutId)
      .eq('code_attempts', attempts)
      .select('id');
    if (bumpError) {
      console.error('Erreur Supabase (essai de code) :', bumpError.message);
      return res.status(500).json({ error: 'Impossible de vérifier le code pour le moment. Réessayez.' });
    }
    if (bumped && bumped.length > 0) {
      reserved = true;
      attempts += 1;
    } else {
      const { data: again } = await supabase.from('payouts').select('code_attempts').eq('id', payoutId).maybeSingle();
      attempts = again ? Number(again.code_attempts) || 0 : attempts;
    }
  }
  if (!reserved) {
    return res.status(429).json({ error: 'Trop de demandes en même temps. Réessayez dans un instant.' });
  }

  if (code !== first.pickup_code) {
    const left = Math.max(0, MAX_CODE_ATTEMPTS - attempts);
    if (left === 0) {
      return res.status(423).json({ error: "Code incorrect. Trop d'essais : ce retrait est bloqué. Écrivez-nous depuis la page Contact.", locked: true, attemptsLeft: 0 });
    }
    return res.status(400).json({ error: 'Code incorrect. Il reste ' + left + (left > 1 ? ' essais.' : ' essai.'), attemptsLeft: left });
  }

  const pickedUpAt = new Date();
  const releaseAt = new Date(pickedUpAt.getTime() + RELEASE_AFTER_PICKUP_HOURS * 60 * 60 * 1000);
  // Conditions « en attente » et « pas encore retiré » dans la requête : deux validations ne comptent qu'une fois
  const { data: updated, error: updateError } = await supabase
    .from('payouts')
    .update({ picked_up_at: pickedUpAt.toISOString(), auto_release_at: releaseAt.toISOString() })
    .eq('id', payoutId)
    .eq('status', 'en_attente')
    .is('picked_up_at', null)
    .select('id');
  if (updateError) {
    console.error('Erreur Supabase (retrait confirmé) :', updateError.message);
    return res.status(500).json({ error: "Impossible d'enregistrer le retrait pour le moment. Réessayez." });
  }
  if (!updated || updated.length === 0) {
    return res.status(409).json({ error: 'Cette commande est déjà marquée comme retirée.' });
  }

  return res.status(200).json({ pickup: { payoutId, pickedUpAt: pickedUpAt.toISOString(), autoReleaseAt: releaseAt.toISOString() } });
}

// Le mois d'une vente, à l'heure de Paris (comme dans la base) : « 2026-10 »
function parisMonth(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).slice(0, 7);
}

// ---------------------------------------------------------------------------
// Informations fiscales d'un vendeur particulier (règle européenne DAC7).
// Agrivoisin les demande quand le vendeur approche des seuils : 20 ventes ou 1 500 € dans l'année.
// Les professionnels donnent les informations de leur entreprise à l'inscription : rien à leur demander ici.
// Cette page ne renvoie jamais le contenu des informations, seulement l'état de la demande.
// ---------------------------------------------------------------------------
const FISCAL_NEAR_SALES = 20;
const FISCAL_NEAR_CENTS = 150000;

// Date d'aujourd'hui à Paris, « AAAA-MM-JJ »
function todayInParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

// Année civile d'une date, à l'heure de Paris
function parisYearOf(iso) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric' }).format(new Date(iso)));
}

// Ventes de l'année de CE vendeur : une vente = un versement, hors versements entièrement remboursés,
// les remboursements partiels étant retirés du montant (même règle que la page de suivi fiscal de l'administrateur)
async function loadYearTotals(sellerId) {
  const year = Number(todayInParis().slice(0, 4));
  const since = new Date(Date.UTC(year - 1, 11, 30)).toISOString();
  let salesCount = 0;
  let totalCents = 0;
  const PAGE = 1000;
  for (let page = 0; page < 20; page += 1) {
    const { data, error } = await supabase
      .from('payouts')
      .select('amount_cents, refunded_cents, status, created_at')
      .eq('seller_id', sellerId)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error('Lecture des ventes impossible : ' + error.message);
    (data || []).forEach((row) => {
      if (row.status === 'rembourse') return;
      if (parisYearOf(row.created_at) !== year) return;
      salesCount += 1;
      totalCents += Math.max(0, (Number(row.amount_cents) || 0) - (Number(row.refunded_cents) || 0));
    });
    if (!data || data.length < PAGE) break;
  }
  return { salesCount, totalCents };
}

// État de la demande d'informations fiscales pour ce vendeur :
// « none » = rien à demander, « needed » = à renseigner (avec la date de la demande), « received » = déjà reçues.
// La première fois que le seuil est atteint, la date de la demande est enregistrée.
async function loadTaxRequest(seller) {
  if (seller.seller_type === 'professionnel') return { status: 'none' };

  const { data: row, error: rowError } = await supabase
    .from('seller_tax_info')
    .select('requested_at, collected_at')
    .eq('seller_id', seller.id)
    .maybeSingle();
  if (rowError) throw new Error('Lecture des informations fiscales impossible : ' + rowError.message);

  if (row && row.collected_at) return { status: 'received', date: row.collected_at };

  let requestedAt = row ? row.requested_at : null;
  if (!requestedAt) {
    const totals = await loadYearTotals(seller.id);
    const reached = totals.salesCount >= FISCAL_NEAR_SALES || totals.totalCents >= FISCAL_NEAR_CENTS;
    if (!reached) return { status: 'none' };

    requestedAt = new Date().toISOString();
    const saved = row
      ? await supabase.from('seller_tax_info').update({ requested_at: requestedAt }).eq('seller_id', seller.id)
      : await supabase.from('seller_tax_info').insert({ seller_id: seller.id, requested_at: requestedAt });
    if (saved.error) throw new Error('Enregistrement de la demande impossible : ' + saved.error.message);
  }
  return { status: 'needed', date: requestedAt };
}

// Enregistre les informations fiscales envoyées par le vendeur (seulement si elles lui ont été demandées)
async function saveTaxInfo(req, res, seller) {
  if (seller.seller_type === 'professionnel') {
    return res.status(400).json({ error: "Ces informations ne sont demandées qu'aux vendeurs particuliers." });
  }

  const body = req.body || {};
  const clean = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

  const legalName = clean(body.legalName, 120);
  if (legalName.length < 2 || !/\p{L}/u.test(legalName)) {
    return res.status(400).json({ error: 'Indiquez votre nom et votre prénom.' });
  }

  const birthDate = String(body.birthDate == null ? '' : body.birthDate).trim();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  const parsed = dateMatch ? new Date(Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]))) : null;
  const validDate = parsed
    && parsed.getUTCFullYear() === Number(dateMatch[1])
    && parsed.getUTCMonth() === Number(dateMatch[2]) - 1
    && parsed.getUTCDate() === Number(dateMatch[3])
    && birthDate >= '1900-01-01'
    && birthDate <= todayInParis();
  if (!validDate) {
    return res.status(400).json({ error: 'Indiquez une date de naissance valide.' });
  }

  const taxId = String(body.taxId == null ? '' : body.taxId).replace(/\s+/g, '');
  if (taxId && !/^\d{13}$/.test(taxId)) {
    return res.status(400).json({ error: 'Le numéro fiscal doit comporter 13 chiffres.' });
  }

  const birthPlace = clean(body.birthPlace, 100);
  if (!taxId && birthPlace.length < 2) {
    return res.status(400).json({ error: "Indiquez votre numéro fiscal ou, à défaut, votre lieu de naissance." });
  }

  const request = await loadTaxRequest(seller);
  if (request.status === 'received') {
    return res.status(409).json({ error: 'Vos informations ont déjà été reçues. Pour les modifier, écrivez-nous depuis la page Contact.' });
  }
  if (request.status !== 'needed') {
    return res.status(403).json({ error: "Ces informations ne vous sont pas demandées pour le moment." });
  }

  const collectedAt = new Date().toISOString();
  const { error: saveError } = await supabase
    .from('seller_tax_info')
    .update({
      legal_name: legalName,
      birth_date: birthDate,
      birth_place: birthPlace || null,
      tax_country: 'FR',
      tax_id: taxId || null,
      collected_at: collectedAt,
    })
    .eq('seller_id', seller.id);
  if (saveError) {
    console.error('Erreur Supabase (informations fiscales) :', saveError.message);
    return res.status(500).json({ error: "Impossible d'enregistrer vos informations pour le moment. Réessayez." });
  }

  return res.status(200).json({ taxInfo: { status: 'received', date: collectedAt } });
}

export default async function handler(req, res) {
  // GET : les ventes du vendeur ; POST : l'envoi de ses informations fiscales, la déclaration d'un colis parti ou le code de retrait
  if (req.method !== 'GET' && req.method !== 'POST') {
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
      .select('id, seller_type')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (sellerError || !seller) {
      return res.status(400).json({ error: "Aucun compte vendeur trouvé pour ce compte. Devenez d'abord vendeur." });
    }

    if (req.method === 'POST') {
      const action = req.body && req.body.action;
      if (action === 'save_tax_info') {
        return await saveTaxInfo(req, res, seller);
      }
      if (action === 'mark_shipped') {
        return await markShipped(req, res, seller);
      }
      if (action === 'confirm_pickup') {
        return await confirmPickup(req, res, seller);
      }
      return res.status(400).json({ error: 'Action inconnue.' });
    }

    // Demande d'informations fiscales (pas bloquant : si la lecture échoue, la page affiche quand même les ventes)
    let taxInfo = { status: 'none' };
    try {
      taxInfo = await loadTaxRequest(seller);
    } catch (taxError) {
      console.error('Informations fiscales :', taxError.message);
    }

    // Les articles vendus par CE vendeur (jamais l'identité de l'acheteur)
    const { data: items, error: itemsError } = await supabase
      .from('order_items')
      .select('order_id, listing_id, payout_id, price_at_purchase, delivery_mode, listings(title, unit, shipping_tiers, multi_parcel)')
      .eq('seller_id', seller.id);

    if (itemsError) throw itemsError;

    const orderIds = [...new Set((items || []).map((it) => it.order_id).filter(Boolean))];

    if (orderIds.length === 0) {
      return res.status(200).json({ sales: [], taxInfo });
    }

    // Les ventes les plus récentes d'abord (seulement la date : rien sur l'acheteur)
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id, created_at, shipping_address')
      .in('id', orderIds)
      .order('created_at', { ascending: false })
      .limit(MAX_SALES);

    if (ordersError) throw ordersError;

    const shownOrderIds = orders.map((o) => o.id);

    // État de l'argent pour CE vendeur : retenu, en cours de versement, versé ou suspendu
    let payouts = [];
    const { data: payoutsData, error: payoutsError } = await supabase
      .from('payouts')
      .select('id, order_id, status, auto_release_at, pickup_start_at, pickup_end_at, picked_up_at, code_attempts, released_at, amount_cents, shipping_cents, shipped_at, tracking_number, commission_cents, stripe_fee_cents, monthly_fee_cents, seller_cents')
      .eq('seller_id', seller.id)
      .in('order_id', shownOrderIds);

    if (payoutsError) {
      // Pas bloquant : la page s'affiche, sans l'état de l'argent
      console.error('Erreur Supabase (versements) :', payoutsError);
    } else {
      payouts = payoutsData || [];
    }

    // Les frais de service mensuel de CE vendeur déjà payés, mois par mois (pour dire ce qu'il reste à payer).
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
            shipped: it.delivery_mode === 'expedition',
            tiers: it.listings && Array.isArray(it.listings.shipping_tiers) ? it.listings.shipping_tiers : [],
            multi: true, // plusieurs colis toujours possibles
          };
        }
        const cents = Math.round(Number(it.price_at_purchase || 0) * 100);
        byListing[key].quantity += 1;
        byListing[key].amountCents += cents;
        totalCents += cents;
      });

      // Plusieurs versements possibles sur une commande : un par créneau de retrait, un pour l'expédition
      const orderPayouts = payouts.filter((p) => p.order_id === order.id);
      const isSlot = (p) => !!p.pickup_end_at && !(Number(p.shipping_cents) > 0);
      const slotPayouts = orderPayouts
        .filter(isSlot)
        .sort((x, y) => new Date(x.pickup_start_at) - new Date(y.pickup_start_at));
      // Le versement « sans créneau » : l'expédition en priorité, sinon une ancienne vente sans horaires
      const payoutRow = orderPayouts.find((p) => Number(p.shipping_cents) > 0) || orderPayouts.find((p) => !isSlot(p)) || null;

      // Ce que le vendeur voit de son argent (ses propres chiffres, jamais rien sur l'acheteur) :
      // - argent versé : la commission, les frais retirés et le montant reçu
      // - argent en attente : la commission, les vrais frais de carte (relevés chez Stripe dès le paiement),
      //   le montant exact de la vente, et ce qui reste à payer des 2 € du mois
      // - problème signalé : aucun chiffre tant que la situation n'est pas réglée
      const toEuros = (cents) => (Number(cents) || 0) / 100;
      const moneyFor = (row) => {
        if (!row) return null;
        // Expédition : les frais d'expédition de CE vendeur, et le forfait d'Agrivoisin (compris dans la commission enregistrée)
        const rowShippingCents = Number(row.shipping_cents) || 0;
        const flatFeeCents = rowShippingCents > 0 ? Math.min(SHIPPING_FLAT_FEE_CENTS, rowShippingCents) : 0;
        if (row.status === 'verse') {
          return {
            commission: toEuros((Number(row.commission_cents) || 0) - flatFeeCents),
            flatFee: toEuros(flatFeeCents),
            cardFee: toEuros(row.stripe_fee_cents),
            monthlyFee: toEuros(row.monthly_fee_cents),
            received: row.seller_cents == null ? null : toEuros(row.seller_cents),
          };
        }
        if (row.status === 'en_attente' || row.status === 'en_cours') {
          const amountCents = Number(row.amount_cents) || 0;
          const commissionCents = Number(row.commission_cents) || 0;
          // Ce que l'acheteur a payé à ce vendeur : les articles + l'expédition
          const grossCents = amountCents + rowShippingCents;

          // Les frais de carte RÉELS, relevés chez Stripe dès le paiement (jamais une supposition).
          // S'ils ne sont pas encore connus : rien n'est affiché à leur place.
          const cardFeeKnown = row.stripe_fee_cents !== null && row.stripe_fee_cents !== undefined;
          const cardFeeCents = cardFeeKnown ? Number(row.stripe_fee_cents) || 0 : 0;

          // Ce qui reste à payer des 2 € de frais de service de ce mois (le mois de la vente, à l'heure de Paris)
          const feeRow = feesByMonth[parisMonth(order.created_at)];
          const monthlyFeeDue = Math.max(0, feeRow ? (Number(feeRow.due_cents) || 0) - (Number(feeRow.collected_cents) || 0) : MONTHLY_FEE_CENTS);

          return {
            commission: toEuros(commissionCents - flatFeeCents),
            flatFee: toEuros(flatFeeCents),
            afterCommission: toEuros(grossCents - commissionCents),
            // Exact : la vente moins la commission moins les vrais frais de carte (jamais en dessous de 0)
            cardFee: cardFeeKnown ? toEuros(cardFeeCents) : null,
            saleAmount: cardFeeKnown ? toEuros(Math.max(0, grossCents - commissionCents - cardFeeCents)) : null,
            // Les 2 € du mois restent en ligne séparée : retirés une seule fois, du premier versement du mois
            monthlyFeeDue: toEuros(monthlyFeeDue),
          };
        }
        return null;
      };
      const shippingCents = payoutRow ? Number(payoutRow.shipping_cents) || 0 : 0;
      const money = moneyFor(payoutRow);

      // Les retraits : un bloc par créneau, avec ses produits (le code n'est JAMAIS renvoyé au vendeur)
      const nowMs = Date.now();
      const slots = slotPayouts.map((p) => {
        const slotItems = {};
        orderItems.filter((it) => it.payout_id === p.id).forEach((it) => {
          const key = it.listing_id || 'annonce-supprimee';
          if (!slotItems[key]) {
            slotItems[key] = { title: byListing[key].title, unit: byListing[key].unit, quantity: 0 };
          }
          slotItems[key].quantity += 1;
        });
        const attempts = Number(p.code_attempts) || 0;
        return {
          payoutId: p.id,
          startAt: p.pickup_start_at,
          endAt: p.pickup_end_at,
          started: new Date(p.pickup_start_at).getTime() <= nowMs,
          status: p.status,
          pickedUpAt: p.picked_up_at || null,
          autoReleaseAt: p.auto_release_at || null,
          releasedAt: p.released_at || null,
          locked: attempts >= MAX_CODE_ATTEMPTS,
          attemptsLeft: Math.max(0, MAX_CODE_ATTEMPTS - attempts),
          items: Object.values(slotItems),
          money: moneyFor(p),
        };
      });

      // L'expédition : l'adresse n'est montrée que tant que le colis n'est pas parti
      let shipment = null;
      if (shippingCents > 0) {
        const a = order.shipping_address && typeof order.shipping_address === 'object' ? order.shipping_address : null;
        const toShip = payoutRow.status === 'en_attente' && !payoutRow.shipped_at;
        shipment = {
          shippingAmount: shippingCents / 100,
          shippedAt: payoutRow.shipped_at || null,
          trackingNumber: payoutRow.tracking_number || null,
          address: toShip && a
            ? { name: a.name || '', address: a.address || '', address2: a.address2 || '', postalCode: a.postal_code || '', city: a.city || '', country: a.country || 'France', phone: a.phone || '' }
            : null,
        };
      }

      return {
        orderId: order.id,
        createdAt: order.created_at,
        items: Object.values(byListing).map((l) => ({
          title: l.title,
          unit: l.unit,
          quantity: l.quantity,
          amount: l.amountCents / 100,
          shipped: l.shipped,
          // Si la commande part en plusieurs colis : la quantité de chaque colis (sinon rien)
          parcels: (() => {
            if (!l.shipped) return null;
            const plan = planParcels(l.tiers, l.quantity, l.multi);
            return plan && plan.length > 1 ? plan : null;
          })(),
        })),
        goodsAmount: totalCents / 100,
        totalAmount: (totalCents + shippingCents) / 100,
        shipment,
        slots,
        payout: payoutRow
          ? { status: payoutRow.status, autoReleaseAt: payoutRow.auto_release_at, releasedAt: payoutRow.released_at, money }
          : null,
      };
    });

    res.status(200).json({ sales, taxInfo });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
