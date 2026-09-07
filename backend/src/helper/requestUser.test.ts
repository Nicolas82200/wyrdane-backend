import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { getUserId } from "./requestUser";

describe("getUserId", () => {
	it("returns null when req.user is missing", () => {
		expect(getUserId({} as Request)).toBeNull();
	});

	it("returns null when the payload has no id", () => {
		expect(getUserId({ user: {} } as unknown as Request)).toBeNull();
	});

	it("returns null when the id is not numeric", () => {
		expect(getUserId({ user: { id: "not-a-number" } } as unknown as Request)).toBeNull();
	});

	it("returns the numeric id from a numeric payload", () => {
		expect(getUserId({ user: { id: 7 } } as unknown as Request)).toBe(7);
	});

	it("coerces a numeric-string id (JWT payloads sometimes stringify numbers)", () => {
		expect(getUserId({ user: { id: "7" } } as unknown as Request)).toBe(7);
	});
});
