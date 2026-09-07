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

	it("is idempotent: a second run finds nothing left to rename (affectedRows 0) and doesn't throw", async () => {
		mockedPool.query.mockResolvedValue([{ affectedRows: 0 }]);

		await expect(runDataPatches()).resolves.not.toThrow();
		expect(mockedPool.query).toHaveBeenCalledTimes(2);
	});
});
