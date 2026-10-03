// Inside the phone app the screens open in a full-screen layer (iframe).
//  - "back" asks the app to close it instead of navigating the frame (opened on its own, the link goes to the panel).
//  - "ready" tells the app the first content is drawn, so it can lift its cover (no flashing of half-built screens).
(function () {
  if (window.parent === window) return;
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-app-back]');
    if (!a) return;
    e.preventDefault();
    try { window.parent.postMessage({ eg: 'back' }, new URL(a.href).origin); } catch (x) { window.parent.postMessage({ eg: 'back' }, '*'); }
  });
  var told = false;
  function ready() {
    if (told) return; told = true;
    var o = '*'; try { var b = document.querySelector('a[data-app-back]'); if (b) o = new URL(b.href).origin; } catch (x) { /* keep * */ }
    setTimeout(function () { window.parent.postMessage({ eg: 'ready' }, o); }, 250);
  }
  var inner = document.querySelector('iframe[src]');
  if (inner) inner.addEventListener('load', ready);          // screens that wrap a page of the car
  else document.addEventListener('eg-ready', ready);         // screens that draw their own list
  setTimeout(ready, 7000);                                   // never keep the cover forever
})();
