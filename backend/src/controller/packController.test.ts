import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/packModel", () => ({
	openPack: vi.fn(),
	buyPacks: vi.fn(),
	PACK_COST: 500,
	MAX_BUY_QUANTITY: 50,
}));
vi.mock("../model/uniqueQuestModel", () => ({
	progressForPackOpen: vi.fn(),
}));

import { openPack, buyPacks } from "../model/packModel";
import { progressForPackOpen } from "../model/uniqueQuestModel";
import { InsufficientFundsError } from "../model/currencyModel";
import { openPackHandler, openFreePackHandler, buyPacksHandler } from "./packController";

const mockedOpenPack = openPack as ReturnType<typeof vi.fn>;
const mockedBuyPacks = buyPacks as ReturnType<typeof vi.fn>;
const mockedProgressForPackOpen = progressForPackOpen as ReturnType<typeof vi.fn>;

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

describe("openPackHandler", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const req = { user: undefined } as unknown as Request;
		const res = mockRes();
		await openPackHandler(req, res);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("surfaces InsufficientFundsError as a 400 with the pack cost", async () => {
		mockedOpenPack.mockRejectedValue(new InsufficientFundsError());
		const req = { user: { id: 1 } } as unknown as Request;
		const res = mockRes();

		await openPackHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("500") }));
	});

	it("always opens a paid pack (free=false)", async () => {
		mockedOpenPack.mockResolvedValue({ cards: [], balance: 500 });
		const req = { user: { id: 1 } } as unknown as Request;
		const res = mockRes();

		await openPackHandler(req, res);

		expect(mockedOpenPack).toHaveBeenCalledWith(1, false);
	});

	it("progresses the open_packs unique quest with the number of cards drawn", async () => {
		mockedOpenPack.mockResolvedValue({ cards: [{}, {}, {}], balance: 500 });
		const req = { user: { id: 1 } } as unknown as Request;
		const res = mockRes();

		await openPackHandler(req, res);

		expect(mockedProgressForPackOpen).toHaveBeenCalledWith(1, 3);
	});
});

describe("openFreePackHandler", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		delete process.env.DEV_FREE_PACKS;
	});

	it("refuses free packs unless DEV_FREE_PACKS is explicitly enabled", async () => {
		const req = { user: { id: 1 } } as unknown as Request;
		const res = mockRes();

		await openFreePackHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(403);
		expect(mockedOpenPack).not.toHaveBeenCalled();
	});

	it("opens a free pack (free=true) when DEV_FREE_PACKS is enabled", async () => {
		process.env.DEV_FREE_PACKS = "true";
		mockedOpenPack.mockResolvedValue({ cards: [], balance: 1000 });
		const req = { user: { id: 1 } } as unknown as Request;
		const res = mockRes();

		await openFreePackHandler(req, res);

		expect(mockedOpenPack).toHaveBeenCalledWith(1, true);
	});
});

describe("buyPacksHandler", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const req = { user: undefined, body: { quantity: 1 } } as unknown as Request;
		const res = mockRes();
		await buyPacksHandler(req, res);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("rejects a non-integer or out-of-range quantity without calling buyPacks", async () => {
		const res = mockRes();
		for (const quantity of [0, -1, 51, 2.5, "abc"]) {
			await buyPacksHandler({ user: { id: 1 }, body: { quantity } } as unknown as Request, res);
			expect(res.status).toHaveBeenCalledWith(400);
		}
		expect(mockedBuyPacks).not.toHaveBeenCalled();
	});

	it("buys the requested quantity and returns the new balance/free_packs, without opening anything", async () => {
		mockedBuyPacks.mockResolvedValue({ balance: 4000, free_packs: 5 });
		const req = { user: { id: 1 }, body: { quantity: 5 } } as unknown as Request;
		const res = mockRes();

		await buyPacksHandler(req, res);

		expect(mockedBuyPacks).toHaveBeenCalledWith(1, 5);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ balance: 4000, free_packs: 5 });
	});

	it("surfaces InsufficientFundsError as a 400 with the pack cost", async () => {
		mockedBuyPacks.mockRejectedValue(new InsufficientFundsError());
		const req = { user: { id: 1 }, body: { quantity: 3 } } as unknown as Request;
		const res = mockRes();

		await buyPacksHandler(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("500") }));
	});
});
