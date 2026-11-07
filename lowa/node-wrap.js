// Runs inside the LOWA office (pthread) thread, loaded via importScripts by
// runUnoScriptUrl. Same job as zetaHelperWrapThread() in the browser helper.
// __dirname is not available inside eval'ed scripts, so the host passes the
// absolute URL through a global.
const helperUrl = globalThis.__zetaHelperUrl;
import(helperUrl)
  .then((m) => m.zetaHelperWrapThread())
  .catch((e) => console.error('[node-wrap] failed:', e));
