import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
		getConnection: vi.fn(),
	},
}));

import db from "./db";
import {
	findFriendship,
	sendFriendRequest,
	acceptFriendRequest,
	deleteFriendship,
	getFriends,
	resolveSteamIds,
	autoAddSteamFriends,
} from "./friendModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn> };

describe("sendFriendRequest", () => {
	beforeEach(() => vi.clearAllMocks());

	it("inserts a pending request when no relation exists yet", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]); // findFriendship: nothing
		mockedDb.query.mockResolvedValueOnce([{}]); // INSERT

		const result = await sendFriendRequest(1, 2);

		expect(result).toBe("sent");
		const insertCall = mockedDb.query.mock.calls[1];
		expect(insertCall[0]).toContain("INSERT INTO friendships");
		expect(insertCall[1]).toEqual([1, 2]);
	});

	it("reports already_friends without inserting when already accepted", async () => {
		mockedDb.query.mockResolvedValueOnce([[
			{ id: 5, requester_id: 1, addressee_id: 2, status: "accepted" },
		]]);

		const result = await sendFriendRequest(1, 2);

		expect(result).toBe("already_friends");
		expect(mockedDb.query).toHaveBeenCalledTimes(1);
	});

	it("reports already_pending when the caller already sent this exact request", async () => {
		mockedDb.query.mockResolvedValueOnce([[
			{ id: 5, requester_id: 1, addressee_id: 2, status: "pending" },
		]]);

		const result = await sendFriendRequest(1, 2);

		expect(result).toBe("already_pending");
		expect(mockedDb.query).toHaveBeenCalledTimes(1);
	});

	it("auto-accepts instead of creating a duplicate when the other player already sent a pending request", async () => {
		mockedDb.query.mockResolvedValueOnce([[
			{ id: 5, requester_id: 2, addressee_id: 1, status: "pending" },
		]]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE ... accepted

		const result = await sendFriendRequest(1, 2);

		expect(result).toBe("auto_accepted");
		const updateCall = mockedDb.query.mock.calls[1];
		expect(updateCall[0]).toContain("UPDATE friendships SET status = 'accepted'");
		expect(updateCall[1]).toEqual([5]);
	});
});

describe("findFriendship", () => {
	beforeEach(() => vi.clearAllMocks());

	it("checks both directions of the relation in a single query", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);

		await findFriendship(1, 2);

		expect(mockedDb.query.mock.calls[0][1]).toEqual([1, 2, 2, 1]);
	});
});

describe("acceptFriendRequest", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns true when a row was updated", async () => {
		mockedDb.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
		await expect(acceptFriendRequest(5, 2)).resolves.toBe(true);
	});

	it("returns false when the request doesn't belong to this addressee (or isn't pending)", async () => {
		mockedDb.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
		await expect(acceptFriendRequest(5, 999)).resolves.toBe(false);
	});
});

describe("deleteFriendship", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns true when the caller is one of the two participants", async () => {
		mockedDb.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
		await expect(deleteFriendship(5, 1)).resolves.toBe(true);
	});

	it("returns false when nothing matched (wrong id, or not a participant)", async () => {
		mockedDb.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
		await expect(deleteFriendship(5, 999)).resolves.toBe(false);
	});
});

describe("getFriends", () => {
	beforeEach(() => vi.clearAllMocks());

	it("passes the online window and the caller's id repeated for each IF() branch", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);

		await getFriends(42);

		const [sql, params] = mockedDb.query.mock.calls[0];
		expect(sql).toContain("FROM friendships");
		expect(params).toEqual([90, 42, 42, 42]);
	});
});

describe("resolveSteamIds", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns an empty array without querying when given an empty list", async () => {
		const result = await resolveSteamIds([], 1);
		expect(result).toEqual([]);
		expect(mockedDb.query).not.toHaveBeenCalled();
	});

	it("queries with the ids as placeholders plus the excluded caller id", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);

		await resolveSteamIds(["111", "222"], 1);

		const [sql, params] = mockedDb.query.mock.calls[0];
		expect(sql).toContain("IN (?, ?)");
		expect(params).toEqual(["111", "222", 1]);
	});

	it("caps the list at MAX_STEAM_IDS entries", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);
		const tooMany = Array.from({ length: 250 }, (_, i) => String(i));

		await resolveSteamIds(tooMany, 1);

		const [, params] = mockedDb.query.mock.calls[0];
		// 200 ids + l'id exclu
		expect(params).toHaveLength(201);
	});

	it("returns the matched Wyrdane accounts", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ id: 2, username: "Rival", steam_id: "222" }]]);

		const result = await resolveSteamIds(["222"], 1);

		expect(result).toEqual([{ id: 2, username: "Rival", steam_id: "222" }]);
	});
});

describe("autoAddSteamFriends", () => {
	beforeEach(() => vi.clearAllMocks());

	it("creates the friendship as already accepted (no pending step) for a new Steam friend", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ id: 2, username: "Rival", steam_id: "222" }]]); // resolveSteamIds
		mockedDb.query.mockResolvedValueOnce([[]]); // findFriendship: no existing relation
		mockedDb.query.mockResolvedValueOnce([{}]); // INSERT ... status = 'accepted'

		const result = await autoAddSteamFriends(["222"], 1);

		expect(result).toEqual([{ id: 2, username: "Rival", steam_id: "222" }]);
		const insertCall = mockedDb.query.mock.calls[2];
		expect(insertCall[0]).toContain("VALUES (?, ?, 'accepted', NOW())");
		expect(insertCall[1]).toEqual([1, 2]);
	});

	it("accepts an existing pending request instead of inserting a duplicate", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ id: 2, username: "Rival", steam_id: "222" }]]); // resolveSteamIds
		mockedDb.query.mockResolvedValueOnce([[{ id: 9, requester_id: 2, addressee_id: 1, status: "pending" }]]); // findFriendship
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE ... accepted

		await autoAddSteamFriends(["222"], 1);

		const updateCall = mockedDb.query.mock.calls[2];
		expect(updateCall[0]).toContain("UPDATE friendships SET status = 'accepted'");
		expect(updateCall[1]).toEqual([9]);
	});

	it("does nothing extra when already friends", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ id: 2, username: "Rival", steam_id: "222" }]]); // resolveSteamIds
		mockedDb.query.mockResolvedValueOnce([[{ id: 9, requester_id: 1, addressee_id: 2, status: "accepted" }]]); // findFriendship

		await autoAddSteamFriends(["222"], 1);

		expect(mockedDb.query).toHaveBeenCalledTimes(2);
	});

	it("returns an empty array without any write when no Steam friend has a Wyrdane account", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]); // resolveSteamIds: no match

		const result = await autoAddSteamFriends(["222"], 1);

		expect(result).toEqual([]);
		expect(mockedDb.query).toHaveBeenCalledTimes(1);
	});
});
