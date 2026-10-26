import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// Les vendeurs sont virés à leur banque une seule fois par mois, le 5 :
// Stripe garde leur argent sur leur compte de paiement et le vire ce jour-là.
const MONTHLY_PAYOUT_DAY = 5;

// --- Vérification ville + code postal (annuaire officiel des communes) ---
function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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

// --- Pseudo affiché aux acheteurs ---
// 3 à 20 caractères : lettres, chiffres, espaces et tirets ; ni espace ni tiret au début ou à la fin.
// Vide = pas de pseudo : cleanPseudo l'accepte (la vérification GET s'en sert), mais un vendeur doit toujours en avoir un
// (voir PSEUDO_REQUIRED_ERROR plus bas).
const PSEUDO_ERROR =
  'Le pseudo doit comporter de 3 à 20 caractères (lettres, chiffres, espaces ou tirets), sans espace ni tiret au début ou à la fin.';

function cleanPseudo(raw) {
  if (raw == null || String(raw).trim() === '') {
    return { ok: true, pseudo: null };
  }
  const pseudo = String(raw).trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9À-ÿ][A-Za-z0-9À-ÿ -]{1,18}[A-Za-z0-9À-ÿ]$/.test(pseudo)) {
    return { ok: false, status: 400, error: PSEUDO_ERROR };
  }
  return { ok: true, pseudo };
}

// Ce pseudo est-il déjà pris par un autre vendeur ? (majuscules et minuscules comptent pareil)
async function isPseudoTaken(pseudo, ownSellerId) {
  const { data, error } = await supabase.from('sellers').select('id').ilike('pseudo', pseudo).limit(1);
  if (error) {
    console.error('Erreur Supabase (vérification du pseudo) :', error);
    return { error: true };
  }
  return { taken: !!(data && data.length > 0 && (!ownSellerId || data[0].id !== ownSellerId)) };
}

const PSEUDO_REQUIRED_ERROR = 'Choisissez un pseudo : il est obligatoire pour vendre sur Agrivoisin.';
const PSEUDO_TAKEN_ERROR = 'Ce pseudo est déjà pris. Choisissez-en un autre.';
const PSEUDO_CHECK_ERROR = 'Impossible de vérifier le pseudo pour le moment. Réessayez dans quelques instants.';

