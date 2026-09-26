import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/friendModel", () => ({
	searchUsers: vi.fn(),
	autoAddSteamFriends: vi.fn(),
	sendFriendRequest: vi.fn(),
	acceptFriendRequest: vi.fn(),
	deleteFriendship: vi.fn(),
	getFriends: vi.fn(),
	getIncomingRequests: vi.fn(),
}));

import {
	searchUsers,
	autoAddSteamFriends,
	sendFriendRequest,
	acceptFriendRequest,
	deleteFriendship,
	getFriends,
	getIncomingRequests,
} from "../model/friendModel";
import { search, resolveSteamFriends, list, listIncomingRequests, sendRequest, accept, remove } from "./friendController";

const mocked = {
	searchUsers: searchUsers as ReturnType<typeof vi.fn>,
	autoAddSteamFriends: autoAddSteamFriends as ReturnType<typeof vi.fn>,
	sendFriendRequest: sendFriendRequest as ReturnType<typeof vi.fn>,
	acceptFriendRequest: acceptFriendRequest as ReturnType<typeof vi.fn>,
	deleteFriendship: deleteFriendship as ReturnType<typeof vi.fn>,
	getFriends: getFriends as ReturnType<typeof vi.fn>,
	getIncomingRequests: getIncomingRequests as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number | undefined, extra: Record<string, unknown> = {}): Request =>
	({ user: userId ? { id: userId } : undefined, query: {}, params: {}, body: {}, ...extra } as unknown as Request);

describe("search", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const res = mockRes();
		await search(reqAs(undefined), res);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("returns an empty array without querying below the minimum length", async () => {
		const res = mockRes();
		await search(reqAs(1, { query: { q: "a" } }), res);
		expect(mocked.searchUsers).not.toHaveBeenCalled();
		expect(res.json).toHaveBeenCalledWith([]);
	});

	it("searches excluding the caller", async () => {
		mocked.searchUsers.mockResolvedValue([{ id: 2, username: "Rival", steam_id: null }]);
		const res = mockRes();
		await search(reqAs(1, { query: { q: "riv" } }), res);
		expect(mocked.searchUsers).toHaveBeenCalledWith("riv", 1);
		expect(res.status).toHaveBeenCalledWith(200);
	});
});

describe("resolveSteamFriends", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const res = mockRes();
		await resolveSteamFriends(reqAs(undefined, { body: { steamIds: ["111"] } }), res);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(mocked.autoAddSteamFriends).not.toHaveBeenCalled();
	});

	it("returns an empty array without calling the model when steamIds is missing or empty", async () => {
		const res = mockRes();
		await resolveSteamFriends(reqAs(1, { body: {} }), res);
		expect(mocked.autoAddSteamFriends).not.toHaveBeenCalled();
		expect(res.json).toHaveBeenCalledWith([]);
	});

	it("rejects a non-array steamIds", async () => {
		const res = mockRes();
		await resolveSteamFriends(reqAs(1, { body: { steamIds: "111" } }), res);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(mocked.autoAddSteamFriends).not.toHaveBeenCalled();
	});

	it("rejects a steamIds array longer than the max", async () => {
		const res = mockRes();
		const tooMany = Array.from({ length: 201 }, (_, i) => String(i));
		await resolveSteamFriends(reqAs(1, { body: { steamIds: tooMany } }), res);
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.autoAddSteamFriends).not.toHaveBeenCalled();
	});

	it("rejects a steamIds array containing non-string entries", async () => {
		const res = mockRes();
		await resolveSteamFriends(reqAs(1, { body: { steamIds: [111, "222"] } }), res);
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.autoAddSteamFriends).not.toHaveBeenCalled();
	});

	it("forwards a valid steamIds list to the model", async () => {
		mocked.autoAddSteamFriends.mockResolvedValue([{ id: 2, username: "Rival", steam_id: "222" }]);
		const res = mockRes();
		await resolveSteamFriends(reqAs(1, { body: { steamIds: ["222"] } }), res);
		expect(mocked.autoAddSteamFriends).toHaveBeenCalledWith(["222"], 1);
		expect(res.status).toHaveBeenCalledWith(200);
	});
});

describe("list", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const res = mockRes();
		await list(reqAs(undefined), res);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("returns the caller's friends", async () => {
		mocked.getFriends.mockResolvedValue([]);
		const res = mockRes();
		await list(reqAs(1), res);
		expect(mocked.getFriends).toHaveBeenCalledWith(1);
		expect(res.status).toHaveBeenCalledWith(200);
	});
});

describe("listIncomingRequests", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns the caller's incoming requests", async () => {
		mocked.getIncomingRequests.mockResolvedValue([]);
		const res = mockRes();
		await listIncomingRequests(reqAs(1), res);
		expect(mocked.getIncomingRequests).toHaveBeenCalledWith(1);
	});
});

describe("sendRequest", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects an invalid userId", async () => {
		const res = mockRes();
		await sendRequest(reqAs(1, { body: { userId: "nope" } }), res);
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendFriendRequest).not.toHaveBeenCalled();
	});

	it("rejects adding oneself", async () => {
		const res = mockRes();
		await sendRequest(reqAs(1, { body: { userId: 1 } }), res);
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendFriendRequest).not.toHaveBeenCalled();
	});

	it("forwards a valid request and returns the resulting status", async () => {
		mocked.sendFriendRequest.mockResolvedValue("sent");
		const res = mockRes();
		await sendRequest(reqAs(1, { body: { userId: 2 } }), res);
		expect(mocked.sendFriendRequest).toHaveBeenCalledWith(1, 2);
		expect(res.json).toHaveBeenCalledWith({ status: "sent" });
	});
});

describe("accept", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns 404 when nothing was accepted", async () => {
		mocked.acceptFriendRequest.mockResolvedValue(false);
		const res = mockRes();
		await accept(reqAs(1, { params: { id: "5" } }), res);
		expect(res.status).toHaveBeenCalledWith(404);
	});

	it("returns success when accepted", async () => {
		mocked.acceptFriendRequest.mockResolvedValue(true);
		const res = mockRes();
		await accept(reqAs(1, { params: { id: "5" } }), res);
		expect(mocked.acceptFriendRequest).toHaveBeenCalledWith(5, 1);
		expect(res.status).toHaveBeenCalledWith(200);
	});
});

describe("remove", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns 404 when nothing was removed", async () => {
		mocked.deleteFriendship.mockResolvedValue(false);
		const res = mockRes();
		await remove(reqAs(1, { params: { id: "5" } }), res);
		expect(res.status).toHaveBeenCalledWith(404);
	});

	it("returns success when removed", async () => {
		mocked.deleteFriendship.mockResolvedValue(true);
		const res = mockRes();
		await remove(reqAs(1, { params: { id: "5" } }), res);
		expect(mocked.deleteFriendship).toHaveBeenCalledWith(5, 1);
		expect(res.status).toHaveBeenCalledWith(200);
	});
});
