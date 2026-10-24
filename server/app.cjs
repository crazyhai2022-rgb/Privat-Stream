// Startup file for cPanel's "Setup Node.js App" (Phusion Passenger).
//
// Passenger loads this file with require(), so it must be CommonJS — hence the .cjs
// extension even though the rest of the server is an ES module. It hands off to the real
// server with a dynamic import; Passenger then takes over whatever port the app listens on.
//
// In cPanel → Setup Node.js App set:
//   Application root         : viralx/server      (the folder holding this file)
//   Application startup file : app.cjs
//   Application mode         : Production
//
// Full walkthrough: docs/CPANEL.md
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

import('./src/index.js').catch((err) => {
  console.error('viralX failed to start:', err);
  process.exit(1);
});
