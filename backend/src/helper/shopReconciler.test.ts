import { beforeEach, describe, expect, it, vi } from "vitest";

// Le réconciliateur touche à de l'argent : ce qui est testé ici, c'est
// exactement la table de décision « statut Steam → action », parce que s'y
// tromper signifie soit créditer un cosmétique non payé, soit retirer un
// cosmétique payé.
vi.mock("./steamMicrotxnHelper", async () => {
	const actual = await import("./steamMicrotxnHelper");
	return {
		...actual,
		queryTxn: vi.fn(),
		finalizeTxn: vi.fn(),
	};
});
vi.mock("../model/shopModel", () => ({
	findUnfinishedPurchases: vi.fn(),
	findCompletedToRecheck: vi.fn(),
	lockPendingPurchase: vi.fn(),
	revertToPending: vi.fn(),
	completePurchase: vi.fn(),
	touchChecked: vi.fn(),
	markFailed: vi.fn(),
	revokePurchase: vi.fn(),
}));

import { queryTxn, finalizeTxn } from "./steamMicrotxnHelper";
import {
	findUnfinishedPurchases,
	findCompletedToRecheck,
	lockPendingPurchase,
	revertToPending,
	completePurchase,
	touchChecked,
	markFailed,
	revokePurchase,
} from "../model/shopModel";
import { reconcileOnce, ABANDON_AFTER_HOURS } from "./shopReconciler";

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const hoursAgo = (hours: number): string =>
	new Date(Date.now() - hours * 3_600_000).toISOString();

const purchase = (overrides: Record<string, unknown> = {}) => ({
	id: 1,
	user_id: 7,
	item_id: 3,
	order_id: 42,
	steam_txn_id: "t1",
	status: "pending",
	amount: 199,
	currency: "EUR",
	last_checked_at: null,
	created_at: hoursAgo(1),
	...overrides,
});

beforeEach(() => {
	vi.resetAllMocks();
	mocked(findUnfinishedPurchases).mockResolvedValue([]);
	mocked(findCompletedToRecheck).mockResolvedValue([]);
	mocked(lockPendingPurchase).mockResolvedValue(purchase());
});

