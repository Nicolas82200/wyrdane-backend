import { describe, expect, it, vi } from "vitest";

// Ce test existe pour une raison précise : le matchmaking est resté cassé après
// un premier correctif "complet" (ids de lobby passés en string de bout en bout)
// parce que mysql2 arrondissait le BIGINT DANS LE DRIVER, avant tout code
// applicatif — `if (len >= 14 && !supportBigNumbers) return Number(s)`. Les
// types TypeScript annonçaient `string`, les 442 tests mockaient la base avec
// des chaînes, et rien n'a rien vu. Seul un test sur la vraie configuration du
// pool peut attraper ça : il échoue si quelqu'un retire supportBigNumbers.

const createPool = vi.fn(() => ({}));
vi.mock("mysql2/promise", () => ({ default: { createPool } }));

const poolOptions = async (): Promise<Record<string, unknown>> => {
	vi.resetModules();
	createPool.mockClear();
	await import("./db");
	expect(createPool).toHaveBeenCalledTimes(1);
	return createPool.mock.calls[0][0] as unknown as Record<string, unknown>;
};

describe("pool mysql2", () => {
	it("enables supportBigNumbers so a 64-bit BIGINT is not silently rounded", async () => {
		expect((await poolOptions()).supportBigNumbers).toBe(true);
	});

	// bigNumberStrings forcerait TOUT entier en string, y compris les petits :
	// on veut au contraire le comportement conditionnel de supportBigNumbers
	// (string uniquement si la valeur ne tient pas exactement dans un Number),
	// pour ne pas changer le type des autres BIGINT du schéma
	// (purchase_ledger.order_id est un auto-increment, toujours petit).
	it("does not force every integer to a string", async () => {
		expect((await poolOptions()).bigNumberStrings).toBeUndefined();
	});

	it("keeps the explicit utf8mb4 charset that avoids mojibake on accents", async () => {
		expect((await poolOptions()).charset).toBe("utf8mb4");
	});
});
