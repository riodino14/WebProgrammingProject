// Runs before the page is drawn, so there is no flash of the wrong colour theme.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('hp.theme'); } catch (e) { /* storage blocked */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
