import { describe, it, expect, vi } from "vitest";

// `redirect` throws NEXT_REDIRECT to unwind rendering, so it cannot be called
// for real outside the Next runtime — stub it and assert on the call instead.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

import { redirect } from "next/navigation";
import Home from "../page";

describe("root route", () => {
  it("redirects to the sign-in screen while the real home does not exist", () => {
    expect(() => Home()).toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
