// ============================================
// AGRIVOISIN — Script principal
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  // Menu mobile (à compléter avec un panneau de nav si besoin)
  const navToggle = document.querySelector('.nav-toggle');
  const mainNav = document.querySelector('.main-nav');

  if (navToggle && mainNav) {
    navToggle.addEventListener('click', () => {
      mainNav.classList.toggle('nav-open');
    });
  }

  // Compteur panier (stocké en local pour l'instant, sera relié à Supabase ensuite)
  const cartCountEl = document.querySelector('.cart-count');
  function getCartCount() {
    const cart = JSON.parse(localStorage.getItem('agrivoisin_cart') || '[]');
    return cart.length;
  }
  if (cartCountEl) {
    cartCountEl.textContent = getCartCount();
  }

  // Ajout au panier depuis les cartes produits (démo, sans backend pour l'instant)
  document.querySelectorAll('.produce-card .icon-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.produce-card');
      const name = card.querySelector('h4').textContent;
      const price = card.querySelector('.price').textContent;

      const cart = JSON.parse(localStorage.getItem('agrivoisin_cart') || '[]');
      cart.push({ name, price });
      localStorage.setItem('agrivoisin_cart', JSON.stringify(cart));

      if (cartCountEl) cartCountEl.textContent = cart.length;

      btn.style.transform = 'scale(1.15)';
      setTimeout(() => { btn.style.transform = 'scale(1)'; }, 180);
    });
  });
});
