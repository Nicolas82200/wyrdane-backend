import { beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { issueMatchSessionToken, verifyMatchSessionToken } from "./matchSessionToken";

beforeAll(() => {
	process.env.TOKEN_SECRET = "test-secret";
});

describe("issueMatchSessionToken / verifyMatchSessionToken", () => {
	it("verifies successfully regardless of which player calls first", () => {
		const token = issueMatchSessionToken("match-1", 1, 2);
		expect(verifyMatchSessionToken(token, 1, 2)?.matchId).toBe("match-1");
		expect(verifyMatchSessionToken(token, 2, 1)?.matchId).toBe("match-1");
	});

	it("rejects a token used for a different pair of players", () => {
		const token = issueMatchSessionToken("match-1", 1, 2);
		expect(verifyMatchSessionToken(token, 1, 3)).toBeNull();
		expect(verifyMatchSessionToken(token, 3, 4)).toBeNull();
	});

	it("rejects a token signed with a different secret", () => {
		const token = issueMatchSessionToken("match-1", 1, 2);
		const originalSecret = process.env.TOKEN_SECRET;
		process.env.TOKEN_SECRET = "another-secret";
		expect(verifyMatchSessionToken(token, 1, 2)).toBeNull();
		process.env.TOKEN_SECRET = originalSecret;
	});

	it("rejects garbage input", () => {
		expect(verifyMatchSessionToken("not-a-jwt", 1, 2)).toBeNull();
	});

	it("rejects a regular auth JWT presented as a match session token", () => {
		// Même secret, mais scope/forme différente (jwtHelper.encodeJWT) : ne
		// doit pas être accepté ici même si la signature est valide.
		const authToken = jwt.sign({ id: 1, name: "Testeur" }, process.env.TOKEN_SECRET as string);
		expect(verifyMatchSessionToken(authToken, 1, 2)).toBeNull();
	});
});
