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

// ============================================
// AGRIVOISIN — Fenêtre de confirmation (remplace la fenêtre grise du navigateur)
// Utilisation : if (!(await agrivoisinConfirm({ title, message, confirmText, cancelText, danger }))) return;
// danger = true : action définitive (bouton rouge). Échap ou un clic à côté de la fenêtre = on ne fait rien.
// ============================================
(function () {
  var styleAdded = false;
  var current = null;

  function addStyle() {
    if (styleAdded) return;
    styleAdded = true;
    var css =
      '.agv-ov{position:fixed;inset:0;z-index:100000;background:rgba(30,25,20,.55);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;}' +
      '.agv-dlg{background:#fff;border-radius:22px;box-shadow:0 12px 40px rgba(0,0,0,.35);padding:24px 22px 22px;width:100%;max-width:380px;box-sizing:border-box;text-align:center;max-height:90vh;overflow-y:auto;}' +
      '.agv-ic{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font:700 2rem/1 sans-serif;}' +
      '.agv-ic.agv-danger{background:#FDE9E7;color:#C8352F;}' +
      '.agv-ic.agv-ok{background:#E4F2DE;color:#2F6B3A;}' +
      '.agv-ttl{margin:0 0 10px;font-size:1.15rem;line-height:1.3;color:#3a2f22;text-align:center;}' +
      '.agv-msg{margin:0 0 18px;font-size:.95rem;line-height:1.5;color:#3a2f22;white-space:pre-line;text-align:center;}' +
      '.agv-btns{display:flex;flex-direction:column;gap:10px;}' +
      '.agv-btn{display:block;width:100%;box-sizing:border-box;border-radius:999px;padding:13px 16px;font:600 .95rem sans-serif;cursor:pointer;border:1.5px solid #4C7A50;}' +
      '.agv-green{background:#4C7A50;color:#fff;}' +
      '.agv-outline{background:#fff;color:#2F5D3A;}' +
      '.agv-red{background:#C8352F;border-color:#C8352F;color:#fff;}' +
      '.agv-btn:focus-visible{outline:3px solid #9FC49A;outline-offset:2px;}';
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  window.agrivoisinConfirm = function (options) {
    options = options || {};
    addStyle();
    if (current) current(false);

    return new Promise(function (resolve) {
      var danger = !!options.danger;
      var previousFocus = document.activeElement;
      var previousOverflow = document.body.style.overflow;

      var ov = document.createElement('div');
      ov.className = 'agv-ov';
      var dlg = document.createElement('div');
      dlg.className = 'agv-dlg';
      dlg.setAttribute('role', 'alertdialog');
      dlg.setAttribute('aria-modal', 'true');

      var ic = document.createElement('div');
      ic.className = 'agv-ic ' + (danger ? 'agv-danger' : 'agv-ok');
      ic.textContent = danger ? '!' : '?';
      ic.setAttribute('aria-hidden', 'true');

      var ttl = document.createElement('h3');
      ttl.className = 'agv-ttl';
      ttl.id = 'agvTitle';
      ttl.textContent = options.title || 'Confirmer ?';
      dlg.setAttribute('aria-labelledby', 'agvTitle');

      var msg = document.createElement('p');
      msg.className = 'agv-msg';
      msg.textContent = options.message || '';

      var btns = document.createElement('div');
      btns.className = 'agv-btns';
      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'agv-btn ' + (danger ? 'agv-green' : 'agv-outline');
      cancelBtn.textContent = options.cancelText || 'Non, revenir';
      var okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'agv-btn ' + (danger ? 'agv-red' : 'agv-green');
      okBtn.textContent = options.confirmText || 'Oui';
      btns.appendChild(cancelBtn);
      btns.appendChild(okBtn);

      dlg.appendChild(ic);
      dlg.appendChild(ttl);
      if (options.message) dlg.appendChild(msg);
      dlg.appendChild(btns);
      ov.appendChild(dlg);

      var done = false;
      function finish(answer) {
        if (done) return;
        done = true;
        current = null;
        document.removeEventListener('keydown', onKey, true);
        document.body.style.overflow = previousOverflow;
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        try { if (previousFocus && previousFocus.focus) previousFocus.focus(); } catch (e) {}
        resolve(answer);
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        } else if (e.key === 'Tab') {
          // Le clavier reste dans la fenêtre : Tab passe d'un bouton à l'autre
          e.preventDefault();
          (document.activeElement === cancelBtn ? okBtn : cancelBtn).focus();
        }
      }

      cancelBtn.addEventListener('click', function () { finish(false); });
      okBtn.addEventListener('click', function () { finish(true); });
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) finish(false); });
      document.addEventListener('keydown', onKey, true);

      current = finish;
      document.body.style.overflow = 'hidden';
      document.body.appendChild(ov);
      // Le focus est sur « revenir » : un « Entrée » par erreur ne fait jamais l'action
      cancelBtn.focus();
    });
  };
})();
