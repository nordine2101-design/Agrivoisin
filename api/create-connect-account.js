import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { email, address } = req.body;

    // 0. Vérifier que la personne est bien connectée
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Vous devez être connecté pour devenir vendeur.' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    if (userError || !userData.user) {
      return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
    }

    const userId = userData.user.id;

    // 1. Créer un compte Stripe Connect Express pour ce jardinier
    const account = await stripe.accounts.create({
      type: 'express',
      email: email,
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true },
      },
    });

    // 2. Enregistrer ce vendeur dans notre base de données Supabase, lié à son compte connecté
    const { error: dbError } = await supabase
      .from('sellers')
      .insert({ email: email, stripe_account_id: account.id, address: address, user_id: userId });

    if (dbError) {
      console.error('Erreur Supabase :', dbError);
    }

    // 3. Générer le lien d'inscription (onboarding) Stripe pour ce compte
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${req.headers.origin}/vendre.html`,
      return_url: `${req.headers.origin}/vendre-confirmation.html`,
      type: 'account_onboarding',
    });

    res.status(200).json({
      accountId: account.id,
      onboardingUrl: accountLink.url,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
