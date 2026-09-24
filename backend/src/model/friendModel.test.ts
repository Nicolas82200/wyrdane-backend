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
