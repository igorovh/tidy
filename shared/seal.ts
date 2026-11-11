import { b64url, fromB64url, fromUtf8, sha256, utf8 } from "./encoding";

// Credentials travel encrypted to a key that exists only inside one job. The OIDC audience
// carries the key's hash, so a leaked OIDC token cannot be redeemed by anyone else.
// Workers types name the ECDH field `$public`; the runtime expects `public`.
type DeriveParams = Parameters<SubtleCrypto["deriveBits"]>[0];

export interface Sealed {
  epk: string;
  iv: string;
  ct: string;
}

export interface Recipient {
  privateKey: CryptoKey;
  publicKey: string;
}

export async function createRecipient(): Promise<Recipient> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: b64url(raw as ArrayBuffer) };
}

export async function audienceFor(publicKey: string): Promise<string> {
  return `tidy:${b64url(await sha256(fromB64url(publicKey)))}`;
}

async function contentKey(secret: ArrayBuffer, epk: Uint8Array<ArrayBuffer>, info: string) {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: epk, info: utf8(`tidy-seal-v1|${info}`) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(publicKey: string, plaintext: string, info: string): Promise<Sealed> {
  const raw = fromB64url(publicKey);
  if (raw.length !== 32) throw new Error("Invalid recipient key");
  const recipient = await crypto.subtle.importKey("raw", raw, { name: "X25519" }, false, []);
  const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as CryptoKeyPair;
  const epk = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);
  const secret = await crypto.subtle.deriveBits({ name: "X25519", public: recipient } as unknown as DeriveParams, ephemeral.privateKey, 256);
  const key = await contentKey(secret, epk, info);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plaintext));
  return { epk: b64url(epk), iv: b64url(iv), ct: b64url(ct) };
}

export async function open(recipient: Recipient, sealed: Sealed, info: string): Promise<string> {
  const epk = fromB64url(sealed.epk);
  const sender = await crypto.subtle.importKey("raw", epk, { name: "X25519" }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "X25519", public: sender } as unknown as DeriveParams, recipient.privateKey, 256);
  const key = await contentKey(secret, epk, info);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(sealed.iv) }, key, fromB64url(sealed.ct));
  return fromUtf8(plain);
}
