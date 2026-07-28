import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/packModel", () => ({
	openPack: vi.fn(),
	PACK_COST: 500,
}));

import { openPack } from "../model/packModel";
import { InsufficientFundsError } from "../model/currencyModel";
import { openPackHandler, openFreePackHandler } from "./packController";

const mockedOpenPack = openPack as ReturnType<typeof vi.fn>;

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
