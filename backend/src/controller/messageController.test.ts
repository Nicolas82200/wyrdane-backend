import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/friendModel", () => ({
	findFriendship: vi.fn(),
}));
vi.mock("../model/messageModel", () => ({
	MAX_BODY_LENGTH: 500,
	sendMessage: vi.fn(),
	getConversation: vi.fn(),
	getConversations: vi.fn(),
	markConversationRead: vi.fn(),
	getUnreadTotal: vi.fn(),
}));

import { findFriendship } from "../model/friendModel";
import { sendMessage, getConversation, getConversations, markConversationRead, getUnreadTotal } from "../model/messageModel";
import { send, conversation, conversations, markRead, unreadTotal } from "./messageController";

const mocked = {
	findFriendship: findFriendship as ReturnType<typeof vi.fn>,
	sendMessage: sendMessage as ReturnType<typeof vi.fn>,
	getConversation: getConversation as ReturnType<typeof vi.fn>,
	getConversations: getConversations as ReturnType<typeof vi.fn>,
	markConversationRead: markConversationRead as ReturnType<typeof vi.fn>,
	getUnreadTotal: getUnreadTotal as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number | undefined, extra: Record<string, unknown> = {}): Request =>
	({ user: userId ? { id: userId } : undefined, query: {}, params: {}, body: {}, ...extra } as unknown as Request);

describe("send", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects an empty body", async () => {
		const res = mockRes();
		await send(reqAs(1, { body: { recipientId: 2, body: "   " } }), res);
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendMessage).not.toHaveBeenCalled();
	});

	it("rejects a message to someone who isn't a friend", async () => {
		mocked.findFriendship.mockResolvedValue(null);
		const res = mockRes();
		await send(reqAs(1, { body: { recipientId: 2, body: "salut" } }), res);
		expect(res.status).toHaveBeenCalledWith(403);
		expect(mocked.sendMessage).not.toHaveBeenCalled();
	});

	it("rejects a message to a pending (not yet accepted) relation", async () => {
		mocked.findFriendship.mockResolvedValue({ status: "pending" });
		const res = mockRes();
		await send(reqAs(1, { body: { recipientId: 2, body: "salut" } }), res);
		expect(res.status).toHaveBeenCalledWith(403);
	});

	it("sends the message when the two are accepted friends", async () => {
		mocked.findFriendship.mockResolvedValue({ status: "accepted" });
		mocked.sendMessage.mockResolvedValue({ id: 1, body: "salut" });
		const res = mockRes();
		await send(reqAs(1, { body: { recipientId: 2, body: "salut" } }), res);
		expect(mocked.sendMessage).toHaveBeenCalledWith(1, 2, "salut");
		expect(res.status).toHaveBeenCalledWith(200);
	});
});

describe("conversation", () => {
	beforeEach(() => vi.resetAllMocks());

	it("forwards limit and beforeId to the model", async () => {
		mocked.getConversation.mockResolvedValue([]);
		const res = mockRes();
		await conversation(reqAs(1, { params: { friendId: "2" }, query: { limit: "10", beforeId: "99" } }), res);
		expect(mocked.getConversation).toHaveBeenCalledWith(1, 2, 10, 99);
	});
});

describe("conversations", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns the caller's conversation list", async () => {
		mocked.getConversations.mockResolvedValue([]);
		const res = mockRes();
		await conversations(reqAs(1), res);
		expect(mocked.getConversations).toHaveBeenCalledWith(1);
	});
});

describe("markRead", () => {
	beforeEach(() => vi.resetAllMocks());

	it("marks the conversation with that friend as read", async () => {
		const res = mockRes();
		await markRead(reqAs(1, { params: { friendId: "2" } }), res);
		expect(mocked.markConversationRead).toHaveBeenCalledWith(1, 2);
	});
});

describe("unreadTotal", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns the caller's unread total", async () => {
		mocked.getUnreadTotal.mockResolvedValue(4);
		const res = mockRes();
		await unreadTotal(reqAs(1), res);
		expect(res.json).toHaveBeenCalledWith({ total: 4 });
	});
});
