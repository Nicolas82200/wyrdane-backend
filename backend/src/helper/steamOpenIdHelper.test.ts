import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthUrl, verifyAssertion } from "./steamOpenIdHelper";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("buildAuthUrl", () => {
	it("builds a Steam OpenID checkid_setup URL with the given return_to and realm", () => {
		const url = new URL(buildAuthUrl("https://api.wyrdane.example/callback", "https://api.wyrdane.example"));
		expect(url.origin + url.pathname).toBe("https://steamcommunity.com/openid/login");
		expect(url.searchParams.get("openid.mode")).toBe("checkid_setup");
		expect(url.searchParams.get("openid.return_to")).toBe("https://api.wyrdane.example/callback");
		expect(url.searchParams.get("openid.realm")).toBe("https://api.wyrdane.example");
	});
});

// Nonce Steam valide (préfixe timestamp ISO8601 UTC frais + suffixe unique) :
// un suffixe distinct par appel évite qu'un test consomme le nonce d'un
// autre (usage unique, voir steamOpenIdHelper._seenNonces).
let _nonceCounter = 0;
const freshNonce = (): string => `${new Date().toISOString().replace(/\.\d+Z$/, "Z")}test-${_nonceCounter++}`;

describe("verifyAssertion", () => {
	it("rejects without calling Steam when the namespace doesn't match", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const result = await verifyAssertion({ "openid.ns": "wrong-namespace" });

		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns null when Steam says the assertion is not valid", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ text: () => Promise.resolve("is_valid:false\n") }),
		);

		const result = await verifyAssertion({
			"openid.ns": "http://specs.openid.net/auth/2.0",
			"openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000042",
		});

		expect(result).toBeNull();
	});

	it("extracts the steamid from claimed_id when Steam confirms validity", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ text: () => Promise.resolve("ns:...\nis_valid:true\n") }),
		);

		const result = await verifyAssertion({
			"openid.ns": "http://specs.openid.net/auth/2.0",
			"openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000042",
			"openid.response_nonce": freshNonce(),
		});

		expect(result).toBe("76561198000000042");
	});

	it("rejects a valid assertion without a response_nonce (anti-replay guard)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ text: () => Promise.resolve("is_valid:true\n") }),
		);

		const result = await verifyAssertion({
			"openid.ns": "http://specs.openid.net/auth/2.0",
			"openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000042",
		});

		expect(result).toBeNull();
	});

	it("rejects replaying an already-consumed response_nonce", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ text: () => Promise.resolve("is_valid:true\n") }),
		);
		const nonce = freshNonce();
		const query = {
			"openid.ns": "http://specs.openid.net/auth/2.0",
			"openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000042",
			"openid.response_nonce": nonce,
		};

		const first = await verifyAssertion(query);
		const replay = await verifyAssertion(query);

		expect(first).toBe("76561198000000042");
		expect(replay).toBeNull();
	});

	it("rejects a response_nonce whose timestamp is too old", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ text: () => Promise.resolve("is_valid:true\n") }),
		);

		const staleNonce = "2000-01-01T00:00:00Ztest-stale";
		const result = await verifyAssertion({
			"openid.ns": "http://specs.openid.net/auth/2.0",
			"openid.claimed_id": "https://steamcommunity.com/openid/id/76561198000000042",
			"openid.response_nonce": staleNonce,
		});

		expect(result).toBeNull();
	});

	it("returns null when Steam confirms validity but claimed_id has an unexpected shape", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ text: () => Promise.resolve("is_valid:true\n") }),
		);

		const result = await verifyAssertion({
			"openid.ns": "http://specs.openid.net/auth/2.0",
			"openid.claimed_id": "https://evil.example/not-steam",
			"openid.response_nonce": freshNonce(),
		});

		expect(result).toBeNull();
	});
});
