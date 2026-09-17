import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { email } = req.body;

    // 1. Créer un compte Stripe Connect Express pour ce jardinier
    const account = await stripe.accounts.create({
      type: 'express',
      email: email,
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true },
      },
    });

    // 2. Générer le lien d'inscription (onboarding) Stripe pour ce compte
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
