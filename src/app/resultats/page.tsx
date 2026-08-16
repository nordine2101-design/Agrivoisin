import React from 'react';

export default function ResultatsPage() {
  return (
    <div className="min-h-screen bg-[#FBF7EF] text-[#2E3A2A] font-sans flex flex-col">
      
      {/* EN-TÊTE ÉPURÉ DE LA PAGE */}
      <header className="w-full py-4 border-b border-gray-200/50 bg-white px-6 flex justify-between items-center shadow-sm">
        <div className="flex items-center gap-2">
          <span className="font-serif text-2xl font-bold text-[#4C7A50]">AgriVoisin</span>
          <span className="text-xs italic text-[#6B5842] hidden sm:inline">— Le frais tout près —</span>
        </div>
        <div className="text-sm font-semibold text-[#4C7A50] bg-[#F3EDE0] px-4 py-1.5 rounded-full">
          📍 Autour de moi (5 km)
        </div>
      </header>

      {/* ZONE PRINCIPALE DE RECHERCHE & FILTRES */}
      <main className="flex-grow flex flex-col max-w-7xl w-full mx-auto p-4 md:p-6 gap-6">
        
        {/* COMPTEUR ET FILTRES À COCHER / DÉCOCHER */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-200/60 pb-4">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-[#385C3B] font-serif">Produits frais disponibles</h1>
            <p className="text-xs md:text-sm text-[#6B5842]">3 récoltes trouvées dans votre quartier</p>
          </div>
          
          {/* NOS BOUTONS DE FILTRAGE VALIDÉS */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold uppercase tracking-wider text-[#6B5842]">Filtrer :</span>
            
            {/* Filtre Particuliers */}
            <label className="flex items-center gap-2 bg-white border border-[#4C7A50] px-4 py-2 rounded-full cursor-pointer shadow-sm hover:bg-[#F3EDE0] transition-colors select-none text-sm font-medium">
              <input type="checkbox" defaultChecked className="w-4 h-4 accent-[#4C7A50]" />
              <span>🏡 Particuliers</span>
            </label>
            
            {/* Filtre Professionnels avec l'insigne officiel Fourche + Bêche côte à côte */}
            <label className="flex items-center gap-2 bg-white border border-[#4C7A50] px-4 py-2 rounded-full cursor-pointer shadow-sm hover:bg-[#F3EDE0] transition-colors select-none text-sm font-medium">
              <input type="checkbox" defaultChecked className="w-4 h-4 accent-[#4C7A50]" />
              <span className="flex items-center gap-1.5">
                <span>🍴 🛠️</span>
                <span>Vendeurs Pro</span>
              </span>
            </label>
          </div>
        </div>

        {/* LOGIQUE D'AFFICHAGE D'ÉCRAN (CÔTE À CÔTE ORDINATEUR / ADAPTATION MOBILE) */}
        <div className="flex-grow flex flex-col lg:flex-row gap-6 h-[calc(100vh-220px)] min-h-[500px]">
          
          {/* COLONNE GAUCHE : LA LISTE DES PRODUITS */}
          <div className="w-full lg:w-1/2 flex flex-col gap-4 overflow-y-auto pr-0 lg:pr-2">
            
            {/* CARTE PRODUIT 1 : EXEMPLE PARTICULIER (JEAN) */}
            <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md transition-all flex gap-4 relative">
              <div className="w-28 h-28 md:w-32 md:h-32 bg-gray-100 rounded-xl flex-shrink-0 flex items-center justify-center text-4xl">
                🍅
              </div>
              <div className="flex flex-col justify-between flex-grow">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#6B5842]">🏡 Jean (Particulier)</span>
                    <span className="text-xs font-bold text-[#E8935C] flex items-center">4.9 🍓</span>
                  </div>
                  <h3 className="text-lg font-bold text-[#2E3A2A] mt-0.5">Marmande du potager</h3>
                  <div className="text-xs font-medium text-gray-500 mt-1 flex items-center gap-1">
                    <span>📍 À 1,2 km de vous</span>
                    <span className="text-gray-300">|</span>
                    <span className="text-blue-500 font-semibold">💧💧💧 Fraîcheur Rosée</span>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-gray-100 pt-2 mt-2">
                  <span className="text-lg font-extrabold text-[#4C7A50]">3,50 € <span className="text-xs font-normal text-gray-400">/ kg</span></span>
                  <button className="px-4 py-1.5 bg-[#76c823] text-white font-bold text-xs rounded-full shadow-sm hover:scale-105 transition-transform">
                    Voir la récolte
                  </button>
                </div>
              </div>
            </div>

            {/* CARTE PRODUIT 2 : EXEMPLE PROFESSIONNEL (DISTINCTION VISUELLE ET BADGE) */}
            <div className="bg-white border-2 border-[#4C7A50] rounded-2xl p-4 shadow-sm hover:shadow-md transition-all flex gap-4 relative overflow-hidden bg-[#4C7A50]/5">
              {/* Le bandeau Pro obligatoire avec la fourche et la bêche côte à côte */}
              <div className="absolute top-0 left-0 bg-[#4C7A50] text-white text-[10px] uppercase font-bold tracking-wider px-3 py-0.5 rounded-br-xl flex items-center gap-1">
                <span>🍴 🛠️</span> Producteur Pro
              </div>
              
              <div className="w-28 h-28 md:w-32 md:h-32 bg-gray-100 rounded-xl flex-shrink-0 flex items-center justify-center text-4xl mt-3 md:mt-2">
                🥕
              </div>
              <div className="flex flex-col justify-between flex-grow mt-2">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[#4C7A50]">💼 EARL Le Bel Air</span>
                    <span className="text-xs font-bold text-[#E8935C] flex items-center">5.0 🍓</span>
                  </div>
                  <h3 className="text-lg font-bold text-[#2E3A2A] mt-0.5">Carottes de sable lavées</h3>
                  <div className="text-xs font-medium text-gray-500 mt-1 flex items-center gap-1">
                    <span>📍 À 3,4 km de vous</span>
                    <span className="text-gray-300">|</span>
                    <span className="text-blue-400 font-semibold">💧💧 Récolte récente</span>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-gray-100/60 pt-2 mt-2">
                  <span className="text-lg font-extrabold text-[#4C7A50]">2,20 € <span className="text-xs font-normal text-gray-400">/ kg</span></span>
                  <button className="px-4 py-1.5 bg-[#4C7A50] text-white font-bold text-xs rounded-full shadow-sm hover:scale-105 transition-transform">
                    Voir la récolte
                  </button>
                </div>
              </div>
            </div>

            {/* CARTE PRODUIT 3 : EXEMPLE À LA PIECE / PRODUIT DE GARDE */}
            <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md transition-all flex gap-4 relative">
              <div className="w-28 h-28 md:w-32 md:h-32 bg-gray-100 rounded-xl flex-shrink-0 flex items-center justify-center text-4xl">
                🍯
              </div>
              <div className="flex flex-col justify-between flex-grow">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#6B5842]">🏡 Sophie (Particulier)</span>
                    <span className="text-xs font-bold text-[#E8935C] flex items-center">4.7 🍓</span>
                  </div>
                  <h3 className="text-lg font-bold text-[#2E3A2A] mt-0.5">Miel de fleurs du jardin</h3>
                  <div className="text-xs font-medium text-gray-500 mt-1 flex items-center gap-1">
                    <span>📍 À 0,8 km de vous</span>
                    <span className="text-gray-300">|</span>
                    <span className="text-amber-600 font-semibold">💧 Produit de garde</span>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-gray-100 pt-2 mt-2">
                  <span className="text-lg font-extrabold text-[#4C7A50]">6,00 € <span className="text-xs font-normal text-gray-400">/ pot</span></span>
                  <button className="px-4 py-1.5 bg-[#76c823] text-white font-bold text-xs rounded-full shadow-sm hover:scale-105 transition-transform">
                    Voir la récolte
                  </button>
                </div>
              </div>
            </div>

          </div>

          {/* COLONNE DROITE : LA CARTE INTERACTIVE INTERNET */}
          <div className="hidden lg:flex w-1/2 bg-[#E5E0D8] rounded-3xl border border-gray-200/70 relative items-center justify-center overflow-hidden shadow-inner">
            <div className="absolute inset-0 bg-cover opacity-40 bg-[radial-gradient(#C4BDAC_1px,transparent_1px)] [background-size:16px_16px]"></div>
            
            <div className="bg-white/90 backdrop-blur-sm px-6 py-4 rounded-2xl shadow-sm text-center max-w-sm border border-gray-100 z-10">
              <span className="text-2xl">🗺️</span>
              <h4 className="font-bold text-sm text-[#2E3A2A] mt-2">Carte du quartier interactive</h4>
              <p className="text-xs text-[#6B5842] mt-1">Les émojis de récoltes et les repères des maraîchers s'afficheront ici en temps réel grâce au GPS.</p>
            </div>
            
            {/* Simulation de marqueurs carte validés */}
            <div className="absolute top-1/4 left-1/3 bg-white px-3 py-1.5 rounded-full shadow-md font-bold text-sm flex items-center gap-1 border border-gray-100">
              <span>🏡 🍅</span> <span className="text-xs font-normal text-gray-400">1,2km</span>
            </div>
Utilisez le code avec précaution.🍴 🛠️ 🥕 3,4km);}
1. **Collez ce texte** dans votre grande case blanche sur GitHub.
2. Descendez tout en bas de la page, cliquez sur le bouton vert **« Commit changes... »**.
3. Dans la petite fenêtre qui s'ouvre, cliquez à nouveau sur le bouton vert **« Commit changes »** pour valider définitivement.

Je m'arrête là et j'attends votre signal.

<FollowUp>
Dites-moi simplement **« Structure des résultats enregistrée »** ou **« C'est fait »** dès que vous avez cliqué sur le deuxième bouton vert !
</FollowUp>