// --- Vérification du numéro SIRET d'un professionnel ---
// 1) la clé de contrôle (algorithme de Luhn) : détecte une faute de frappe ;
// 2) le registre officiel des entreprises (API publique et gratuite de l'État) : le numéro existe-t-il, et l'établissement est-il toujours en activité ?
// Si le registre ne répond pas (panne, lenteur), on n'empêche pas l'inscription : seule la clé de contrôle compte alors.
function siretKeyIsValid(siret) {
  if (!/^\d{14}$/.test(siret)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    let digit = Number(siret[i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  if (sum % 10 === 0) return true;
  // Cas particulier connu : les établissements de La Poste (SIREN 356 000 000) suivent une autre règle
  if (siret.startsWith('356000000')) {
    const total = siret.split('').reduce((acc, d) => acc + Number(d), 0);
    return total % 5 === 0;
  }
  return false;
}

async function checkSiret(siret) {
  if (!siretKeyIsValid(siret)) {
    return { ok: false, status: 400, error: "Ce numéro SIRET n'est pas valide : vérifiez que vous avez bien recopié les 14 chiffres." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(
      'https://recherche-entreprises.api.gouv.fr/search?q=' + encodeURIComponent(siret) + '&per_page=5',
      { signal: controller.signal, headers: { Accept: 'application/json' } }
    );
    if (!response.ok) {
      console.error('Registre des entreprises : réponse', response.status, '(SIRET non vérifié)');
      return { ok: true };
    }
    const data = await response.json();
    const results = Array.isArray(data && data.results) ? data.results : [];

    let company = null;
    let place = null;
    results.forEach((r) => {
      const list = [].concat(r.matching_etablissements || [], r.siege ? [r.siege] : []);
      const found = list.find((e) => e && String(e.siret) === siret);
      if (found && !place) {
        company = r;
        place = found;
      }
    });

    if (!place) {
      return { ok: false, status: 400, error: "Ce numéro SIRET n'existe pas dans le registre officiel des entreprises. Vérifiez-le, ou écrivez-nous depuis la page Contact si vous venez de créer votre entreprise." };
    }
    if (place.etat_administratif === 'F' || (company && company.etat_administratif === 'C')) {
      return { ok: false, status: 400, error: "Ce numéro SIRET correspond à un établissement fermé ou à une entreprise qui a cessé son activité. Vous ne pouvez pas vous inscrire comme professionnel avec." };
    }
    return { ok: true };
  } catch (err) {
    console.error('Registre des entreprises injoignable (SIRET non vérifié) :', err && err.message);
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

// --- Informations fiscales du vendeur (déclaration DAC7 à l'administration fiscale) ---
// Date de naissance (majeur), numéro fiscal (13 chiffres) ou, à défaut, lieu de naissance.
// Un professionnel indique aussi sa raison sociale (et son numéro de TVA s'il en a un).
// Agrivoisin n'existe que pour la France : la résidence fiscale est enregistrée « FR ».
function cleanTaxInfo(sellerType, siret, raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const bad = (message) => ({ ok: false, status: 400, error: message });

  const birthDate = String(t.birthDate == null ? '' : t.birthDate).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    return bad('Indiquez votre date de naissance.');
  }
  const birth = new Date(birthDate + 'T00:00:00Z');
  if (Number.isNaN(birth.getTime()) || birth.toISOString().slice(0, 10) !== birthDate || birthDate < '1900-01-01') {
    return bad("La date de naissance n'est pas valide.");
  }
  const now = new Date();
  const eighteenYearsAgo = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
  if (birth > eighteenYearsAgo) {
    return bad('Il faut être majeur pour vendre sur Agrivoisin.');
  }

  let taxId = String(t.taxId == null ? '' : t.taxId).replace(/[\s.]/g, '');
  if (taxId && !/^\d{13}$/.test(taxId)) {
    return bad('Le numéro fiscal comporte 13 chiffres (il figure sur votre avis d\'impôt).');
  }

  let birthPlace = String(t.birthPlace == null ? '' : t.birthPlace).trim().replace(/\s+/g, ' ');
  if (birthPlace.length > 100) {
    return bad('Le lieu de naissance est trop long.');
  }

  let legalName = null;
  let vatNumber = null;
  if (sellerType === 'professionnel') {
    legalName = String(t.legalName == null ? '' : t.legalName).trim().replace(/\s+/g, ' ');
    if (legalName.length < 2 || legalName.length > 120) {
      return bad("Indiquez le nom de votre entreprise (raison sociale).");
    }
    const vat = String(t.vatNumber == null ? '' : t.vatNumber).replace(/[\s.]/g, '').toUpperCase();
    if (vat) {
      if (!/^FR[0-9A-Z]{2}\d{9}$/.test(vat)) {
        return bad('Le numéro de TVA doit ressembler à FR12345678901.');
      }
      vatNumber = vat;
    }
    // Sans numéro fiscal personnel, l'identifiant de l'entreprise est son SIREN (les 9 premiers chiffres du SIRET)
    if (!taxId && siret) {
      taxId = siret.slice(0, 9);
    }
  }

  // Sans numéro fiscal, le lieu de naissance est obligatoire
  if (!taxId && birthPlace.length < 2) {
    return bad("Indiquez votre numéro fiscal ou, si vous n'en avez pas, votre lieu de naissance.");
  }

  return {
    ok: true,
    info: {
      legal_name: legalName,
      birth_date: birthDate,
      birth_place: birthPlace || null,
      tax_country: 'FR',
      tax_id: taxId || null,
      vat_number: vatNumber,
    },
  };
}

// --- Vitrine d'un vendeur professionnel (nom, présentation, logo, photo de couverture) ---
const SHOP_BUCKET = 'shop-images';
const SHOP_NAME_MAX = 60;
const SHOP_DESCRIPTION_MAX = 600;

// Texte simple : sans caractères de contrôle, espaces nettoyés
function cleanShopText(value, keepLineBreaks) {
  let text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  text = text.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ');
  if (keepLineBreaks) {
    text = text.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
  } else {
    text = text.replace(/\s+/g, ' ');
  }
  return text.trim();
}

// Une image de vitrine n'est acceptée que si elle est rangée dans le dossier de CE vendeur (jamais une adresse extérieure)
function shopImagePrefix(userId) {
  return String(process.env.SUPABASE_URL || '').replace(/\/+$/, '') + '/storage/v1/object/public/' + SHOP_BUCKET + '/' + userId + '/';
}

function cleanShopImage(value, userId) {
  const url = String(value == null ? '' : value).trim();
  if (!url) return { ok: true, url: null };
  const prefix = shopImagePrefix(userId);
  const fileName = url.startsWith(prefix) ? url.slice(prefix.length) : null;
  if (!fileName || fileName.length > 120 || fileName.includes('..') || !/^[A-Za-z0-9._-]+$/.test(fileName)) {
    return { ok: false };
  }
  return { ok: true, url };
}

// Supprime une ancienne image remplacée (sans bloquer l'enregistrement si cela échoue)
async function removeShopImage(url, userId) {
  try {
    const prefix = shopImagePrefix(userId);
    if (!url || !String(url).startsWith(prefix)) return;
    await supabase.storage.from(SHOP_BUCKET).remove([userId + '/' + String(url).slice(prefix.length)]);
  } catch (err) {
    console.error('Suppression de l\'ancienne image de vitrine impossible :', err && err.message);
  }
}

async function handleShop(action, body, res, userId) {
  const { data: seller, error: sellerError } = await supabase
    .from('sellers')
    .select('id, seller_type, shop_name, shop_description, shop_cover_url, shop_logo_url')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sellerError) {
    console.error('Erreur Supabase (vitrine) :', sellerError);
    return res.status(500).json({ error: 'Impossible de lire votre vitrine pour le moment. Réessayez dans quelques instants.' });
  }
  if (!seller) {
    return res.status(400).json({ error: "Aucun compte vendeur trouvé pour ce compte. Devenez d'abord vendeur." });
  }
  if (seller.seller_type !== 'professionnel') {
    return res.status(403).json({ error: 'La vitrine est réservée aux vendeurs professionnels.' });
  }

  const shopOf = (row) => ({
    name: row.shop_name || '',
    description: row.shop_description || '',
    logoUrl: row.shop_logo_url || '',
    coverUrl: row.shop_cover_url || '',
  });

  if (action === 'get_shop') {
    // Une annonce de ce vendeur, pour lui permettre de voir sa vitrine (la vitrine s'ouvre depuis une annonce)
    const { data: listing } = await supabase
      .from('listings')
      .select('id')
      .eq('seller_id', seller.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return res.status(200).json({ shop: shopOf(seller), previewListingId: listing ? listing.id : null });
  }

  // save_shop
  const name = cleanShopText(body.name, false);
  if (name.length < 2 || name.length > SHOP_NAME_MAX) {
    return res.status(400).json({ error: 'Le nom de la boutique doit comporter de 2 à ' + SHOP_NAME_MAX + ' caractères.' });
  }
  const description = cleanShopText(body.description, true);
  if (description.length > SHOP_DESCRIPTION_MAX) {
    return res.status(400).json({ error: 'La présentation est trop longue (' + SHOP_DESCRIPTION_MAX + ' caractères au maximum).' });
  }
  const logo = cleanShopImage(body.logoUrl, userId);
  const cover = cleanShopImage(body.coverUrl, userId);
  if (!logo.ok || !cover.ok) {
    return res.status(400).json({ error: "L'une des images n'est pas valide. Choisissez-la de nouveau." });
  }

  const { error: updateError } = await supabase
    .from('sellers')
    .update({
      shop_name: name,
      shop_description: description || null,
      shop_logo_url: logo.url,
      shop_cover_url: cover.url,
    })
    .eq('id', seller.id);
  if (updateError) {
    console.error('Erreur Supabase (enregistrement de la vitrine) :', updateError);
    return res.status(500).json({ error: "Impossible d'enregistrer votre vitrine pour le moment. Réessayez dans quelques instants." });
  }

  // Les images remplacées ou retirées sont supprimées de l'espace de stockage
  if (seller.shop_logo_url && seller.shop_logo_url !== logo.url) await removeShopImage(seller.shop_logo_url, userId);
  if (seller.shop_cover_url && seller.shop_cover_url !== cover.url) await removeShopImage(seller.shop_cover_url, userId);

  return res.status(200).json({
    shop: { name, description, logoUrl: logo.url || '', coverUrl: cover.url || '' },
  });
}

const TAX_SAVE_ERROR = "Impossible d'enregistrer vos informations fiscales pour le moment. Réessayez dans quelques instants.";

export default async function handler(req, res) {
  // Simple vérification "cette ville va-t-elle avec ce code postal ?"
  // (utilisée par le formulaire d'inscription, avant de créer le compte)
  if (req.method === 'GET') {
    const { city, postalCode, pseudo: pseudoQuery } = req.query;
    const result = await lookupCommune(city, postalCode);

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    // Si un pseudo est proposé, on vérifie aussi qu'il est valide et libre (avant de créer le compte)
    const cleaned = cleanPseudo(pseudoQuery);
    if (!cleaned.ok) {
      return res.status(cleaned.status).json({ error: cleaned.error });
    }
    if (cleaned.pseudo) {
      const check = await isPseudoTaken(cleaned.pseudo, null);
      if (check.error) {
        return res.status(500).json({ error: PSEUDO_CHECK_ERROR });
      }
      if (check.taken) {
        return res.status(409).json({ error: PSEUDO_TAKEN_ERROR });
      }
    }

    return res.status(200).json({
      city: result.city,
      latitude: result.latitude,
      longitude: result.longitude,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { email, city, postalCode, address } = req.body;
    const sellerTypeRaw = req.body.sellerType;
    const siretRaw = req.body.siret;
    const pseudoRaw = req.body.pseudo;
    const taxRaw = req.body.tax;

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

    // La vitrine d'un vendeur professionnel : lire ou enregistrer (ce n'est pas une inscription de vendeur)
    if (req.body.action === 'get_shop' || req.body.action === 'save_shop') {
      return await handleShop(req.body.action, req.body, res, userId);
    }

    // 0 bis. Particulier ou professionnel ? (sans réponse : particulier, comme avant)
    const sellerType = sellerTypeRaw == null || sellerTypeRaw === '' ? 'particulier' : sellerTypeRaw;
    if (sellerType !== 'particulier' && sellerType !== 'professionnel') {
      return res.status(400).json({ error: 'Indiquez si vous êtes particulier ou professionnel.' });
    }
    let siret = null;
    if (sellerType === 'professionnel') {
      siret = String(siretRaw == null ? '' : siretRaw).replace(/[\s.]/g, '');
      if (!/^\d{14}$/.test(siret)) {
        return res.status(400).json({ error: 'Le numéro SIRET doit comporter 14 chiffres.' });
      }
      const siretCheck = await checkSiret(siret);
      if (!siretCheck.ok) {
        return res.status(siretCheck.status).json({ error: siretCheck.error });
      }
    }

    // Téléphone de l'entreprise : obligatoire pour un professionnel (il est affiché sur sa page vendeur)
    let phone = null;
    if (sellerType === 'professionnel') {
      phone = String(req.body.phone == null ? '' : req.body.phone).trim();
      const phoneDigits = phone.replace(/\D/g, '');
      if (phone.length > 20 || !/^[0-9+\s.()-]+$/.test(phone) || phoneDigits.length < 9 || phoneDigits.length > 15) {
        return res.status(400).json({ error: "Indiquez un numéro de téléphone valide pour l'entreprise." });
      }
    }

    // 0 quater. Informations fiscales (déclaration à l'administration fiscale)
    const cleanedTax = cleanTaxInfo(sellerType, siret, taxRaw);
    if (!cleanedTax.ok) {
      return res.status(cleanedTax.status).json({ error: cleanedTax.error });
    }
    const taxInfo = cleanedTax.info;

    // 0 ter. Pseudo affiché aux acheteurs (obligatoire : voir l'étape 2 bis)
    const cleanedPseudo = cleanPseudo(pseudoRaw);
    if (!cleanedPseudo.ok) {
      return res.status(cleanedPseudo.status).json({ error: cleanedPseudo.error });
    }
    const pseudo = cleanedPseudo.pseudo;

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
      .select('id, stripe_account_id, pseudo')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lookupError) {
      console.error('Erreur Supabase (recherche du vendeur) :', lookupError);
      return res.status(500).json({
        error: 'Impossible de vérifier votre compte vendeur pour le moment. Réessayez dans quelques instants.',
      });
    }

    // 2 bis. Pas de vendeur sans pseudo : il faut en envoyer un, sauf si ce vendeur en a déjà un
    if (!pseudo && !(existingSeller && existingSeller.pseudo)) {
      return res.status(400).json({ error: PSEUDO_REQUIRED_ERROR });
    }

    // 2 ter. Ce pseudo est-il déjà pris par quelqu'un d'autre ?
    if (pseudo) {
      const check = await isPseudoTaken(pseudo, existingSeller ? existingSeller.id : null);
      if (check.error) {
        return res.status(500).json({ error: PSEUDO_CHECK_ERROR });
      }
      if (check.taken) {
        return res.status(409).json({ error: PSEUDO_TAKEN_ERROR });
      }
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
        settings: {
          payouts: {
            schedule: { interval: 'monthly', monthly_anchor: MONTHLY_PAYOUT_DAY },
          },
        },
      });
      stripeAccountId = account.id;
      createdStripeAccount = true;
    }

    // 4. Enregistrer (ou mettre à jour) ce vendeur dans notre base de données Supabase
    let dbError = null;
    let sellerId = existingSeller ? existingSeller.id : null;

    if (existingSeller) {
      const changes = {
        city: commune.city,
        address: address,
        latitude: latitude,
        longitude: longitude,
        seller_type: sellerType,
        siret: siret,
        phone: phone,
      };
      if (pseudo) {
        changes.pseudo = pseudo;
      }
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
          seller_type: sellerType,
          siret: siret,
          phone: phone,
          pseudo: pseudo,
        })
        .select('id')
        .single();
      dbError = result.error;
      sellerId = result.data ? result.data.id : null;
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

      // Deux personnes ont choisi le même pseudo au même instant : la base de données refuse la seconde
      if (dbError.code === '23505') {
        return res.status(409).json({ error: PSEUDO_TAKEN_ERROR });
      }

      return res.status(500).json({
        error: "Impossible d'enregistrer votre compte vendeur pour le moment. Réessayez dans quelques instants.",
      });
    }

    // 4 bis. Enregistrer les informations fiscales (table fermée au public, lue seulement par le serveur)
    const taxResult = await supabase
      .from('seller_tax_info')
      .upsert({ seller_id: sellerId, ...taxInfo, collected_at: new Date().toISOString() }, { onConflict: 'seller_id' });

    if (taxResult.error) {
      console.error('Erreur Supabase (informations fiscales) :', taxResult.error);
      return res.status(500).json({ error: TAX_SAVE_ERROR });
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
