import React from 'react';

export default function ConfirmationPage() {
  return (
    <div className="min-h-screen bg-[#FBF7EF] text-[#2E3A2A] font-sans flex flex-col justify-between">
      
      {/* EN-TÊTE ÉPURÉ */}
      <header className="w-full py-4 border-b border-gray-200/50 bg-white px-6 flex justify-between items-center shadow-sm">
        <div className="flex items-center gap-2">
          <span className="font-serif text-2xl font-bold text-[#4C7A50]">AgriVoisin</span>
          <span className="text-xs italic text-[#6B5842] hidden sm:inline">— Le frais tout près —</span>
        </div>
        <span className="text-xs font-bold text-green-600 bg-green-50 px-3 py-1 rounded-full flex items-center gap-1">
          🔒 Commande Sécurisée
        </span>
      </header>

      {/* ZONE PRINCIPALE */}
      <main className="flex-grow max-w-3xl w-full mx-auto p-4 md:p-6 flex flex-col items-center py-10">
        
        {/* 1. LE HAUT DE L'ÉCRAN : CÉLÉBRATION VEGETALE & PLUIE DE FRAISES */}
        <div className="text-center mb-8 flex flex-col items-center animate-fade-in">
          <div className="text-5xl md:text-6xl mb-3 select-none animate-bounce">
            🍓 🍰 🍓
          </div>
          <h1 className="text-2xl md:text-3xl font-extrabold text-[#385C3B] font-serif tracking-tight">
            Félicitations ! Votre commande est validée.
          </h1>
          <p className="text-sm text-[#6B5842] mt-2 max-w-md">
            L'argent a été placé en toute sécurité sur notre compte de confiance. Vos maraîchers et voisins préparent vos récoltes !
          </p>
        </div>

        {/* 2. LE CŒUR DE L'ÉCRAN : LES CARTES DE RETRAIT (ADRESSES DÉVOILÉES) */}
        <div className="w-full flex flex-col gap-6 mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#6B5842] border-b border-gray-200/60 pb-2">
            📍 Vos fiches de retrait de quartier :
          </h2>

          {/* FICHE RETRAIT 1 : LE POTAGER DE JEAN */}
          <div className="bg-white border-2 border-[#76c823]/20 rounded-3xl p-6 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 bg-[#76c823]/10 text-[#4C7A50] text-[10px] font-bold uppercase tracking-wider px-4 py-1 rounded-bl-2xl">
              Ticket #AV-9812
            </div>
            
            <div className="flex items-center gap-3 mb-4">
              <span className="text-3xl">🏡</span>
              <div>
                <h3 className="font-extrabold text-[#2E3A2A] text-base">Le Potager de Jean</h3>
                <p className="text-xs text-[#E8935C] font-semibold flex items-center gap-0.5">4.9 🍓 <span className="text-gray-300 font-normal">| Particulier</span></p>
              </div>
            </div>

            {/* L'adresse précise enfin révélée */}
            <div className="bg-[#FBF7EF] border border-gray-100 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <span className="text-[10px] font-bold text-gray-400 uppercase block tracking-wider">Adresse exacte du rendez-vous :</span>
                <p className="text-sm font-bold text-[#2E3A2A] mt-0.5">12 Rue des Cerisiers, 45000 Orléans</p>
                <span className="text-xs text-blue-500 font-semibold block mt-1">🕒 Créneau convenu : Le week-end</span>
              </div>
              <button className="h-10 px-4 bg-[#76c823] text-white font-bold text-xs rounded-xl shadow-sm hover:bg-[#65b21d] transition-colors whitespace-nowrap flex items-center justify-center gap-1">
                🗺️ Voir l'itinéraire
              </button>
            </div>

            <div className="text-xs text-[#6B5842] mt-3 bg-gray-50 p-2.5 rounded-xl border border-gray-100 flex items-center gap-2">
              <span>📦</span>
              <span><strong>Votre commande :</strong> 2 kg de Tomates Marmande (3,50 € / kg)</span>
            </div>
          </div>

          {/* FICHE RETRAIT 2 : LES RUCHES DE SOPHIE */}
          <div className="bg-white border-2 border-[#76c823]/20 rounded-3xl p-6 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 bg-[#76c823]/10 text-[#4C7A50] text-[10px] font-bold uppercase tracking-wider px-4 py-1 rounded-bl-2xl">
              Ticket #AV-9813
            </div>
            
            <div className="flex items-center gap-3 mb-4">
              <span className="text-3xl">🐝</span>
              <div>
                <h3 className="font-extrabold text-[#2E3A2A] text-base">Les Ruches de Sophie</h3>
                <p className="text-xs text-[#E8935C] font-semibold flex items-center gap-0.5">4.7 🍓 <span className="text-gray-300 font-normal">| Particulier</span></p>
              </div>
            </div>

            {/* L'adresse de Sophie révélée */}
            <div className="bg-[#FBF7EF] border border-gray-100 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <span className="text-[10px] font-bold text-gray-400 uppercase block tracking-wider">Adresse exacte du rendez-vous :</span>
                <p className="text-sm font-bold text-[#2E3A2A] mt-0.5">5 Avenue de la Forêt, 45000 Orléans</p>
                <span className="text-xs text-blue-500 font-semibold block mt-1">🕒 Créneau convenu : En semaine après 18h</span>
              </div>
              <button className="h-10 px-4 bg-[#76c823] text-white font-bold text-xs rounded-xl shadow-sm hover:bg-[#65b21d] transition-colors whitespace-nowrap flex items-center justify-center gap-1">
                🗺️ Voir l'itinéraire
              </button>
            </div>

            <div className="text-xs text-[#6B5842] mt-3 bg-gray-50 p-2.5 rounded-xl border border-gray-100 flex items-center gap-2">
              <span>📦</span>
              <span><strong>Votre commande :</strong> 1 pot de Miel de fleurs du jardin (6,00 € / pot)</span>
            </div>
          </div>

          {/* CONSIGNES DE COURTOISIE OBLIGATOIRES */}
          <div className="bg-amber-50/50 border border-amber-200/60 rounded-2xl p-4 text-center text-xs text-[#6B5842]">
            🧺 <strong>Petit rappel citoyen :</strong> N'oubliez pas d'apporter votre propre cabas ou vos sacs réutilisables pour récupérer vos délicieux fruits et légumes chez vos voisins !
          </div>
        </div>

        {/* 3. LE BAS DE L'ÉCRAN : GROS BOUTON RETOUR ACCUEIL SIGNATURE */}
        <a href="/" className="w-full max-w-md h-16 bg-[#76c823] text-white rounded-2xl shadow-md text-base font-bold flex items-center justify-center tracking-wide hover:scale-[1.01] hover:shadow-lg transition-all active:scale-[0.99]">
          Retour à la carte du quartier
        </a>

      </main>

      {/* FOOTER */}
      <footer className="w-full py-4 border-t border-gray-200/40 bg-[#F3EDE0]/50 text-center text-xs text-[#6B5842]/80">
        <p>© 2026 AgriVoisin — Le frais tout près. Tous droits réservés.</p>
      </footer>
      
    </div>
  );
}
