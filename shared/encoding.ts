const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string) => new Uint8Array(encoder.encode(text));
export const fromUtf8 = (bytes: ArrayBuffer | Uint8Array) => decoder.decode(bytes);

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Invalid base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const b64 = (bytes: ArrayBuffer | Uint8Array) => {
  const url = b64url(bytes).replace(/-/g, "+").replace(/_/g, "/");
  return url + "=".repeat((4 - (url.length % 4)) % 4);
};

export const fromB64 = (text: string) => fromB64url(text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
