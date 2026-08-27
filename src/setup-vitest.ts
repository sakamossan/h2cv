import { afterEach, beforeAll, vi } from "vitest";

beforeAll(() => {
  process.env.NODE_ENV = "test";
});
afterEach(() => {
  vi.clearAllMocks();
});
