import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "../../src/shared/utils/ssrfGuard.js";

describe("assertPublicUrl protocol policy", () => {
  it.each(["file:///etc/passwd", "ftp://example.com/resource", "gopher://example.com"]) (
    "rejects non-http(s) URL %s",
    (url) => expect(() => assertPublicUrl(url)).toThrow(/protocol must be http or https/),
  );

  it("accepts official b.ai HTTPS endpoint", () => {
    expect(() => assertPublicUrl("https://api.b.ai/v1/models")).not.toThrow();
  });
});