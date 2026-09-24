import { describe, expect, test } from "bun:test";
import { AntigravityClient } from "./antigravity.ts";

describe("AntigravityClient", () => {
  test("initializes with label and default model", () => {
    const client = new AntigravityClient("(antigravity default)");
    expect(client.label).toBe("antigravity");
    expect(client.model).toBe("(antigravity default)");
    expect(client.supportsNativeTools).toBe(false);
  });
});
