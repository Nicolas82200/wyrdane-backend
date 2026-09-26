import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/accountModel", () => ({
	exportUserData: vi.fn(),
	deleteUserData: vi.fn(),
}));

import { exportUserData, deleteUserData } from "../model/accountModel";
import { exportMyData, deleteMyAccount } from "./accountController";

const mockedExport = exportUserData as ReturnType<typeof vi.fn>;
const mockedDelete = deleteUserData as ReturnType<typeof vi.fn>;

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	res.setHeader = vi.fn().mockReturnValue(res);
	res.clearCookie = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number | undefined, body: Record<string, unknown> = {}): Request =>
	({ user: userId ? { id: userId } : undefined, body } as unknown as Request);

describe("exportMyData", () => {
	beforeEach(() => vi.resetAllMocks());

	it("refuse une requête non authentifiée", async () => {
		const res = mockRes();
		await exportMyData(reqAs(undefined), res);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(mockedExport).not.toHaveBeenCalled();
	});

	it("n'exporte jamais que les données du demandeur", async () => {
		mockedExport.mockResolvedValue({ exportedAt: "2026-09-26T00:00:00.000Z" });
		const res = mockRes();
		await exportMyData(reqAs(42), res);
		expect(mockedExport).toHaveBeenCalledWith(42);
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("propose le résultat en téléchargement", async () => {
		mockedExport.mockResolvedValue({});
		const res = mockRes();
		await exportMyData(reqAs(7), res);
		expect(res.setHeader).toHaveBeenCalledWith(
			"Content-Disposition",
			'attachment; filename="wyrdane-donnees-7.json"',
		);
	});
});

describe("deleteMyAccount", () => {
	beforeEach(() => vi.resetAllMocks());

	it("refuse une requête non authentifiée", async () => {
		const res = mockRes();
		await deleteMyAccount(reqAs(undefined, { confirm: "SUPPRIMER" }), res);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(mockedDelete).not.toHaveBeenCalled();
	});

	// Le garde-fou qui compte : l'action est irréversible, elle ne doit jamais
	// partir d'une requête approximative.
	it("ne supprime rien sans la confirmation exacte", async () => {
		for (const confirm of [undefined, "", "supprimer", "SUPPRIMER  ", "oui"]) {
			const res = mockRes();
			await deleteMyAccount(reqAs(1, confirm === undefined ? {} : { confirm }), res);
			expect(res.status).toHaveBeenCalledWith(400);
		}
		expect(mockedDelete).not.toHaveBeenCalled();
	});

	it("supprime et invalide la session quand la confirmation est exacte", async () => {
		mockedDelete.mockResolvedValue(undefined);
		const res = mockRes();
		await deleteMyAccount(reqAs(9, { confirm: "SUPPRIMER" }), res);
		expect(mockedDelete).toHaveBeenCalledWith(9);
		expect(res.clearCookie).toHaveBeenCalledWith("auth_token", expect.anything());
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("répond 500 sans toucher au cookie si la suppression échoue", async () => {
		mockedDelete.mockRejectedValue(new Error("db down"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const res = mockRes();
		await deleteMyAccount(reqAs(9, { confirm: "SUPPRIMER" }), res);
		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.clearCookie).not.toHaveBeenCalled();
	});
});
