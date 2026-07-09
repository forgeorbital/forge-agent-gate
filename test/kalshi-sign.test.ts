import { constants, createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "./testlib.js";

import { KALSHI_BASE_URLS, KALSHI_PATH_PREFIX, buildKalshiHeaders, signKalshiMessage } from "../src/venues/kalshi.js";

function newRsaKey() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

describe("Kalshi RSA-PSS signing", () => {
  it("produces a signature verifiable with RSA-PSS / SHA-256 / salt=digest", () => {
    const { privateKeyPem, publicKey } = newRsaKey();
    const ts = "1751000000000";
    const method = "GET";
    const path = `${KALSHI_PATH_PREFIX}/portfolio/positions`;
    const sigB64 = signKalshiMessage(privateKeyPem, method, path, ts);

    const message = Buffer.from(`${ts}${method}${path}`, "utf8");
    const valid = cryptoVerify(
      "sha256",
      message,
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      Buffer.from(sigB64, "base64"),
    );
    expect(valid).toBe(true);
  });

  it("signs the exact string timestamp_ms + METHOD + path (method upper-cased)", () => {
    const { privateKeyPem, publicKey } = newRsaKey();
    const ts = "1751000000001";
    const path = `${KALSHI_PATH_PREFIX}/portfolio/orders`;
    // Adapter lower-cases nothing; the message upper-cases the method.
    const sigB64 = signKalshiMessage(privateKeyPem, "post", path, ts);
    const good = Buffer.from(`${ts}POST${path}`, "utf8");
    const bad = Buffer.from(`${ts}post${path}`, "utf8");
    const params = { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST };
    expect(cryptoVerify("sha256", good, params, Buffer.from(sigB64, "base64"))).toBe(true);
    expect(cryptoVerify("sha256", bad, params, Buffer.from(sigB64, "base64"))).toBe(false);
  });

  it("is non-deterministic (PSS salt) but each signature verifies", () => {
    const { privateKeyPem, publicKey } = newRsaKey();
    const ts = "1751000000002";
    const path = `${KALSHI_PATH_PREFIX}/markets`;
    const a = signKalshiMessage(privateKeyPem, "GET", path, ts);
    const b = signKalshiMessage(privateKeyPem, "GET", path, ts);
    expect(a).not.toBe(b); // PSS randomized salt
    const params = { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST };
    const msg = Buffer.from(`${ts}GET${path}`, "utf8");
    expect(cryptoVerify("sha256", msg, params, Buffer.from(a, "base64"))).toBe(true);
    expect(cryptoVerify("sha256", msg, params, Buffer.from(b, "base64"))).toBe(true);
  });

  it("buildKalshiHeaders returns the three required headers", () => {
    const { privateKeyPem } = newRsaKey();
    const headers = buildKalshiHeaders(
      { keyId: "key-123", privateKeyPem },
      "GET",
      `${KALSHI_PATH_PREFIX}/portfolio/balance`,
      "1751000000003",
    );
    expect(headers["KALSHI-ACCESS-KEY"]).toBe("key-123");
    expect(headers["KALSHI-ACCESS-TIMESTAMP"]).toBe("1751000000003");
    expect(headers["KALSHI-ACCESS-SIGNATURE"]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("exposes the expected base URLs", () => {
    expect(KALSHI_BASE_URLS.prod).toBe("https://external-api.kalshi.com/trade-api/v2");
    expect(KALSHI_BASE_URLS.demo).toBe("https://external-api.demo.kalshi.co/trade-api/v2");
  });
});
