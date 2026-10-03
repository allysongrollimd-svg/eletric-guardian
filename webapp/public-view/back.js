// Inside the phone app the screens open in a full-screen layer (iframe): "back" asks the app to close it
// instead of navigating the frame. Opened on its own (a normal browser tab) the link simply goes to the panel.
(function () {
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-app-back]');
    if (!a || window.parent === window) return;
    e.preventDefault();
    try { window.parent.postMessage({ eg: 'back' }, new URL(a.href).origin); } catch (x) { window.parent.postMessage({ eg: 'back' }, '*'); }
  });
})();
