// Acheteur qui veut devenir vendeur :
// - page « Publier une annonce » : si le compte n'est pas encore vendeur, on envoie vers « Devenir vendeur » ;
// - page « Devenir vendeur » : l'adresse e-mail du compte connecté se remplit toute seule.
(function () {
  if (typeof supabaseClient === 'undefined') return;
  var page = window.location.pathname;

  supabaseClient.auth.getSession().then(function (result) {
    var session = result && result.data && result.data.session;
    if (!session) return;

    if (page.indexOf('vendre') !== -1) {
      var champ = document.getElementById('sellerEmail');
      if (champ && !champ.value && session.user && session.user.email) {
        champ.value = session.user.email;
      }
      return;
    }

    if (page.indexOf('publier-annonce') !== -1) {
      fetch('/api/get-seller-listings', { headers: { Authorization: 'Bearer ' + session.access_token } })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok && x.d && x.d.error && x.d.error.indexOf('vendeur') !== -1) {
            window.location.replace('vendre.html');
          }
        })
        .catch(function () {});
    }
  });
})();
