import React from 'react';

export default function DetailProduitPage() {
  return (
    <div className="min-h-screen bg-[#FBF7EF] text-[#2E3A2A] font-sans flex flex-col justify-between">
      
      {/* EN-TÊTE ÉPURÉ */}
      <header className="w-full py-4 border-b border-gray-200/50 bg-white px-6 flex justify-between items-center shadow-sm">
        <div className="flex items-center gap-2">
          <span className="font-serif text-2xl font-bold text-[#4C7A50]">AgriVoisin</span>
          <span className="text-xs italic text-[#6B5842] hidden sm:inline">— Le frais tout près —</span>
        </div>
        <a href="/resultats" className="text-sm font-semibold text-[#4C7A50] hover:underline flex items-center gap-1">
          ← Retour aux résultats
        </a>
      </header>

      {/* ZONE PRINCIPALE */}
      <main className="flex-grow max-w-5xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 gap-8 py-8">
        
        {/* COLONNE GAUCHE : LE DIAPORAMA DE 3 PHOTOS MAXIMUM */}
        <div className="flex flex-col gap-3">
          {/* Grande photo principale */}
          <div className="w-full h-80 md:h-[400px] bg-white border border-gray-100 rounded-3xl shadow-sm flex items-center justify-center text-7xl overflow-hidden relative">
            🍅
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-sm text-white text-xs px-3 py-1 rounded-full font-medium">
              1 / 3
            </div>
          </div>
          
          {/* Les 2 autres miniatures en dessous pour faire 3 photos max */}
          <div className="grid grid-cols-3 gap-3">
            <div className="h-20 bg-white border-2 border-[#4C7A50] rounded-xl flex items-center justify-center text-2xl cursor-pointer opacity-100">🍅</div>
            <div className="h-20 bg-white border border-gray-100 rounded-xl flex items-center justify-center text-2xl cursor-pointer opacity-60 hover:opacity-90 transition-opacity">🌱</div>
            <div className="h-20 bg-white border border-gray-100 rounded-xl flex items-center justify-center text-2xl cursor-pointer opacity-60 hover:opacity-90 transition-opacity">🧺</div>
          </div>
        </div>

        {/* COLONNE DROITE : LES INFOS DU PRODUIT & BOUTON D'ACHAT */}
        <div className="flex flex-col justify-between bg-white border border-gray-100 rounded-3xl p-6 shadow-sm">
          
          <div>
            {/* L'identité du vendeur & réputation en FRAISES */}
            <div className="flex items-center justify-between border-b border-gray-100 pb-4 mb-4">
              <div className="flex flex-col">
                <span className="text-sm font-bold text-[#2E3A2A]">🏡 Le Potager de Jean</span>
                <span className="text-xs text-gray-400">Membre particulier</span>
              </div>
              <div className="bg-[#FBF7EF] px-3 py-1 rounded-full text-sm font-bold text-[#E8935C] flex items-center gap-1 shadow-sm">
                4.9 <span className="text-base">🍓</span>
              </div>
            </div>

            {/* Titre et Prix */}
            <h1 className="text-2xl md:text-3xl font-bold text-[#385C3B] font-serif">Marmande du potager</h1>
            <div className="text-2xl font-extrabold text-[#4C7A50] mt-2">
              3,50 € <span className="text-sm font-normal text-gray-400">/ kg</span>
            </div>

            {/* Indicateur de fraîcheur en GOUTTES DE ROSÉE */}
            <div className="mt-4 flex items-center gap-2 bg-blue-50/50 border border-blue-100 px-4 py-2.5 rounded-2xl w-fit">
              <span className="text-xl flex items-center tracking-tight">💧💧💧</span>
              <div className="flex flex-col">
                <span className="text-xs font-bold text-blue-700">Fraîcheur Rosée</span>
                <span className="text-[10px] text-blue-500 font-medium">Cueilli ce matin même dans le jardin</span>
              </div>
            </div>

            {/* Sécurité Adresse masquée & Localisation approximative */}
            <div className="text-sm font-medium text-gray-500 mt-5 flex items-center gap-1.5">
              <span>📍 Situé à 1,2 km de vous</span>
            </div>
            <p className="text-xs text-gray-400 italic mt-1 bg-[#FBF7EF] p-2.5 rounded-xl border border-gray-200/40">
              🔒 Par sécurité, l'adresse exacte vous sera révélée instantanément par e-mail et sur votre écran juste après votre paiement en ligne.
            </p>

            {/* Badges Horaires de Retrait */}
            <div className="mt-5">
              <span className="text-xs font-bold uppercase tracking-wider text-[#6B5842] block mb-2">Disponibilités pour le retrait :</span>
              <div className="flex flex-wrap gap-2">
                <span className="bg-[#F3EDE0] text-[#6B5842] font-semibold text-xs px-3 py-1.5 rounded-full border border-gray-200/30">
                  🗓️ Le week-end
                </span>
                <span className="bg-[#F3EDE0] text-[#6B5842] font-semibold text-xs px-3 py-1.5 rounded-full border border-gray-200/30">
                  🌆 En semaine après 18h
                </span>
              </div>
            </div>

            {/* Description libre du produit */}
            <div className="mt-5 border-t border-gray-100 pt-4">
              <span className="text-xs font-bold uppercase tracking-wider text-[#6B5842] block mb-1">Le mot du jardinier :</span>
              <p className="text-sm text-[#6B5842] leading-relaxed">
                Mes tomates Marmande arrivent à maturité toutes en même temps ! Elles n'ont subi aucun traitement chimique, uniquement le soleil du Loiret et l'eau de mon récupérateur. Parfaites pour de belles salades ou des tomates farcies.
              </p>
            </div>
          </div>

          {/* ZONE BOUTON D'ACHAT SÉCURISÉ */}
          <div className="mt-6 border-t border-gray-100 pt-4 flex flex-col gap-2">
            <button className="w-full h-14 bg-[#76c823] text-white rounded-2xl shadow-md text-base font-bold tracking-wide hover:scale-[1.01] hover:shadow-lg transition-all active:scale-[0.99]">
              🛒 Ajouter au panier multi-vendeurs
            </button>
            <p className="text-[10px] text-center text-gray-400">
              Paiement 100% sécurisé et crypté. L'argent est bloqué en toute sécurité tant que vous n'avez pas récupéré vos légumes.
            </p>
          </div>

        </div>

      </main>

      {/* FOOTER */}
      <footer className="w-full py-4 border-t border-gray-200/40 bg-[#F3EDE0]/50 text-center text-xs text-[#6B5842]/80">
        <p>© 2026 AgriVoisin — Le frais tout près. Tous droits réservés.</p>
      </footer>
      
    </div>
  );
}
