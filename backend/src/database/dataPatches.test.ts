import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../model/db", () => ({
	default: { query: vi.fn() },
}));

import pool from "../model/db";
import { runDataPatches } from "./dataPatches";

const mockedPool = pool as unknown as { query: ReturnType<typeof vi.fn> };

describe("runDataPatches", () => {
	beforeEach(() => vi.clearAllMocks());

	it("applies the resource-card rename patches with the expected name and effect text", async () => {
		mockedPool.query.mockResolvedValue([{ affectedRows: 1 }]);

		await runDataPatches();

		expect(mockedPool.query).toHaveBeenCalledWith(
			expect.stringContaining("UPDATE cards SET name = ?, effect = ? WHERE name = ?"),
			["Chair", expect.any(String), "Éclat d'Âme"],
		);
		expect(mockedPool.query).toHaveBeenCalledWith(
			expect.stringContaining("UPDATE cards SET name = ?, effect = ? WHERE name = ?"),
			["Âme", expect.any(String), "Fragment de Pacte"],
		);
	});

	it("applies the rarity/cost fixes that cards_data.sql can no longer deliver to a seeded database", async () => {
		mockedPool.query.mockResolvedValue([{ affectedRows: 1 }]);

		await runDataPatches();

		// Brouillard Pestilentiel est passé Rare → Épique côté client ; tant que
		// la base de prod garde l'ancienne rareté, collectionModel.buyCard le
		// facture au prix d'une Rare et packModel le tire au poids d'une Rare.
		expect(mockedPool.query).toHaveBeenCalledWith(
			expect.stringContaining("UPDATE cards SET rarity = ?, cost = ? WHERE name = ?"),
			["Épique", 4, "Brouillard Pestilentiel", "Épique", 4],
		);
	});

	it("is idempotent: a second run finds nothing left to change (affectedRows 0) and doesn't throw", async () => {
		mockedPool.query.mockResolvedValue([{ affectedRows: 0 }]);

		await expect(runDataPatches()).resolves.not.toThrow();

		// Le nombre d'appels n'est volontairement PAS figé : il augmente à chaque
		// patch ajouté, et le figer faisait casser ce test à chaque ajout sans
		// rien dire de l'idempotence (c'est ce qui est arrivé le 2026-11-12).
		// L'invariant réel est que chaque patch reste une UPDATE conditionnelle :
		// c'est sa clause WHERE qui rend le rejeu sans effet, pas un garde en amont.
		expect(mockedPool.query.mock.calls.length).toBeGreaterThan(0);
		for (const [sql] of mockedPool.query.mock.calls) {
			expect(sql).toMatch(/^UPDATE cards SET .+ WHERE .+/s);
		}
	});
});