describe("rattrapage d'une commande non aboutie", () => {
	it("finalise puis crédite une transaction autorisée mais non finalisée", async () => {
		// C'est LE cas du joueur qui paie puis ferme le jeu avant que le client
		// n'appelle /finalize-txn.
		mocked(findUnfinishedPurchases).mockResolvedValue([purchase()]);
		mocked(queryTxn).mockResolvedValue("approved");
		mocked(finalizeTxn).mockResolvedValue(true);

		const summary = await reconcileOnce();

		expect(finalizeTxn).toHaveBeenCalledWith(42);
		expect(completePurchase).toHaveBeenCalledWith(42, 7, 3);
		expect(summary.credited).toBe(1);
	});

	it("crédite sans refinaliser une transaction déjà réussie côté Steam", async () => {
		mocked(findUnfinishedPurchases).mockResolvedValue([purchase()]);
		mocked(queryTxn).mockResolvedValue("succeeded");

		await reconcileOnce();

		expect(finalizeTxn).not.toHaveBeenCalled();
		expect(completePurchase).toHaveBeenCalledWith(42, 7, 3);
	});

	it("rend la commande au prochain tour si la finalisation Steam échoue", async () => {
		// Un refus peut être transitoire : surtout ne pas clore l'achat dessus.
		mocked(findUnfinishedPurchases).mockResolvedValue([purchase()]);
		mocked(queryTxn).mockResolvedValue("approved");
		mocked(finalizeTxn).mockResolvedValue(false);

		const summary = await reconcileOnce();

		expect(revertToPending).toHaveBeenCalledWith(42);
		expect(completePurchase).not.toHaveBeenCalled();
		expect(markFailed).not.toHaveBeenCalled();
		expect(summary.skipped).toBe(1);
	});

	it("ne conclut rien quand Steam ne répond pas", async () => {
		// Garde-fou central : traiter un silence de l'API comme un échec de
		// paiement annulerait des achats valides.
		mocked(findUnfinishedPurchases).mockResolvedValue([purchase()]);
		mocked(queryTxn).mockResolvedValue(null);

		const summary = await reconcileOnce();

		expect(markFailed).not.toHaveBeenCalled();
		expect(completePurchase).not.toHaveBeenCalled();
		expect(summary.skipped).toBe(1);
	});

	it("abandonne une transaction échouée", async () => {
		mocked(findUnfinishedPurchases).mockResolvedValue([purchase()]);
		mocked(queryTxn).mockResolvedValue("failed");

		const summary = await reconcileOnce();

		expect(markFailed).toHaveBeenCalledWith(42);
		expect(completePurchase).not.toHaveBeenCalled();
		expect(summary.failed).toBe(1);
	});

	it("laisse vivre une transaction encore au stade Init si elle est récente", async () => {
		mocked(findUnfinishedPurchases).mockResolvedValue([
			purchase({ created_at: hoursAgo(1) }),
		]);
		mocked(queryTxn).mockResolvedValue("init");

		const summary = await reconcileOnce();

		expect(markFailed).not.toHaveBeenCalled();
		expect(summary.skipped).toBe(1);
	});

	it("abandonne une transaction restée au stade Init trop longtemps", async () => {
		mocked(findUnfinishedPurchases).mockResolvedValue([
			purchase({ created_at: hoursAgo(ABANDON_AFTER_HOURS + 1) }),
		]);
		mocked(queryTxn).mockResolvedValue("init");

		const summary = await reconcileOnce();

		expect(markFailed).toHaveBeenCalledWith(42);
		expect(summary.failed).toBe(1);
	});

	it("ne crédite pas si le verrou est déjà pris par la route de finalisation", async () => {
		mocked(findUnfinishedPurchases).mockResolvedValue([purchase()]);
		mocked(queryTxn).mockResolvedValue("succeeded");
		mocked(lockPendingPurchase).mockResolvedValue(null);

		const summary = await reconcileOnce();

		expect(completePurchase).not.toHaveBeenCalled();
		expect(summary.skipped).toBe(1);
	});

	it("poursuit le tour quand une commande lève une erreur", async () => {
		mocked(findUnfinishedPurchases).mockResolvedValue([
			purchase({ order_id: 1 }),
			purchase({ order_id: 2 }),
		]);
		mocked(queryTxn)
			.mockRejectedValueOnce(new Error("réseau"))
			.mockResolvedValueOnce("failed");
		vi.spyOn(console, "error").mockImplementation(() => {});

		const summary = await reconcileOnce();

		expect(markFailed).toHaveBeenCalledWith(2);
		expect(summary.failed).toBe(1);
	});
});

describe("surveillance des remboursements", () => {
	it("retire le cosmétique d'une commande remboursée", async () => {
		mocked(findCompletedToRecheck).mockResolvedValue([
			purchase({ status: "completed" }),
		]);
		mocked(queryTxn).mockResolvedValue("refunded");

		const summary = await reconcileOnce();

		expect(revokePurchase).toHaveBeenCalledWith(42, 7, 3);
		expect(summary.revoked).toBe(1);
	});

	it("retire aussi sur rétrofacturation et remboursement partiel", async () => {
		for (const status of ["chargeback", "partialrefund", "revokedbydevparams"]) {
			vi.resetAllMocks();
			mocked(findUnfinishedPurchases).mockResolvedValue([]);
			mocked(findCompletedToRecheck).mockResolvedValue([
				purchase({ status: "completed" }),
			]);
			mocked(queryTxn).mockResolvedValue(status);

			await reconcileOnce();

			expect(revokePurchase, `statut ${status}`).toHaveBeenCalledWith(42, 7, 3);
		}
	});

	it("marque simplement la commande comme vue quand elle est toujours valide", async () => {
		mocked(findCompletedToRecheck).mockResolvedValue([
			purchase({ status: "completed" }),
		]);
		mocked(queryTxn).mockResolvedValue("succeeded");

		await reconcileOnce();

		expect(touchChecked).toHaveBeenCalledWith(42);
		expect(revokePurchase).not.toHaveBeenCalled();
	});

	it("ne retire rien quand Steam ne répond pas", async () => {
		mocked(findCompletedToRecheck).mockResolvedValue([
			purchase({ status: "completed" }),
		]);
		mocked(queryTxn).mockResolvedValue(null);

		await reconcileOnce();

		expect(revokePurchase).not.toHaveBeenCalled();
		expect(touchChecked).not.toHaveBeenCalled();
	});
});
