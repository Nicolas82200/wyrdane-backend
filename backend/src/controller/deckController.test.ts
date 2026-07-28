import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/decksModel", () => ({
	findByUserId: vi.fn(),
	findCardsByDeckId: vi.fn(),
	findById: vi.fn(),
	create: vi.fn(),
	updateName: vi.fn(),
	replaceCards: vi.fn(),
	deleteDeck: vi.fn(),
}));
vi.mock("../model/collectionModel", () => ({
	findMissing: vi.fn(),
}));

import { findById, create, updateName, replaceCards, deleteDeck } from "../model/decksModel";
import { findMissing } from "../model/collectionModel";
import { save, remove } from "./deckController";

const mocked = {
	findById: findById as ReturnType<typeof vi.fn>,
	create: create as ReturnType<typeof vi.fn>,
	updateName: updateName as ReturnType<typeof vi.fn>,
	replaceCards: replaceCards as ReturnType<typeof vi.fn>,
	deleteDeck: deleteDeck as ReturnType<typeof vi.fn>,
	findMissing: findMissing as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	res.send = vi.fn().mockReturnValue(res);
	return res;
};

describe("save (deck create/update)", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects entries that exceed the max copies per card", async () => {
		mocked.findMissing.mockResolvedValue([]);
		const req = {
			user: { id: 1 },
			params: {},
			body: { name: "Mon deck", entries: [{ cardId: 1, quantity: 5 }] },
		} as unknown as Request;
		const res = mockRes();

		await save(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.create).not.toHaveBeenCalled();
	});

	it("rejects a deck referencing cards the player doesn't own in sufficient quantity", async () => {
		mocked.findMissing.mockResolvedValue([{ cardId: 1, quantity: 4 }]);
		const req = {
			user: { id: 1 },
			params: {},
			body: { name: "Mon deck", entries: [{ cardId: 1, quantity: 4 }] },
		} as unknown as Request;
		const res = mockRes();

		await save(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.create).not.toHaveBeenCalled();
	});

	it("refuses to update a deck owned by another player", async () => {
		mocked.findMissing.mockResolvedValue([]);
		mocked.findById.mockResolvedValue({ id: 9, user_id: 2, name: "Deck d'un autre" });
		const req = {
			user: { id: 1 },
			params: { id: "9" },
			body: { name: "Mon deck", entries: [] },
		} as unknown as Request;
		const res = mockRes();

		await save(req, res);

		expect(res.status).toHaveBeenCalledWith(404);
		expect(mocked.updateName).not.toHaveBeenCalled();
		expect(mocked.replaceCards).not.toHaveBeenCalled();
	});

	it("creates a new deck when no id param is given", async () => {
		mocked.findMissing.mockResolvedValue([]);
		mocked.create.mockResolvedValue(42);
		const req = {
			user: { id: 1 },
			params: {},
			body: { name: "Mon deck", entries: [{ cardId: 1, quantity: 2 }] },
		} as unknown as Request;
		const res = mockRes();

		await save(req, res);

		expect(mocked.create).toHaveBeenCalledWith(1, "Mon deck");
		expect(mocked.replaceCards).toHaveBeenCalledWith(42, [{ cardId: 1, quantity: 2 }]);
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("updates an existing deck owned by the caller", async () => {
		mocked.findMissing.mockResolvedValue([]);
		mocked.findById.mockResolvedValue({ id: 9, user_id: 1, name: "Ancien nom" });
		const req = {
			user: { id: 1 },
			params: { id: "9" },
			body: { name: "Nouveau nom", entries: [] },
		} as unknown as Request;
		const res = mockRes();

		await save(req, res);

		expect(mocked.updateName).toHaveBeenCalledWith(9, "Nouveau nom");
		expect(mocked.create).not.toHaveBeenCalled();
	});
});

describe("remove (deck delete)", () => {
	beforeEach(() => vi.resetAllMocks());

	it("refuses to delete a deck owned by another player", async () => {
		mocked.findById.mockResolvedValue({ id: 9, user_id: 2 });
		const req = { user: { id: 1 }, params: { id: "9" } } as unknown as Request;
		const res = mockRes();

		await remove(req, res);

		expect(res.status).toHaveBeenCalledWith(404);
		expect(mocked.deleteDeck).not.toHaveBeenCalled();
	});

	it("deletes a deck owned by the caller", async () => {
		mocked.findById.mockResolvedValue({ id: 9, user_id: 1 });
		const req = { user: { id: 1 }, params: { id: "9" } } as unknown as Request;
		const res = mockRes();

		await remove(req, res);

		expect(mocked.deleteDeck).toHaveBeenCalledWith(1, 9);
		expect(res.status).toHaveBeenCalledWith(204);
	});
});
