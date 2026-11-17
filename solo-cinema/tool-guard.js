'use strict';
// Hosting panels run a single configured file, named by MAIN_FILE. If that is
// set to a diagnostic tool instead of the server, the panel starts the tool,
// the tool prints usage and exits, and the panel reports a crash. The site then
// never starts and every request is served by whatever process is left over.
//
// This guard makes that mistake harmless: when a tool is launched the way a
// panel launches things -- with no arguments, and with stdout captured rather
// than attached to a terminal -- it starts the real server instead of exiting.
// Run by hand in a shell, nothing changes.
const path = require('node:path');

function isPanelEntry() {
  if (process.env.TROY_ALLOW_TOOL_EXIT === '1') return false;
  if (process.argv.length > 2) return false;
  // A panel captures output through a pipe; an interactive shell is a TTY.
  if (process.stdout.isTTY) return false;
  // Clear signals that a supervisor is in charge.
  const markers = [
    process.env.P_SERVER_IP,            // Pterodactyl / Pelican
    process.env.STARTUP,
    process.env.SERVER_MEMORY,
    process.env.CONTAINER_SERVER,
    process.env.MAIN_FILE,
  ];
  if (markers.some(Boolean)) return true;
  return !process.stdout.isTTY;
}

// Returns true when the server was started, so the caller skips its own work.
function startServerIfPanelEntry(toolName, usage) {
  if (!isPanelEntry()) return false;
  const port = process.env.PORT || '3000';
  console.log('');
  console.log(`[troy] ${toolName} is a diagnostic tool, not the server.`);
  console.log(`[troy] The panel started it by setting MAIN_FILE=${toolName}.`);
  console.log(`[troy] Starting the real server instead: ${path.join(__dirname, 'server.js')}`);
  console.log('[troy] Fix the panel: set MAIN_FILE to server.js');
  console.log('[troy] To run this tool anyway: node ' + toolName + ' ' + (usage || ''));
  console.log(`[troy] Listening on port ${port} once ready.`);
  console.log('');
  require('./server');
  return true;
}

module.exports = { isPanelEntry, startServerIfPanelEntry };
