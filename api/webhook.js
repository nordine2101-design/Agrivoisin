import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const config = {
  api: {
    bodyParser: false,
  },
};

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Méthode non autorisée');
  }

  let event;

  try {
    const rawBody = await buffer(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Erreur de vérification du webhook :', err.message);
    return res.status(400).send(`Erreur webhook : ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const transfersRaw = session.metadata?.transfers || '';

    if (transfersRaw) {
      const transfers = transfersRaw.split(',').filter(Boolean);

      for (const entry of transfers) {
        const [accountId, amount] = entry.split(':');

        try {
          await stripe.transfers.create({
            amount: parseInt(amount, 10),
            currency: 'eur',
            destination: accountId,
          });
          console.log(`Transfert de ${amount} centimes envoyé à ${accountId}`);
        } catch (transferError) {
          console.error(`Erreur de transfert vers ${accountId} :`, transferError.message);
        }
      }
    }
  }

  res.status(200).json({ received: true });
}
