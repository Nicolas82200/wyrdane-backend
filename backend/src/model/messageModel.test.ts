import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
	},
}));

import db from "./db";
import { sendMessage, getConversation, markConversationRead, getUnreadTotal } from "./messageModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn> };

describe("sendMessage", () => {
	beforeEach(() => vi.clearAllMocks());

	it("trims and inserts the message, then returns the inserted row", async () => {
		mockedDb.query.mockResolvedValueOnce([{ insertId: 7 }]);
		mockedDb.query.mockResolvedValueOnce([[{ id: 7, sender_id: 1, recipient_id: 2, body: "salut" }]]);

		const message = await sendMessage(1, 2, "  salut  ");

		expect(mockedDb.query.mock.calls[0][1]).toEqual([1, 2, "salut"]);
		expect(message).toEqual({ id: 7, sender_id: 1, recipient_id: 2, body: "salut" });
	});

	it("truncates a body longer than the max length", async () => {
		mockedDb.query.mockResolvedValueOnce([{ insertId: 8 }]);
		mockedDb.query.mockResolvedValueOnce([[{}]]);

		const longBody = "a".repeat(600);
		await sendMessage(1, 2, longBody);

		const inserted = mockedDb.query.mock.calls[0][1][2] as string;
		expect(inserted.length).toBe(500);
	});
});

describe("getConversation", () => {
	beforeEach(() => vi.clearAllMocks());

	it("queries both message directions between the two users", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);

		await getConversation(1, 2, 50);

		const [sql, params] = mockedDb.query.mock.calls[0];
		expect(sql).not.toContain("id <");
		expect(params).toEqual([1, 2, 2, 1, 50]);
	});

	it("adds the beforeId cursor when provided", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);

		await getConversation(1, 2, 20, 99);

		const [sql, params] = mockedDb.query.mock.calls[0];
		expect(sql).toContain("id <");
		expect(params).toEqual([1, 2, 2, 1, 99, 20]);
	});
});

describe("markConversationRead", () => {
	beforeEach(() => vi.clearAllMocks());

	it("only marks messages received FROM that friend as read", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]);

		await markConversationRead(1, 2);

		expect(mockedDb.query.mock.calls[0][1]).toEqual([1, 2]);
	});
});

describe("getUnreadTotal", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns the count from the query result", async () => {
		mockedDb.query.mockResolvedValueOnce([[{ total: 3 }]]);
		await expect(getUnreadTotal(1)).resolves.toBe(3);
	});

	it("returns 0 when there is no row", async () => {
		mockedDb.query.mockResolvedValueOnce([[]]);
		await expect(getUnreadTotal(1)).resolves.toBe(0);
	});
});
