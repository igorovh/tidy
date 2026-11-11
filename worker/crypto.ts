import { b64url, fromB64url, fromUtf8, timingSafeEqual, utf8 } from "../shared/encoding";

export interface Keys {
  storage: CryptoKey;
  mac: CryptoKey;
}

let cached: { master: string; keys: Promise<Keys> } | undefined;

export function deriveKeys(master: string): Promise<Keys> {
  if (cached?.master === master) return cached.keys;
  const keys = (async () => {
    const raw = fromB64url(master.trim());
    if (raw.length < 32) throw new Error("TIDY_MASTER_KEY must be at least 32 random bytes");
    const material = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
    const derive = (info: string, algorithm: { name: string; length: number; hash?: string }, usages: ("encrypt" | "decrypt" | "sign" | "verify")[]) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(info) },
        material,
        algorithm,
        false,
        usages,
      );
    return {
      storage: await derive("tidy-storage-v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
      mac: await derive("tidy-mac-v1", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign", "verify"]),
    };
  })();
  cached = { master, keys };
  return keys;
}

// The record name is bound as associated data, so a ciphertext cannot be moved to another record.
export async function encrypt(keys: Keys, name: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(name) }, keys.storage, utf8(plaintext));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function decrypt(keys: Keys, name: string, value: string): Promise<string> {
  const [version, iv, ct] = value.split(".");
  if (version !== "v1" || !iv || !ct) throw new Error("Unknown ciphertext format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(iv), additionalData: utf8(name) },
    keys.storage,
    fromB64url(ct),
  );
  return fromUtf8(plain);
}

export async function mac(keys: Keys, purpose: string, data: string): Promise<string> {
  return b64url(await crypto.subtle.sign("HMAC", keys.mac, utf8(`${purpose}|${data}`)));
}

export async function macMatches(keys: Keys, purpose: string, data: string, signature: string): Promise<boolean> {
  try {
    return timingSafeEqual(fromB64url(await mac(keys, purpose, data)), fromB64url(signature));
  } catch {
    return false;
  }
}

// Short-lived signed values for cookies and OAuth state; `purpose` keeps them from being swapped.
export async function signValue(keys: Keys, purpose: string, value: object, ttlSeconds: number): Promise<string> {
  const body = b64url(utf8(JSON.stringify({ ...value, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  return `${body}.${await mac(keys, purpose, body)}`;
}

export async function verifyValue<T>(keys: Keys, purpose: string, token: string | null | undefined): Promise<T | null> {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature || !(await macMatches(keys, purpose, body, signature))) return null;
  const value = JSON.parse(fromUtf8(fromB64url(body))) as T & { exp: number };
  return value.exp > Date.now() / 1000 ? value : null;
}
