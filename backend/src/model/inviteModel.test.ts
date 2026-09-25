import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
	},
}));

vi.mock("./friendModel", () => ({
	findFriendship: vi.fn(),
	ONLINE_WINDOW_SECONDS: 90,
}));

import db from "./db";
import { findFriendship } from "./friendModel";
import { createInvite, getIncomingInvites, getInviteStatus, respondInvite, cancelInvite } from "./inviteModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn> };
const mockedFindFriendship = findFriendship as unknown as ReturnType<typeof vi.fn>;

describe("createInvite", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses when the two players aren't accepted friends", async () => {
		mockedFindFriendship.mockResolvedValueOnce(null);

		const result = await createInvite(1, 2, 123456);

		expect(result).toEqual({ ok: false, reason: "not_friends" });
		expect(mockedDb.query).not.toHaveBeenCalled();
	});

	it("refuses when the friendship is still pending", async () => {
		mockedFindFriendship.mockResolvedValueOnce({ id: 5, requester_id: 1, addressee_id: 2, status: "pending" });

		const result = await createInvite(1, 2, 123456);

		expect(result).toEqual({ ok: false, reason: "not_friends" });
	});

	it("refuses when the recipient isn't online", async () => {
		mockedFindFriendship.mockResolvedValueOnce({ id: 5, status: "accepted" });
		mockedDb.query.mockResolvedValueOnce([[{ in_game: 0, is_online: 0 }]]);

		const result = await createInvite(1, 2, 123456);

		expect(result).toEqual({ ok: false, reason: "recipient_unavailable" });
	});

	it("refuses when the recipient is already in a game", async () => {
		mockedFindFriendship.mockResolvedValueOnce({ id: 5, status: "accepted" });
		mockedDb.query.mockResolvedValueOnce([[{ in_game: 1, is_online: 1 }]]);

		const result = await createInvite(1, 2, 123456);

		expect(result).toEqual({ ok: false, reason: "recipient_unavailable" });
	});

	it("cancels the sender's previous pending invite then inserts the new one", async () => {
		mockedFindFriendship.mockResolvedValueOnce({ id: 5, status: "accepted" });
		mockedDb.query.mockResolvedValueOnce([[{ in_game: 0, is_online: 1 }]]); // recipient lookup
		mockedDb.query.mockResolvedValueOnce([{}]); // cancel previous
		mockedDb.query.mockResolvedValueOnce([{ insertId: 42 }]); // INSERT
		mockedDb.query.mockResolvedValueOnce([[{ id: 42, sender_id: 1, recipient_id: 2, status: "pending", steam_lobby_id: "123456" }]]); // re-fetch

		const result = await createInvite(1, 2, 123456);

		expect(result).toEqual({
			ok: true,
			invite: { id: 42, sender_id: 1, recipient_id: 2, status: "pending", steam_lobby_id: "123456" },
		});
		const cancelCall = mockedDb.query.mock.calls[1];
		expect(cancelCall[0]).toContain("UPDATE game_invites SET status = 'cancelled'");
		expect(cancelCall[1]).toEqual([1]);
		const insertCall = mockedDb.query.mock.calls[2];
		expect(insertCall[0]).toContain("INSERT INTO game_invites");
		expect(insertCall[1]).toEqual([1, 2, 123456]);
	});
});

describe("getIncomingInvites", () => {
	beforeEach(() => vi.clearAllMocks());

	it("expires stale pending invites before selecting", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]); // expire
		mockedDb.query.mockResolvedValueOnce([[]]); // select

		await getIncomingInvites(2);

		expect(mockedDb.query.mock.calls[0][0]).toContain("UPDATE game_invites SET status = 'expired'");
		expect(mockedDb.query.mock.calls[1][0]).toContain("FROM game_invites gi");
	});
});

describe("getInviteStatus", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns expired for an invite that doesn't belong to the caller", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ id: 1, sender_id: 999, status: "pending", created_at: new Date().toISOString() }]]);

		const result = await getInviteStatus(1, 1);

		expect(result).toBe("expired");
	});

	it("returns the current status when still fresh", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ id: 1, sender_id: 1, status: "pending", created_at: new Date().toISOString() }]]);

		const result = await getInviteStatus(1, 1);

		expect(result).toBe("pending");
	});
});

describe("respondInvite", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns null when the caller isn't the recipient", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ id: 1, recipient_id: 999, status: "pending", created_at: new Date().toISOString() }]]);

		const result = await respondInvite(1, 1, true);

		expect(result).toBeNull();
	});

	it("accepts a still-pending invite addressed to the caller", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ id: 1, recipient_id: 2, status: "pending", created_at: new Date().toISOString(), steam_lobby_id: "123" }]]);
		mockedDb.query.mockResolvedValueOnce([{}]); // UPDATE

		const result = await respondInvite(2, 1, true);

		expect(result?.status).toBe("accepted");
		const updateCall = mockedDb.query.mock.calls[1];
		expect(updateCall[1]).toEqual(["accepted", 1]);
	});
});

describe("cancelInvite", () => {
	beforeEach(() => vi.clearAllMocks());

	it("only cancels a still-pending invite owned by the caller", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]);

		await cancelInvite(1, 5);

		const call = mockedDb.query.mock.calls[0];
		expect(call[0]).toContain("status = 'cancelled'");
		expect(call[1]).toEqual([5, 1]);
	});
});
