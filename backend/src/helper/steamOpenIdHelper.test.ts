import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthUrl, verifyAssertion, steamOpenIdRealm } from "./steamOpenIdHelper";

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

describe("steamOpenIdRealm", () => {
	it("wildcards the subdomain so Steam displays the root domain instead of api.*", () => {
		expect(steamOpenIdRealm("https://wyrdane.com")).toBe("https://*.wyrdane.com/");
	});

	it("preserves the protocol", () => {
		expect(steamOpenIdRealm("http://localhost:5173")).toBe("http://*.localhost/");
	});
});

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
		});

		expect(result).toBe("76561198000000042");
	});

	it("returns null when Steam confirms validity but claimed_id has an unexpected shape", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ text: () => Promise.resolve("is_valid:true\n") }),
		);

		const result = await verifyAssertion({
			"openid.ns": "http://specs.openid.net/auth/2.0",
			"openid.claimed_id": "https://evil.example/not-steam",
		});

		expect(result).toBeNull();
	});
});
