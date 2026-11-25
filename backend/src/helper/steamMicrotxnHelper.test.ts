import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	queryTxn,
	TXN_FAILED_STATUSES,
	TXN_UNKNOWN_ORDER,
} from "./steamMicrotxnHelper";

// Ce qui est verrouillé ici : l'API partenaire de Steam répond en HTML, avec un
// code 4xx, dès qu'elle refuse une requête. `res.json()` levait alors, et
// l'exception remontait jusqu'au réconciliateur, qui rejouait les mêmes
// commandes toutes les 5 minutes sans jamais les clore (3 552 lignes de trace
// en prod au 2026-11-25). Et comme on touche à de l'argent, le correctif a une
// contrainte de plus : un refus de Steam ne doit clore une commande que lorsque
// Steam dit explicitement ne pas la connaître.

const htmlResponse = (status: number, body: string): Response =>
	({
		ok: status >= 200 && status < 300,
		status,
		text: async () => body,
		json: async () => {
			throw new SyntaxError("Unexpected token '<'");
		},
	}) as unknown as Response;

const jsonResponse = (payload: unknown): Response =>
	({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(payload),
		json: async () => payload,
	}) as unknown as Response;

const ORDER_UNKNOWN_BODY =
	"<html><head><title>Bad Request</title></head><body><h1>Bad Request</h1>" +
	"No microtransaction with the specified orderid or transid exists</body></html>";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	process.env.STEAM_WEB_API_KEY = "cle-de-test";
	process.env.STEAM_APP_ID = "5052390";
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("queryTxn : réponses non-JSON de Steam", () => {
	it("rend un statut d'échec quand Steam ne connaît pas la commande", async () => {
		fetchMock.mockResolvedValue(htmlResponse(400, ORDER_UNKNOWN_BODY));

		const status = await queryTxn(1);

		expect(status).toBe(TXN_UNKNOWN_ORDER);
		// Le câblage qui compte : rangé parmi les échecs, le réconciliateur
		// appelle markFailed et cesse de rejouer la commande.
		expect(TXN_FAILED_STATUSES.has(status as string)).toBe(true);
	});

	it("ne conclut RIEN sur un 400 dont le motif est autre (clé ou appid invalides)", async () => {
		// Le cas dangereux : si un défaut de configuration faisait clore les
		// commandes, tout joueur ayant réellement payé pendant la panne perdrait
		// son achat sans aucune reprise possible.
		fetchMock.mockResolvedValue(
			htmlResponse(400, "<html><body>Please provide a valid key parameter</body></html>"),
		);

		await expect(queryTxn(42)).resolves.toBeNull();
	});

	it("ne lève pas et ne conclut rien quand l'API est en panne", async () => {
		fetchMock.mockResolvedValue(htmlResponse(503, "<html><body>Service Unavailable</body></html>"));

		await expect(queryTxn(42)).resolves.toBeNull();
	});

	it("lit normalement un statut quand Steam répond en JSON", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				response: { result: "OK", params: { orderid: "42", transid: "t", status: "Approved" } },
			}),
		);

		await expect(queryTxn(42)).resolves.toBe("approved");
	});
});
