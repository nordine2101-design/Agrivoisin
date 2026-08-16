import React from 'react';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[#FBF7EF] text-[#2E3A2A] font-sans flex flex-col justify-between">
      
      {/* 1. EN-TÊTE DU SITE (HEADER) */}
      <header className="w-full py-4 border-b border-gray-200/50 bg-[#FBF7EF]/90 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 flex justify-between items-center">
          {/* Logo espace vide à gauche pour l'équilibre */}
          <div className="w-24"></div>
          
          {/* Liens du Menu de navigation épuré */}
          <nav className="hidden md:flex items-center gap-8 text-[#6B5842] font-medium text-sm">
            <a href="#concept" className="hover:text-[#4C7A50] transition-colors">Comment ça marche</a>
            <a href="#pourquoi" className="hover:text-[#4C7A50] transition-colors">Pourquoi Agrivoisin</a>
          </nav>
          
          {/* Boutons de connexion à droite */}
          <div className="flex items-center gap-3">
            <button className="px-4 py-2 border border-[#4C7A50] text-[#4C7A50] rounded-full text-sm font-semibold hover:bg-[#4C7A50] hover:text-white transition-all">
              Se connecter
            </button>
            <button className="px-4 py-2 bg-[#E8935C] text-white rounded-full text-sm font-semibold shadow-sm hover:bg-[#D97D45] transition-all">
              Créer un compte
            </button>
          </div>
        </div>
      </header>

      {/* 2. ZONE CENTRALE (HERO) */}
      <main className="flex-grow max-w-4xl mx-auto px-6 flex flex-col items-center justify-center text-center py-12">
        
        {/* BLOC CHARTE GRAPHIQUE OFFICIELLE */}
        <div className="flex flex-col items-center mb-10">
          {/* L'emblème A (Emplacement pour votre logo) */}
          <div className="w-24 h-24 bg-gradient-to-tr from-red-500 to-[#76c823] rounded-2xl flex items-center justify-center text-white font-serif text-5xl font-bold shadow-md mb-3">
            A
          </div>
          {/* Le Nom de marque */}
          <h1 className="text-4xl md:text-5xl font-bold text-[#4C7A50] font-serif tracking-tight flex items-center gap-1">
            AgriVoisin<span className="text-pink-400 text-2xl">🌸</span>
          </h1>
          {/* Le Slogan officiel */}
          <p className="text-lg italic text-[#6B5842] mt-1">
            — Le frais tout près —
          </p>
        </div>

        {/* GRAND ESPACE DE RESPIRATION AVANT L'ACTION */}
        <div className="h-6"></div>

        {/* LE GROS BOUTON SIGNATURE VERT ACIDULÉ */}
        <button className="w-full max-w-xl h-24 bg-[#76c823] text-white rounded-[32px] shadow-lg shadow-[#76c823]/20 flex flex-col items-center justify-center px-6 transition-all hover:scale-[1.01] hover:shadow-xl hover:shadow-[#76c823]/30 active:scale-[0.99] group mb-4">
          <div className="flex items-center gap-2 text-xl md:text-2xl font-bold tracking-wide">
            <span>📍</span>
            <span>QU'Y A-T-IL PRÈS DE CHEZ MOI ?</span>
          </div>
          <span className="text-xs md:text-sm text-white/90 font-medium mt-0.5 group-hover:text-white transition-colors">
            Découvrez les fruits, légumes et produits de vos voisins
          </span>
        </button>

        {/* LA BARRE DE RECHERCHE SECONDAIRE LOCALE */}
        <div className="w-full max-w-xl relative">
          <span className="absolute left-5 top-1/2 -translate-y-1/2 text-gray-400 text-lg">🔎</span>
          <input 
            type="text" 
            placeholder="Rechercher un produit... (ex: Tomates, Miel, Œufs)" 
            className="w-full h-14 pl-12 pr-6 bg-white border border-gray-200 rounded-full shadow-sm text-base placeholder-gray-400 focus:outline-none focus:border-[#4C7A50] focus:ring-1 focus:ring-[#4C7A50] transition-all"
            disabled
          />
        </div>

        {/* ESPACE ET LIGNE DE FLOTTAISON */}
        <div className="h-24"></div>

        {/* 3. BLOC TEXTE DE PRÉSENTATION ET RÉASSURANCE */}
        <section id="concept" className="w-full max-w-2xl border-t border-gray-200/60 pt-12 text-left">
          <span className="inline-block bg-[#F3EDE0] text-[#4C7A50] font-semibold text-xs uppercase tracking-wider px-3 py-1 rounded-full mb-3">
            La marketplace des jardins gourmands
          </span>
          <h2 className="text-2xl md:text-3xl font-bold text-[#385C3B] font-serif mb-4">
            Le surplus de <em className="italic text-[#E8935C] not-italic">votre</em> jardin devient le régal <em className="italic text-[#E8935C] not-italic">d'un voisin</em>
          </h2>
          <p className="text-[#6B5842] leading-relaxed text-base">
            Agrivoisin relie les jardiniers particuliers qui récoltent plus qu'ils ne consomment aux voisins qui rêvent de légumes fraîchement cueillis. Simple, local, et payé en toute sécurité avant même de connaître l'adresse du vendeur.
          </p>
        </section>

      </main>

      {/* 4. PIED DE PAGE (FOOTER) */}
      <footer className="w-full py-6 border-t border-gray-200/40 bg-[#F3EDE0]/50 text-center text-xs text-[#6B5842]/80">
        <p>© 2026 AgriVoisin — Le frais tout près. Tous droits réservés.</p>
      </footer>

    </div>
  );
}
