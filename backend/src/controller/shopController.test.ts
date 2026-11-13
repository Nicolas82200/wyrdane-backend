import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

// Ce qui est testé ici : le prix AFFICHÉ et le prix FACTURÉ sont dans la devise
// du joueur, et un article sans prix dans cette devise est refusé plutôt que
// facturé en euros.
vi.mock("../model/shopModel", () => ({
	getCatalog: vi.fn(),
	findItemById: vi.fn(),
	getUserCosmetics: vi.fn(),
	findSteamId: vi.fn(),
	resolvePrice: vi.fn(),
	resolvePricesForCurrency: vi.fn(),
	createPendingPurchase: vi.fn(),
	setTxnId: vi.fn(),
	lockPendingPurchase: vi.fn(),
	revertToPending: vi.fn(),
	completePurchase: vi.fn(),
	BASE_CURRENCY: "EUR",
}));
vi.mock("../helper/steamMicrotxnHelper", () => ({
	initTxn: vi.fn(),
	finalizeTxn: vi.fn(),
	getUserInfo: vi.fn(),
}));

import {
	getCatalog,
	findItemById,
	findSteamId,
	resolvePrice,
	resolvePricesForCurrency,
	createPendingPurchase,
} from "../model/shopModel";
import { initTxn, getUserInfo } from "../helper/steamMicrotxnHelper";
import { getCatalogHandler, initPurchase } from "./shopController";

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const ITEM = {
	id: 2,
	steam_item_id: "card_back_gold",
	name: "Dos doré",
	category: "card_back",
	price_cents: 199,
};

beforeEach(() => vi.resetAllMocks());

describe("getCatalogHandler", () => {
	it("renvoie les prix dans la devise du portefeuille Steam du joueur", async () => {
		mocked(findSteamId).mockResolvedValue("765611980000001");
		mocked(getUserInfo).mockResolvedValue({ country: "US", currency: "USD" });
		mocked(resolvePricesForCurrency).mockResolvedValue(new Map([[2, 249]]));
		mocked(getCatalog).mockResolvedValue([ITEM]);
		const res = mockRes();

		await getCatalogHandler({ user: { id: 7 } } as unknown as Request, res);

		expect(resolvePricesForCurrency).toHaveBeenCalledWith("USD");
		expect(res.json).toHaveBeenCalledWith([
			expect.objectContaining({ id: 2, price_cents: 249, currency: "USD" }),
		]);
	});

	it("sort un article sans prix dans cette devise avec price_cents null", async () => {
		// Le client l'affiche indisponible : proposer un achat que initPurchase
		// refuserait serait pire.
		mocked(findSteamId).mockResolvedValue("765611980000001");
		mocked(getUserInfo).mockResolvedValue({ country: "NO", currency: "NOK" });
		mocked(resolvePricesForCurrency).mockResolvedValue(new Map());
		mocked(getCatalog).mockResolvedValue([ITEM]);
		const res = mockRes();

		await getCatalogHandler({ user: { id: 7 } } as unknown as Request, res);

		expect(res.json).toHaveBeenCalledWith([
			expect.objectContaining({ price_cents: null, currency: "NOK" }),
		]);
	});

	it("retombe sur l'euro pour une requête non authentifiée", async () => {
		mocked(resolvePricesForCurrency).mockResolvedValue(new Map([[2, 199]]));
		mocked(getCatalog).mockResolvedValue([ITEM]);
		const res = mockRes();

		await getCatalogHandler({ user: undefined } as unknown as Request, res);

		expect(getUserInfo).not.toHaveBeenCalled();
		expect(resolvePricesForCurrency).toHaveBeenCalledWith("EUR");
	});

	it("retombe sur l'euro quand l'API Steam est injoignable", async () => {
		mocked(findSteamId).mockResolvedValue("765611980000001");
		mocked(getUserInfo).mockResolvedValue(null);
		mocked(resolvePricesForCurrency).mockResolvedValue(new Map([[2, 199]]));
		mocked(getCatalog).mockResolvedValue([ITEM]);
		const res = mockRes();

		await getCatalogHandler({ user: { id: 7 } } as unknown as Request, res);

		expect(resolvePricesForCurrency).toHaveBeenCalledWith("EUR");
	});
});

describe("initPurchase", () => {
	it("facture le montant de la devise du joueur, pas le prix en euros", async () => {
		mocked(findItemById).mockResolvedValue(ITEM);
		mocked(findSteamId).mockResolvedValue("765611980000001");
		mocked(getUserInfo).mockResolvedValue({ country: "JP", currency: "JPY" });
		mocked(resolvePrice).mockResolvedValue(240);
		mocked(createPendingPurchase).mockResolvedValue(99);
		mocked(initTxn).mockResolvedValue("trans-1");
		const res = mockRes();

		await initPurchase(
			{ user: { id: 7 }, body: { itemId: 2 } } as unknown as Request,
			res,
		);

		expect(createPendingPurchase).toHaveBeenCalledWith(7, 2, 240, "JPY");
		expect(initTxn).toHaveBeenCalledWith(
			99,
			"765611980000001",
			expect.objectContaining({ amount: 240, currency: "JPY" }),
		);
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("refuse l'achat quand l'article n'a pas de prix dans la devise du joueur", async () => {
		// Jamais de repli sur l'euro : Steam refuserait la devise, et facturer
		// 1,99 € après avoir affiché un prix étranger serait pire qu'un refus.
		mocked(findItemById).mockResolvedValue(ITEM);
		mocked(findSteamId).mockResolvedValue("765611980000001");
		mocked(getUserInfo).mockResolvedValue({ country: "NO", currency: "NOK" });
		mocked(resolvePrice).mockResolvedValue(null);
		const res = mockRes();

		await initPurchase(
			{ user: { id: 7 }, body: { itemId: 2 } } as unknown as Request,
			res,
		);

		expect(res.status).toHaveBeenCalledWith(409);
		expect(createPendingPurchase).not.toHaveBeenCalled();
		expect(initTxn).not.toHaveBeenCalled();
	});

	it("n'ouvre aucune commande quand la devise du joueur est inconnue", async () => {
		mocked(findItemById).mockResolvedValue(ITEM);
		mocked(findSteamId).mockResolvedValue("765611980000001");
		mocked(getUserInfo).mockResolvedValue(null);
		const res = mockRes();

		await initPurchase(
			{ user: { id: 7 }, body: { itemId: 2 } } as unknown as Request,
			res,
		);

		expect(res.status).toHaveBeenCalledWith(502);
		expect(createPendingPurchase).not.toHaveBeenCalled();
	});

	it("rejette une requête non authentifiée", async () => {
		const res = mockRes();
		await initPurchase(
			{ user: undefined, body: { itemId: 2 } } as unknown as Request,
			res,
		);
		expect(res.status).toHaveBeenCalledWith(401);
	});
});
