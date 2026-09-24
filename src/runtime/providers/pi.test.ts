import { describe, expect, test } from "bun:test";
import { PiClient } from "./pi.ts";

describe("PiClient", () => {
  test("initializes with label and default model", () => {
    const client = new PiClient("(pi default)");
    expect(client.label).toBe("pi");
    expect(client.model).toBe("(pi default)");
    expect(client.supportsNativeTools).toBe(false);
  });
});
