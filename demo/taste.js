// The taste page: the app (app/) in a window on a wide screen, and the "Reset
// the demo" beside it. On a phone the window is a card that opens app/ on its
// own page instead, so the frame is only loaded where it shows.
(function () {
  var frame = document.getElementById('demo');
  var wide = window.matchMedia('(min-width: 900px)');

  function load() {
    if (wide.matches && !frame.getAttribute('src')) frame.setAttribute('src', frame.dataset.src);
  }
  load();
  if (wide.addEventListener) wide.addEventListener('change', load);
  else if (wide.addListener) wide.addListener(load);

  // The app's own "Reset the demo?" sheet, opened inside the window; if the
  // app isn't there yet, the window simply starts over.
  document.getElementById('resetDemo').addEventListener('click', function () {
    var sheet = null;
    try { sheet = frame.contentDocument && frame.contentDocument.getElementById('taste-reset'); } catch (e) { sheet = null; }
    if (sheet && typeof sheet.showModal === 'function' && !sheet.open) {
      frame.focus();
      sheet.showModal();
    } else if (!sheet) {
      frame.setAttribute('src', frame.dataset.src + '?reset');
    }
  });
})();
