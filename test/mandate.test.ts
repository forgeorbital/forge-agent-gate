import { describe, expect, it } from "./testlib.js";

import {
  defaultMandate,
  generateMandateKeypair,
  parseMandate,
  signMandate,
  validateMandate,
  verifyMandateSignature,
} from "../src/mandate.js";

describe("mandate validation", () => {
  it("accepts a default mandate", () => {
    expect(validateMandate(defaultMandate())).toEqual([]);
  });

  it("rejects an empty venue whitelist (fail-closed)", () => {
    const errors = validateMandate(defaultMandate({ venueWhitelist: [] }));
    expect(errors.join(" ")).toMatch(/venueWhitelist/);
  });

  it("rejects negative and non-finite limits", () => {
    expect(validateMandate(defaultMandate({ maxOrderNotionalUsd: -1 })).length).toBeGreaterThan(0);
    expect(validateMandate(defaultMandate({ maxTotalOpenExposureUsd: Number.NaN })).length).toBeGreaterThan(0);
  });

  it("rejects an invalid timezone", () => {
    const errors = validateMandate(
      defaultMandate({ tradingHours: { tz: "Not/AZone", windows: [] } }),
    );
    expect(errors.join(" ")).toMatch(/timezone/);
  });

  it("rejects a wrong schema version", () => {
    const bad = { ...defaultMandate(), schemaVersion: 99 };
    expect(validateMandate(bad).join(" ")).toMatch(/schemaVersion/);
  });

  it("parseMandate throws on invalid JSON", () => {
    expect(() => parseMandate("{not json")).toThrow(/valid JSON/);
  });
});

describe("mandate signing (ed25519)", () => {
  it("signs and verifies a round trip", () => {
    const { privateKeyPem } = generateMandateKeypair();
    const signed = signMandate(defaultMandate(), privateKeyPem);
    expect(signed.signature).toBeDefined();
    expect(signed.signature?.alg).toBe("ed25519");
    expect(verifyMandateSignature(signed)).toBe(true);
  });

  it("verification fails if any field is tampered", () => {
    const { privateKeyPem } = generateMandateKeypair();
    const signed = signMandate(defaultMandate({ maxOrderNotionalUsd: 100 }), privateKeyPem);
    const tampered = { ...signed, maxOrderNotionalUsd: 100000 };
    expect(verifyMandateSignature(tampered)).toBe(false);
  });

  it("an unsigned mandate does not verify", () => {
    expect(verifyMandateSignature(defaultMandate())).toBe(false);
  });

  it("signature is stable regardless of key ordering (canonicalization)", () => {
    const { privateKeyPem } = generateMandateKeypair();
    const m = defaultMandate();
    const a = signMandate(m, privateKeyPem);
    // Rebuild the same mandate object with keys inserted in a different order.
    const { killSwitch, ...rest } = m;
    const reordered = JSON.parse(JSON.stringify({ killSwitch, ...rest }));
    reordered.signature = a.signature;
    expect(verifyMandateSignature(reordered)).toBe(true);
  });
});
