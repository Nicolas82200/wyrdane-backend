import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateSteamTicket } from "./steamHelper";

const originalEnv = { ...process.env };

const mockFetchOnce = (body: string, status = 200) => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			status,
			text: () => Promise.resolve(body),
		}),
	);
};

beforeEach(() => {
	process.env = { ...originalEnv };
	process.env.STEAM_WEB_API_KEY = "test-key";
	process.env.STEAM_APP_ID = "480";
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("authenticateSteamTicket", () => {
	it("uses the DEV bypass for DEV: tickets when DEV_SKIP_STEAM_VERIFY is enabled outside production", async () => {
		process.env.NODE_ENV = "development";
		process.env.DEV_SKIP_STEAM_VERIFY = "true";
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const steamId = await authenticateSteamTicket("DEV:76561198000000001");

		expect(steamId).toBe("76561198000000001");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("never bypasses verification in production, even with a DEV: ticket and the flag set", async () => {
		process.env.NODE_ENV = "production";
		process.env.DEV_SKIP_STEAM_VERIFY = "true";
		mockFetchOnce(
			JSON.stringify({ response: { params: { result: "OK", steamid: "1", ownersteamid: "1", vacbanned: false, publisherbanned: false } } }),
		);

		await authenticateSteamTicket("DEV:76561198000000001");

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("returns null when Steam responds with non-JSON (e.g. HTML error page)", async () => {
		mockFetchOnce("<html>Not found</html>", 404);

		const steamId = await authenticateSteamTicket("some-real-ticket");

		expect(steamId).toBeNull();
	});

	it("returns null when Steam reports a non-OK result", async () => {
		mockFetchOnce(JSON.stringify({ response: { error: { errorcode: 3, errordesc: "Invalid ticket" } } }));

		const steamId = await authenticateSteamTicket("bad-ticket");

		expect(steamId).toBeNull();
	});

	it("returns null for a VAC-banned account", async () => {
		mockFetchOnce(
			JSON.stringify({ response: { params: { result: "OK", steamid: "123", ownersteamid: "123", vacbanned: true, publisherbanned: false } } }),
		);

		expect(await authenticateSteamTicket("ticket")).toBeNull();
	});

	it("returns null for a publisher-banned account", async () => {
		mockFetchOnce(
			JSON.stringify({ response: { params: { result: "OK", steamid: "123", ownersteamid: "123", vacbanned: false, publisherbanned: true } } }),
		);

		expect(await authenticateSteamTicket("ticket")).toBeNull();
	});

	it("returns the steamid for a valid, unbanned ticket", async () => {
		mockFetchOnce(
			JSON.stringify({ response: { params: { result: "OK", steamid: "76561198000000042", ownersteamid: "76561198000000042", vacbanned: false, publisherbanned: false } } }),
		);

		expect(await authenticateSteamTicket("ticket")).toBe("76561198000000042");
	});
});
