import { describe, expect, test } from "bun:test";
import { audienceFor, createRecipient, open, seal } from "../shared/seal";

describe("seal", () => {
  test("only the recipient with the matching context can open a credential", async () => {
    const recipient = await createRecipient();
    const sealed = await seal(recipient.publicKey, "ghs_secret", "dispatch|1|write");
    expect(await open(recipient, sealed, "dispatch|1|write")).toBe("ghs_secret");
    expect(sealed.ct).not.toContain("ghs_secret");
  });

  test("a different run or role cannot reuse a sealed credential", async () => {
    const recipient = await createRecipient();
    const sealed = await seal(recipient.publicKey, "ghs_secret", "dispatch|1|write");
    await expect(open(recipient, sealed, "dispatch|2|write")).rejects.toThrow();
    await expect(open(recipient, sealed, "dispatch|1|agent")).rejects.toThrow();
  });

  test("another key pair cannot open it", async () => {
    const recipient = await createRecipient();
    const thief = await createRecipient();
    const sealed = await seal(recipient.publicKey, "ghs_secret", "x");
    await expect(open(thief, sealed, "x")).rejects.toThrow();
  });

  test("the OIDC audience is bound to exactly one public key", async () => {
    const a = await createRecipient();
    const b = await createRecipient();
    expect(await audienceFor(a.publicKey)).toBe(await audienceFor(a.publicKey));
    expect(await audienceFor(a.publicKey)).not.toBe(await audienceFor(b.publicKey));
    expect((await audienceFor(a.publicKey)).length).toBeLessThan(64);
  });
});
