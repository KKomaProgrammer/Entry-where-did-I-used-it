(() => {
  'use strict';

  function inject() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    s.onload = () => s.remove();
    (document.documentElement || document.head || document.body).appendChild(s);
  }

  if (document.documentElement) {
    inject();
  } else {
    document.addEventListener('DOMContentLoaded', inject, { once: true });
  }
})();
