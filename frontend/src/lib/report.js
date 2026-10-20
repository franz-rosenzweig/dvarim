// A part of the page that failed to draw, caught by a <svelte:boundary> (App.svelte)
// so that the rest of the app goes on working. Such an error never reaches
// window.onerror, so it is said here: in the console, and as a `dvarim:error`
// event, which whatever reports the page's errors to the server listens for.

export function reportPageError(error, where) {
  const message = error && error.message ? error.message : String(error);
  console.error(`Dvarim: ${where} could not be drawn:`, error);
  try {
    window.dispatchEvent(new CustomEvent('dvarim:error', { detail: { where, message, stack: error && error.stack ? String(error.stack) : '' } }));
  } catch { /* reporting must never fail the page again */ }
}
