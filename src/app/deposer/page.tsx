import React from 'react';

export default function DeposerRecoltePage() {
  return (
    <div className="min-h-screen bg-[#FBF7EF] text-[#2E3A2A] font-sans flex flex-col justify-between">
      
      {/* EN-TÊTE ÉPURÉ */}
      <header className="w-full py-4 border-b border-gray-200/50 bg-white px-6 flex justify-between items-center shadow-sm">
        <div className="flex items-center gap-2">
          <span className="font-serif text-2xl font-bold text-[#4C7A50]">AgriVoisin</span>
          <span className="text-xs italic text-[#6B5842] hidden sm:inline">— Le frais tout près —</span>
        </div>
        <a href="/" className="text-sm font-semibold text-[#4C7A50] hover:underline">
          Annuler
        </a>
      </header>

      {/* ZONE PRINCIPALE DU FORMULAIRE */}
      <main className="flex-grow max-w-2xl w-full mx-auto p-4 md:p-6 py-8">
        <div className="bg-white border border-gray-100 rounded-3xl p-6 md:p-8 shadow-md">
          
          <h1 className="text-2xl font-bold text-[#385C3B] font-serif border-b border-gray-100 pb-4 mb-6">
            Partagez vos surplus de saison
          </h1>

          <form className="flex flex-col gap-6" onSubmit={(e) => e.preventDefault()}>
            
            {/* ÉTAPE 1 : GRILLE VISUELLE DES RÉCOLTES */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-wider text-[#6B5842]">
                Étape 1 : Quel produit proposez-vous ?
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-1">
                <button type="button" className="p-4 border-2 border-[#4C7A50] bg-[#4C7A50]/5 rounded-2xl flex flex-col items-center gap-2 text-sm font-bold text-[#2E3A2A]">
                  <span className="text-3xl">🍅</span> Tomates
                </button>
                <button type="button" className="p-4 border border-gray-200 rounded-2xl flex flex-col items-center gap-2 text-sm font-medium text-gray-500 hover:bg-gray-50">
                  <span className="text-3xl">🥕</span> Carottes
                </button>
                <button type="button" className="p-4 border border-gray-200 rounded-2xl flex flex-col items-center gap-2 text-sm font-medium text-gray-500 hover:bg-gray-50">
                  <span className="text-3xl">🍯</span> Miel
                </button>
                <button type="button" className="p-4 border border-gray-200 rounded-2xl flex flex-col items-center gap-2 text-sm font-medium text-gray-500 hover:bg-gray-50">
                  <span className="text-3xl">🥚</span> Œufs
                </button>
              </div>
            </div>

            {/* ÉTAPE 2 : QUANTITÉ ET PRIX */}
            <div className="flex flex-col gap-3 border-t border-gray-100 pt-5">
              <label className="text-xs font-bold uppercase tracking-wider text-[#6B5842]">
                Étape 2 : Prix et Unité de vente
              </label>
              
              <div className="flex flex-col sm:flex-row gap-4 mt-1">
                {/* Champ Prix */}
                <div className="flex-grow flex flex-col gap-1">
                  <label className="text-[10px] font-bold text-gray-400 uppercase">Prix de vente (€)</label>
                  <div className="relative">
                    <input type="text" placeholder="2,50" className="w-full h-12 pl-4 pr-10 border border-gray-200 rounded-xl font-semibold text-sm focus:outline-none focus:border-[#4C7A50]" disabled />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 font-bold text-gray-400 text-sm">€</span>
                  </div>
                </div>

                {/* Boutons d'unité validés */}
                <div className="flex flex-col gap-1 w-full sm:w-64">
                  <label className="text-[10px] font-bold text-gray-400 uppercase">Unité de tarification</label>
                  <div className="grid grid-cols-2 gap-2 h-12">
                    <button type="button" className="border-2 border-[#4C7A50] bg-[#4C7A50]/5 font-bold text-xs rounded-xl flex items-center justify-center gap-1">
                      ⚖️ au Kilo
                    </button>
                    <button type="button" className="border border-gray-200 text-gray-500 font-medium text-xs rounded-xl flex items-center justify-center gap-1 hover:bg-gray-50">
                      📦 au Lot
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* ÉTAPE 3 : FRAÎCHEUR EN GOUTTES DE ROSÉE */}
            <div className="flex flex-col gap-2 border-t border-gray-100 pt-5">
              <label className="text-xs font-bold uppercase tracking-wider text-[#6B5842]">
                Étape 3 : Indiquez la fraîcheur de la récolte
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-1">
                <button type="button" className="p-3 border-2 border-blue-400 bg-blue-50/50 rounded-xl flex items-center justify-center gap-2 text-xs font-bold text-blue-700">
                  <span>💧💧💧</span> Fraîcheur Rosée (Aujourd'hui)
                </button>
                <button type="button" className="p-3 border border-gray-200 text-gray-500 rounded-xl flex items-center justify-center gap-2 text-xs font-medium hover:bg-gray-50">
                  <span>💧💧</span> Récente (1 à 3 jours)
                </button>
                <button type="button" className="p-3 border border-gray-200 text-gray-500 rounded-xl flex items-center justify-center gap-2 text-xs font-medium hover:bg-gray-50">
                  <span>💧</span> De garde (Plus de 3 jours)
                </button>
              </div>
            </div>

            {/* ÉTAPE 4 : PHOTOS (MAXIMUM 3 PHOTOS PARTICULIERS) */}
            <div className="flex flex-col gap-2 border-t border-gray-100 pt-5">
              <div className="flex justify-between items-center">
                <label className="text-xs font-bold uppercase tracking-wider text-[#6B5842]">
                  Étape 4 : Ajoutez vos photos (3 max)
                </label>
                <span className="text-[10px] text-gray-400 font-medium">0 sur 3 ajoutées</span>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-1">
                <div className="h-24 border-2 border-dashed border-gray-200 rounded-2xl flex flex-col items-center justify-center bg-gray-50 cursor-pointer hover:bg-gray-100/70 transition-colors">
                  <span className="text-2xl text-gray-400">+</span>
                  <span className="text-[10px] font-bold text-gray-400 uppercase mt-0.5">Photo 1</span>
                </div>
                <div className="h-24 border border-dashed border-gray-200/50 rounded-2xl bg-gray-50/40 flex items-center justify-center text-gray-300 text-xl font-bold select-none">2</div>
                <div className="h-24 border border-dashed border-gray-200/50 rounded-2xl bg-gray-50/40 flex items-center justify-center text-gray-300 text-xl font-bold select-none">3</div>
              </div>
            </div>

            {/* Description libre */}
            <div className="flex flex-col gap-1 border-t border-gray-100 pt-5">
              <label className="text-xs font-bold uppercase tracking-wider text-[#6B5842]">Description (Optionnel)</label>
              <textarea placeholder="Décrivez votre méthode de culture, la variété ou donnez des conseils culinaires à vos voisins..." className="w-full h-24 p-3 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-[#4C7A50] resize-none" disabled></textarea>
            </div>

            {/* BOUTON SIGNATURE DE PUBLICATION COMPLET */}
            <div className="border-t border-gray-100 pt-6 mt-2">
              <button type="button" className="w-full h-14 bg-[#76c823] text-white rounded-2xl shadow-md text-base font-bold tracking-wide hover:scale-[1.01] hover:shadow-lg transition-all active:scale-[0.99]">
                📢 Déposer ma récolte
              </button>
              <p className="text-[10px] text-center text-gray-400 mt-2.5 leading-normal">
                En publiant, vous acceptez de respecter notre charte de courtoisie de quartier et vous certifiez que vos produits proviennent de surplus de production personnels et locaux.
              </p>
            </div>

          </form>

        </div>
      </main>

      {/* FOOTER */}
      <footer className="w-full py-4 border-t border-t-gray-200/40 bg-[#F3EDE0]/50 text-center text-xs text-[#6B5842]/80">
        <p>© 2026 AgriVoisin — Le frais tout près. Tous droits réservés.</p>
      </footer>
      
    </div>
  );
}
