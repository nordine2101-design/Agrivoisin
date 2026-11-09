// ---------------------------------------------------------------------------
// Contrôle des textes : refuse les insultes et les propos haineux
// (racisme, antisémitisme, islamophobie, sexisme, homophobie et transphobie, moqueries sur le handicap).
//
// Ce fichier n'est PAS une fonction du site (il n'est pas dans le dossier « api ») : il est utilisé par
// les fonctions qui enregistrent un avis, une annonce ou un pseudo.
//
// Principe : on compare des MOTS ENTIERS, jamais des morceaux de mots. Ainsi « salopette » ou « concombre »
// ne sont jamais refusés. Le contrôle repère aussi les astuces courantes : accents, majuscules,
// lettres répétées (« connnard »), chiffres à la place des lettres (« p0ute »), lettres séparées
// (« c o n n a r d », « p.u.t.e ») et étoiles (« p*te »).
//
// Les critiques honnêtes (« légumes abîmés », « vendeur peu aimable », « arnaque ») ne sont PAS refusées.
// ---------------------------------------------------------------------------

// Mots seuls (au singulier ; le pluriel et le féminin sont acceptés automatiquement)
const WORDS = {
  racisme: [
    'negre', 'negresse', 'negro', 'bougnoule', 'bougnoul', 'bicot', 'crouille', 'bamboula', 'chinetoque',
    'niakoue', 'chintok', 'nigger', 'nigga', 'chink', 'spic', 'sale race',
  ],
  antisemitisme: [
    'youpin', 'youpine', 'youtre', 'juifaille',
  ],
  islamophobie: [
    'islamiste de merde',
  ],
  sexisme: [
    'salope', 'salopard', 'pute', 'putasse', 'pouffiasse', 'grognasse', 'connasse', 'garce', 'feminazi',
    'feminazie', 'slut', 'whore', 'kahba', 'qahba',
  ],
  homophobie: [
    'pede', 'tarlouze', 'tarlouse', 'gouine', 'gouinasse', 'fiotte', 'lopette', 'tantouze', 'tafiole',
    'travelo', 'zamel', 'faggot',
  ],
  handicap: [
    'mongolien', 'attarde',
  ],
  insulte: [
    'connard', 'encule', 'enculer', 'enfoire', 'salaud', 'cretin', 'imbecile', 'abruti', 'ntm', 'fdp',
    'cunt',
  ],
};

// Expressions de plusieurs mots (écrites sans accent, en minuscules)
const PHRASES = {
  racisme: [
    'retourne dans ton pays', 'rentre dans ton pays', 'retournez dans votre pays', 'rentrez dans votre pays',
    'mort aux noirs', 'mort aux arabes', 'mort aux blancs', 'sale race', 'sales races',
  ],
  antisemitisme: [
    'mort aux juifs', 'heil hitler', 'sieg heil', 'hitler avait raison',
    'la shoah n a pas existe', 'l holocauste n a pas existe', 'la shoah est un mensonge',
    'l holocauste est un mensonge',
  ],
  islamophobie: [
    'mort aux musulmans', 'sales musulmans', 'sale musulman', 'sale musulmane',
  ],
  sexisme: [
    'retourne a la cuisine', 'retourne dans ta cuisine', 'sale bonne femme', 'sale pute',
  ],
  homophobie: [
    'mort aux pedes', 'mort aux gays', 'sale tapette', 'sales tapettes', 'espece de tapette', 'sale pedale',
    'sale homo', 'sales homos', 'sale pd',
  ],
  insulte: [
    'fils de pute', 'fille de pute', 'nique ta mere', 'nique ta race', 'niquer ta mere', 'va te faire foutre',
    'va te faire enculer', 'ta gueule', 'ferme ta gueule', 'fermez vos gueules', 'ferme la gueule',
    'sale con', 'pauvre con', 'gros con', 'petit con', 'sale batard', 'espece de batard', 'sac a merde',
  ],
};

// « sale » suivi d'un groupe de personnes : « sale juif », « sales arabes », « sale noir », « sale gouine »…
const GROUPES = [
  'juif', 'juive', 'juifs', 'juives', 'arabe', 'arabes', 'noir', 'noire', 'noirs', 'noires', 'negre', 'negres',
  'negresse', 'blanc', 'blancs', 'blanche', 'blanches', 'gitan', 'gitans', 'gitane', 'gitanes', 'rom', 'roms',
  'pd', 'pede', 'pedes', 'gay', 'gays', 'lesbienne', 'lesbiennes', 'trans', 'etranger', 'etrangers',
  'etrangere', 'etrangeres', 'asiat', 'asiatique', 'asiatiques', 'chinois', 'chinoise', 'chinoises',
  'femme', 'femmes', 'musulmane', 'musulmans', 'musulmanes',
];
const CATEGORIE_GROUPE = {
  juif: 'antisemitisme', juive: 'antisemitisme', juifs: 'antisemitisme', juives: 'antisemitisme',
  arabe: 'islamophobie', arabes: 'islamophobie', musulmane: 'islamophobie', musulmans: 'islamophobie',
  musulmanes: 'islamophobie',
  pd: 'homophobie', pede: 'homophobie', pedes: 'homophobie', gay: 'homophobie', gays: 'homophobie',
  lesbienne: 'homophobie', lesbiennes: 'homophobie', trans: 'homophobie',
  femme: 'sexisme', femmes: 'sexisme',
};
for (const g of GROUPES) {
  const cat = CATEGORIE_GROUPE[g] || 'racisme';
  PHRASES[cat].push('sale ' + g, 'sales ' + g);
}

