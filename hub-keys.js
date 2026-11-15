// Private Hub password keys, shared by the browser adapter and scripts/hub-admin.mjs.
//
// A hub password never leaves the browser. It is stretched into a key with
// PBKDF2(password, salt). Firestore stores only sha256(key) as `key_hash`, in a
// document nobody can read; the security rules recompute sha256 of the key a
// browser presents when it registers as a hub member and compare the two.

export const HUB_PBKDF2_ITERATIONS = 50000;

// Version 1: key carried over from the old public `password_hash` (it was
// readable by anyone, so it is replaced on the owner's next sign-in).
// Version 2: key made with a fresh salt and never stored anywhere readable.
export const HUB_KEY_VERSION = 2;

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveHubKey(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(password || "")),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const saltBytes = new Uint8Array(
    (String(saltHex || "").match(/.{1,2}/g) || []).map(b => parseInt(b, 16))
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: HUB_PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(bits);
}

export function generateSaltHex() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

// Lowercase hex sha256 of the UTF-8 text, as the rules' hashing.sha256() sees it.
export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text))));
}
