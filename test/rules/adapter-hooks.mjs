// Node module hooks that let the browser adapter (firebase-adapter.js) run in
// Node against the emulators: the SDK's CDN URLs become the npm packages, and
// firebase-config.js becomes emulator-config.mjs.
const SDK = 'https://www.gstatic.com/firebasejs/10.12.0/';
const PACKAGES = {
  [`${SDK}firebase-app.js`]: 'firebase/app',
  [`${SDK}firebase-firestore.js`]: 'firebase/firestore',
  [`${SDK}firebase-auth.js`]: 'firebase/auth'
};

export async function resolve(specifier, context, next) {
  if (PACKAGES[specifier]) return next(PACKAGES[specifier], { ...context, parentURL: import.meta.url });
  if (/(^|\/)firebase-config\.js$/.test(specifier)) {
    return { url: new URL('./emulator-config.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
