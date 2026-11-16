// Loads the receiver fresh each time, so a device never runs a stale cached copy.
'use strict';
const s = document.createElement('script');
s.src = 'receiver.js?t=' + Date.now();
document.body.appendChild(s);
