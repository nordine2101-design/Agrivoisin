import React from 'react';

export default function PanierPage() {
  return (
    <div className="min-h-screen bg-[#FBF7EF] text-[#2E3A2A] font-sans flex flex-col justify-between">
      
      {/* EN-TÊTE ÉPURÉ */}
      <header className="w-full py-4 border-b border-gray-200/50 bg-white px-6 flex justify-between items-center shadow-sm">
        <div className="flex items-center gap-2">
          <span className="font-serif text-2xl font-bold text-[#4C7A50]">AgriVoisin</span>
          <span className="text-xs italic text-[#6B5842] hidden sm:inline">— Le frais tout près —</span>
        </div>
        <span className="text-sm font-semibold text-[#4C7A50]">🛒 Mon Panier Sécurisé</span>
      </header>

      {/* ZONE PRINCIPALE COMPOSÉE DE 2 COLONNES */}
      <main className="flex-grow max-w-6xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-8 py-8">
        
        {/* COLONNE GAUCHE (Prend 2 tiers) : LA LISTE DES RÉCOLTES MULTI-VENDEURS */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          <h1 className="text-2xl font-bold text-[#385C3B] font-serif">Votre panier de saison</h1>
          
          {/* BLOC PRODUIT 1 : JEAN (Particulier) */}
          <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm flex gap-4 relative">
            <div className="w-20 h-20 bg-gray-100 rounded-xl flex-shrink-0 flex items-center justify-center text-3xl">
              🍅
            </div>
            <div className="flex flex-col justify-between flex-grow">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-[#2E3A2A] text-base">Marmande du potager</h3>
                  <p className="text-xs text-gray-400 mt-0.5">Chez : 🏡 Jean (Particulier) — <span className="text-[#E8935C]">4.9 🍓</span></p>
                  <p className="text-xs text-blue-500 font-semibold mt-1">💧💧💧 Fraîcheur Rosée</p>
                </div>
                <span className="font-extrabold text-[#4C7A50] text-base">7,00 €</span>
              </div>
              <div className="flex items-center justify-between border-t border-gray-50 pt-2 mt-2 text-xs text-gray-400">
                <span>Quantité : 2 kg (3,50 € / kg)</span>
                <button className="text-red-400 hover:underline">Supprimer</button>
              </div>
            </div>
          </div>

          {/* BLOC PRODUIT 2 : SOPHIE (Particulier) */}
          <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm flex gap-4 relative">
            <div className="w-20 h-20 bg-gray-100 rounded-xl flex-shrink-0 flex items-center justify-center text-3xl">
              🍯
            </div>
            <div className="flex flex-col justify-between flex-grow">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-[#2E3A2A] text-base">Miel de fleurs du jardin</h3>
                  <p className="text-xs text-gray-400 mt-0.5">Chez : 🏡 Sophie (Particulier) — <span className="text-[#E8935C]">4.7 🍓</span></p>
                  <p className="text-xs text-amber-600 font-semibold mt-1">💧 Produit de garde</p>
                </div>
                <span className="font-extrabold text-[#4C7A50] text-base">6,00 €</span>
              </div>
              <div className="flex items-center justify-between border-t border-gray-50 pt-2 mt-2 text-xs text-gray-400">
                <span>Quantité : 1 pot (6,00 € / pot)</span>
                <button className="text-red-400 hover:underline">Supprimer</button>
              </div>
            </div>
          </div>

          {/* LE TEXTE DE RÉASSURANCE VALIDÉ OBLIGATOIRE */}
          <div className="bg-[#4C7A50]/5 border-2 border-dashed border-[#4C7A50]/30 rounded-2xl p-4 flex gap-3 items-start">
            <span className="text-2xl mt-0.5">🔒</span>
            <div>
              <h4 className="font-bold text-sm text-[#385C3B]">Notre engagement de confidentialité et sécurité</h4>
              <p className="text-xs text-[#6B5842] mt-1 leading-relaxed">
                Pour protéger la vie privée de vos voisins, leurs adresses exactes ne sont pas publiques. Votre argent reste bloqué en sécurité sur un compte de confiance. Les coordonnées précises et les itinéraires de retrait vous seront révélés immédiatement après votre paiement.
              </p>
            </div>
          </div>
        </div>

        {/* COLONNE DROITE (Prend 1 tiers) : FORMULAIRE DE PAIEMENT UNIQUE */}
        <div className="bg-white border border-gray-100 rounded-3xl p-6 shadow-md h-fit flex flex-col gap-6">
          <h2 className="text-lg font-bold text-[#2E3A2A] border-b border-gray-100 pb-3 font-serif">Résumé de la commande</h2>
          
          {/* Le détail des calculs */}
          <div className="flex flex-col gap-2.5 text-sm">
            <div className="flex justify-between text-gray-500">
              <span>Sous-total récoltes (3 items)</span>
              <span>13,00 €</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>Frais de sécurité AgriVoisin</span>
              <span>0,90 €</span>
            </div>
            <div className="flex justify-between font-extrabold text-[#2E3A2A] text-lg border-t border-gray-100 pt-3 mt-1">
              <span>Total à régler</span>
              <span>13,90 €</span>
            </div>
          </div>

          {/* Formulaire de paiement par carte sécurisé */}
          <div className="flex flex-col gap-4 border-t border-gray-100 pt-4">
            <span className="text-xs font-bold uppercase tracking-wider text-[#6B5842]">💳 Paiement par carte bancaire</span>
            
            {/* Numéro de carte */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-bold text-gray-400 uppercase">Numéro de carte</label>
              <input type="text" placeholder="4532 •••• •••• ••••" className="w-full h-11 px-3 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-[#4C7A50]" disabled />
            </div>

            {/* Date et CVC */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-bold text-gray-400 uppercase">Expiration</label>
                <input type="text" placeholder="MM / AA" className="w-full h-11 px-3 border border-gray-200 rounded-xl text-sm text-center focus:outline-none focus:border-[#4C7A50]" disabled />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-bold text-gray-400 uppercase">Code (CVC)</label>
                <input type="text" placeholder="123" className="w-full h-11 px-3 border border-gray-200 rounded-xl text-sm text-center focus:outline-none focus:border-[#4C7A50]" disabled />
              </div>
            </div>

            {/* Bouton de paiement unique */}
            <button className="w-full h-14 bg-[#76c823] text-white font-bold rounded-2xl shadow-md text-base mt-2 hover:scale-[1.01] hover:shadow-lg transition-all active:scale-[0.99]">
              Payer en toute sécurité (13,90 €)
            </button>
            
            <p className="text-[10px] text-center text-gray-400 leading-normal">
              💳 Transaction sécurisée via Stripe Connect. Cryptage SSL 256 bits. Aucun numéro de carte n'est stocké sur nos serveurs.
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
