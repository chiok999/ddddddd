/**
 * Keeps the process serving after a promise nobody awaited rejects.
 *
 * Node ends the process on an unhandled rejection. For a long-lived playback
 * server that is the wrong trade: one provider hiccup in a fire-and-forget
 * cleanup would drop every viewer at once. The default is to report and carry
 * on, which is what a browser does with the same failure.
 */
function installCrashGuard(report = line => console.warn(line)) {
  let installed = false;
  const describe = error => (error instanceof Error ? error.stack || error.message : String(error));
  const handler = error => report(`unhandled rejection: ${describe(error)}`);
  const exception = error => report(`uncaught exception: ${describe(error)}`);
  return {
    install() {
      if (installed) return false;
      installed = true;
      process.on('unhandledRejection', handler);
      process.on('uncaughtException', exception);
      return true;
    },
    remove() {
      if (!installed) return false;
      installed = false;
      process.off('unhandledRejection', handler);
      process.off('uncaughtException', exception);
      return true;
    },
  };
}

module.exports = { installCrashGuard };
