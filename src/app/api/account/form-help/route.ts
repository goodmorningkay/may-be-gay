// Native fallback only: never parse, log, echo, or process credential bodies.
// Hydrated forms use their existing JSON endpoints instead.
export async function POST() {
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JavaScript required</title><main><h1>JavaScript required</h1><p>Enable JavaScript to use account forms, then return and try again.</p><p><a href="/sign-in">Sign in</a> · <a href="/account/security">Account security</a></p></main></html>', {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" },
  });
}
