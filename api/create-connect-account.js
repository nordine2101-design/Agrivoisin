import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// --- Vérification ville + code postal (annuaire officiel des communes) ---
function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bsainte\b/g, 'ste');
}

function nameMatches(typed, official) {
  if (typed.length < 3) return false;
  return (
    official === typed ||
    official.startsWith(typed + ' ') ||
    typed.startsWith(official + ' ')
  );
}

async function lookupCommune(city, postalCode) {
  const typed = normalizeName(city);
  const cp = String(postalCode || '').trim();

  if (!typed) {
    return { ok: false, status: 400, error: 'Indiquez le nom de votre ville ou village.' };
  }
  if (!/^\d{5}$/.test(cp)) {
    return { ok: false, status: 400, error: 'Le code postal doit comporter 5 chiffres.' };
  }

  let communes;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(
      `https://geo.api.gouv.fr/communes?codePostal=${cp}&fields=nom,centre&format=json`,
      { signal: controller.signal, headers: { Accept: 'application/json' } }
    );
    if (!response.ok) {
      throw new Error('Réponse ' + response.status);
    }
    communes = await response.json();
  } catch (err) {
    console.error('Erreur annuaire des communes :', err);
    return {
      ok: false,
      status: 503,
      error: 'Le service de vérification des communes est momentanément indisponible. Réessayez dans quelques instants.',
    };
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(communes) || communes.length === 0) {
    return { ok: false, status: 400, error: 'Ce code postal est introuvable. Vérifiez-le.' };
  }

  const match = communes.find((c) => nameMatches(typed, normalizeName(c.nom)));

  if (!match) {
    const names = communes.map((c) => c.nom).join(', ');
    return {
      ok: false,
      status: 400,
      error: `Ce code postal correspond à : ${names}. Vérifiez le nom de votre ville ou village.`,
    };
  }

  const coords = match.centre && match.centre.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    return {
      ok: false,
      status: 503,
      error: 'Position de la commune indisponible pour le moment. Réessayez dans quelques instants.',
    };
  }

  return { ok: true, city: match.nom, latitude: coords[1], longitude: coords[0] };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { email, city, postalCode, address } = req.body;

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

    // 1. Vérifier la ville et le code postal AVANT de créer quoi que ce soit chez Stripe.
    //    La position enregistrée est celle de la commune (jamais l'adresse exacte).
    const commune = await lookupCommune(city, postalCode);
    if (!commune.ok) {
      return res.status(commune.status).json({ error: commune.error });
    }
    const { latitude, longitude } = commune;

    // 2. Cette personne est-elle déjà vendeuse ? (évite de créer des comptes en double)
    const { data: existingSeller, error: lookupError } = await supabase
      .from('sellers')
      .select('id, stripe_account_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    if (lookupError) {
      console.error('Erreur Supabase (recherche du vendeur) :', lookupError);
      return res.status(500).json({
        error: 'Impossible de vérifier votre compte vendeur pour le moment. Réessayez dans quelques instants.',
      });
    }

    // 3. Compte Stripe Connect Express : on réutilise celui qui existe, sinon on en crée un
    let stripeAccountId = existingSeller ? existingSeller.stripe_account_id : null;
    let createdStripeAccount = false;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: email,
        capabilities: {
          transfers: { requested: true },
          card_payments: { requested: true },
        },
      });
      stripeAccountId = account.id;
      createdStripeAccount = true;
    }

    // 4. Enregistrer (ou mettre à jour) ce vendeur dans notre base de données Supabase
    let dbError = null;

    if (existingSeller) {
      const changes = {
        city: commune.city,
        address: address,
        latitude: latitude,
        longitude: longitude,
      };
      if (createdStripeAccount) {
        changes.stripe_account_id = stripeAccountId;
      }
      const result = await supabase.from('sellers').update(changes).eq('id', existingSeller.id);
      dbError = result.error;
    } else {
      const result = await supabase
        .from('sellers')
        .insert({
          email: email,
          stripe_account_id: stripeAccountId,
          city: commune.city,
          address: address,
          latitude: latitude,
          longitude: longitude,
          user_id: userId,
        });
      dbError = result.error;
    }

    if (dbError) {
      console.error('Erreur Supabase (enregistrement du vendeur) :', dbError);

      // On ne laisse pas traîner un compte Stripe que l'on vient de créer pour rien
      if (createdStripeAccount) {
        try {
          await stripe.accounts.del(stripeAccountId);
        } catch (deleteError) {
          console.error('Impossible de supprimer le compte Stripe créé :', deleteError);
        }
      }

      return res.status(500).json({
        error: "Impossible d'enregistrer votre compte vendeur pour le moment. Réessayez dans quelques instants.",
      });
    }

    // 5. Générer le lien d'inscription (onboarding) Stripe pour ce compte
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${req.headers.origin}/vendre.html`,
      return_url: `${req.headers.origin}/vendre-confirmation.html`,
      type: 'account_onboarding',
    });

    res.status(200).json({
      accountId: stripeAccountId,
      onboardingUrl: accountLink.url,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
