import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../helper/jwtHelper", () => ({
	decodeJWT: vi.fn(),
}));

import { decodeJWT } from "../helper/jwtHelper";
import authorization from "./auth";
import { markAccountDeleted, _resetDeletedAccounts, JWT_MAX_LIFETIME_MS } from "./deletedAccount";

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

describe("authorization middleware", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetDeletedAccounts();
	});

	it("rejects with 401 when there is no auth_token cookie", () => {
		const req = { cookies: {} } as unknown as Request;
		const res = mockRes();
		const next = vi.fn();

		authorization(req, res, next);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(next).not.toHaveBeenCalled();
	});

	it("rejects with 401 when decodeJWT throws (invalid/expired token)", () => {
		const req = { cookies: { auth_token: "Bearer bad.token.here" } } as unknown as Request;
		const res = mockRes();
		const next = vi.fn();
		(decodeJWT as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("jwt expired");
		});

		authorization(req, res, next);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(next).not.toHaveBeenCalled();
	});

	it("sets req.user and calls next() for a valid token", () => {
		const req = { cookies: { auth_token: "Bearer good.token.here" } } as unknown as Request;
		const res = mockRes();
		const next = vi.fn();
		(decodeJWT as ReturnType<typeof vi.fn>).mockReturnValue({ id: 7, name: "Joueur" });

		authorization(req, res, next);

		expect(decodeJWT).toHaveBeenCalledWith("good.token.here");
		expect(req.user).toEqual({ id: 7, name: "Joueur" });
		expect(next).toHaveBeenCalledTimes(1);
		expect(res.status).not.toHaveBeenCalled();
	});

	// Suppression de compte (RGPD) : un JWT émis avant la suppression reste
	// cryptographiquement valide jusqu'à 1h. Sans ce refus, une seconde session
	// (jeu + site ouverts ensemble) continuait d'agir sur le compte effacé.
	it("rejects a valid token whose account has just been deleted", () => {
		(decodeJWT as ReturnType<typeof vi.fn>).mockReturnValue({ id: 42, name: "x" });
		markAccountDeleted(42);
		const req = { cookies: { auth_token: "Bearer good.token" } } as unknown as Request;
		const res = mockRes();
		const next = vi.fn();

		authorization(req, res, next);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(next).not.toHaveBeenCalled();
	});

	it("lets other accounts through when one has been deleted", () => {
		(decodeJWT as ReturnType<typeof vi.fn>).mockReturnValue({ id: 7, name: "x" });
		markAccountDeleted(42);
		const req = { cookies: { auth_token: "Bearer good.token" } } as unknown as Request;
		const res = mockRes();
		const next = vi.fn();

		authorization(req, res, next);

		expect(next).toHaveBeenCalled();
		expect(res.status).not.toHaveBeenCalled();
	});

	// L'entrée ne doit pas devenir un bannissement permanent : passé la durée de
	// vie d'un JWT, aucun token d'avant la suppression ne peut plus être valide,
	// et le même identifiant pourrait être réattribué.
	it("stops rejecting once no pre-deletion token can still be valid", () => {
		(decodeJWT as ReturnType<typeof vi.fn>).mockReturnValue({ id: 42, name: "x" });
		markAccountDeleted(42);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + JWT_MAX_LIFETIME_MS + 1000);
		const req = { cookies: { auth_token: "Bearer good.token" } } as unknown as Request;
		const res = mockRes();
		const next = vi.fn();

		authorization(req, res, next);

		expect(next).toHaveBeenCalled();
		expect(res.status).not.toHaveBeenCalled();
	});
});