// ---------------------------------------------------------------------------

// Une phrase ou un mot écrit « proprement » : minuscules, sans accents, mots séparés par une espace
function clean(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/[\u2019'`\u00B4]/g, ' ');
}

// Les lettres répétées comptent pour une seule (« connnard » = « connard »)
function squeeze(word) {
  return word.replace(/(.)\1+/g, '$1');
}

// Chiffres et symboles utilisés à la place des lettres
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
function unleet(token) {
  if (!/[a-z]/.test(token)) return token; // « 500 » reste « 500 »
  return token.replace(/[013457@$]/g, (c) => LEET[c] || c);
}

// Un mot, plus ses formes au pluriel et au féminin
function forms(word) {
  const w = squeeze(word);
  return [w, w + 's', w + 'e', w + 'es'];
}

const SINGLE = new Map();     // forme sans lettres doublées -> catégorie
const SINGLE_RAW = [];        // [forme écrite, catégorie] pour les étoiles
const PHRASE_LIST = [];       // [expression sans lettres doublées, catégorie]

for (const [cat, list] of Object.entries(WORDS)) {
  for (const entry of list) {
    if (entry.includes(' ')) {
      PHRASE_LIST.push([squeeze(clean(entry)).replace(/\s+/g, ' ').trim(), cat]);
      continue;
    }
    for (const f of forms(entry)) SINGLE.set(f, cat);
    for (const f of [entry, entry + 's', entry + 'e', entry + 'es']) SINGLE_RAW.push([f, cat]);
  }
}
for (const [cat, list] of Object.entries(PHRASES)) {
  for (const entry of list) {
    PHRASE_LIST.push([entry.split(' ').map(squeeze).join(' '), cat]);
  }
}

// Découpe le texte en mots (on garde « * » pour les mots cachés comme « p*te »)
function tokens(text) {
  return clean(text).split(/[^a-z0-9@$*]+/).filter(Boolean);
}

// Plusieurs lettres seules à la suite (« c o n n a r d », « p.u.t.e ») : on les recolle
function mergeSingles(list) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(''));
    run = [];
  };
  for (const t of list) {
    if (t.length === 1) run.push(t);
    else flush();
  }
  flush();
  return out;
}

function wildcardMatch(token) {
  if (!token.includes('*') || token.length < 4 || (token.match(/\*/g) || []).length > 2) return null;
  const re = new RegExp('^' + token.replace(/[^a-z0-9*]/g, '').replace(/\*/g, '[a-z]') + '$');
  for (const [form, cat] of SINGLE_RAW) {
    if (form.length === token.length && re.test(form)) return cat;
  }
  return null;
}

/**
 * Regarde si un texte contient des insultes ou des propos haineux.
 * Renvoie null si tout va bien, sinon la catégorie trouvée :
 * « racisme », « antisemitisme », « islamophobie », « sexisme », « homophobie », « handicap » ou « insulte ».
 */
export function findForbiddenText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const plain = tokens(text);
  const candidates = [...plain, ...mergeSingles(plain)];

  // Mots seuls
  for (const raw of candidates) {
    // Chiffres collés au début ou à la fin (« connard42 », « 69pute ») : on les enlève aussi
    const bare = /[a-z]/.test(raw) ? raw.replace(/^[0-9]+|[0-9]+$/g, '') : raw;
    const versions = new Set([raw, unleet(raw), bare, unleet(bare)]);
    for (const v of versions) {
      if (v.includes('*')) {
        const cat = wildcardMatch(v);
        if (cat) return cat;
        continue;
      }
      const cat = SINGLE.get(squeeze(v));
      if (cat) return cat;
    }
  }

  // Expressions de plusieurs mots
  const asWords = (list) => ' ' + list.map((t) => squeeze(t.replace(/[*]/g, ''))).filter(Boolean).join(' ') + ' ';
  const hayStacks = [asWords(plain), asWords(plain.map(unleet))];
  for (const hay of hayStacks) {
    for (const [phrase, cat] of PHRASE_LIST) {
      if (hay.includes(' ' + phrase + ' ')) return cat;
    }
  }

  return null;
}

// Phrase montrée à la personne dont le texte est refusé (jamais le mot trouvé : on ne le répète pas)
export const FORBIDDEN_TEXT_REASON = 'des propos injurieux ou discriminatoires';
