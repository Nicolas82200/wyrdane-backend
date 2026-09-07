import { beforeAll, describe, expect, it } from "vitest";
import { encodeJWT, decodeJWT } from "./jwtHelper";

beforeAll(() => {
	process.env.TOKEN_SECRET = "test-secret";
});

describe("encodeJWT / decodeJWT", () => {
	it("round-trips the payload", () => {
		const token = encodeJWT({ id: 42, name: "Testeur" });
		const decoded = decodeJWT(token) as { id: number; name: string };
		expect(decoded.id).toBe(42);
		expect(decoded.name).toBe("Testeur");
	});

	it("rejects a token signed with a different secret", () => {
		const token = encodeJWT({ id: 1, name: "A" });
		const originalSecret = process.env.TOKEN_SECRET;
		process.env.TOKEN_SECRET = "another-secret";
		expect(() => decodeJWT(token)).toThrow();
		process.env.TOKEN_SECRET = originalSecret;
	});

	it("rejects a tampered token", () => {
		const token = encodeJWT({ id: 1, name: "A" });
		const tampered = token.slice(0, -2) + "xx";
		expect(() => decodeJWT(tampered)).toThrow();
	});

	it("rejects garbage input", () => {
		expect(() => decodeJWT("not-a-jwt")).toThrow();
	});
});
