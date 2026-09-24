import { afterEach, describe, expect, test } from "bun:test";
import { isFirecrawlConfigured } from "./firecrawl.ts";

const OLD_KEY = process.env.FIRECRAWL_API_KEY;
const OLD_URL = process.env.FIRECRAWL_API_URL;
const OLD_BASE = process.env.FIRECRAWL_BASE_URL;

afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = OLD_KEY;
  if (OLD_URL === undefined) delete process.env.FIRECRAWL_API_URL;
  else process.env.FIRECRAWL_API_URL = OLD_URL;
  if (OLD_BASE === undefined) delete process.env.FIRECRAWL_BASE_URL;
  else process.env.FIRECRAWL_BASE_URL = OLD_BASE;
});

describe("Firecrawl configuration detection", () => {
  test("hosted Firecrawl without an API key is not configured", () => {
    delete process.env.FIRECRAWL_API_KEY;
    process.env.FIRECRAWL_API_URL = "https://api.firecrawl.dev/v2";
    delete process.env.FIRECRAWL_BASE_URL;

    expect(isFirecrawlConfigured()).toBe(false);
  });

  test("hosted Firecrawl with an API key is configured", () => {
    process.env.FIRECRAWL_API_KEY = "fc-test";
    process.env.FIRECRAWL_API_URL = "https://api.firecrawl.dev/v2";

    expect(isFirecrawlConfigured()).toBe(true);
  });

  test("self-hosted Firecrawl URL is configured without an API key", () => {
    delete process.env.FIRECRAWL_API_KEY;
    process.env.FIRECRAWL_API_URL = "http://localhost:3002/v2";

    expect(isFirecrawlConfigured()).toBe(true);
  });
});
