import { describe, expect, it } from "vitest";
import { RARITY_WEIGHTS, pickWeighted } from "./packModel";
import type { Cards } from "../types";
import type { RowDataPacket } from "mysql2";

type DrawableCardRow = Cards & RowDataPacket;

const card = (id: number, rarity: string): DrawableCardRow =>
	({ id, rarity }) as DrawableCardRow;

describe("RARITY_WEIGHTS", () => {
	it("has a strictly positive weight for every rarity used by CARD_PRICE_BY_RARITY", () => {
		const rarities = Object.keys(RARITY_WEIGHTS);
		expect(rarities).toEqual(["Commune", "Rare", "Épique", "Légendaire"]);
		for (const rarity of rarities) {
			expect(RARITY_WEIGHTS[rarity]).toBeGreaterThan(0);
		}
	});

	it("is monotonically decreasing from Commune to Légendaire (rarer = less likely)", () => {
		expect(RARITY_WEIGHTS.Commune).toBeGreaterThan(RARITY_WEIGHTS.Rare);
		expect(RARITY_WEIGHTS.Rare).toBeGreaterThan(RARITY_WEIGHTS["Épique"]);
		expect(RARITY_WEIGHTS["Épique"]).toBeGreaterThan(RARITY_WEIGHTS["Légendaire"]);
	});
});

describe("pickWeighted", () => {
	it("only ever returns a card from the given pool", () => {
		const pool = [card(1, "Commune"), card(2, "Rare"), card(3, "Légendaire")];
		for (let i = 0; i < 200; i++) {
			const picked = pickWeighted(pool);
			expect(pool.map((c) => c.id)).toContain(picked.id);
		}
	});

	it("always returns the single card in a one-card pool", () => {
		const pool = [card(1, "Commune")];
		for (let i = 0; i < 20; i++) {
			expect(pickWeighted(pool).id).toBe(1);
		}
	});

	it("approximates the configured rarity ratios over many draws", () => {
		const pool = [card(1, "Commune"), card(2, "Rare"), card(3, "Épique"), card(4, "Légendaire")];
		const draws = 20000;
		const counts: Record<string, number> = { Commune: 0, Rare: 0, "Épique": 0, "Légendaire": 0 };
		for (let i = 0; i < draws; i++) {
			counts[pickWeighted(pool).rarity as string]++;
		}

		const totalWeight = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
		for (const rarity of Object.keys(RARITY_WEIGHTS)) {
			const expectedRatio = RARITY_WEIGHTS[rarity] / totalWeight;
			const actualRatio = counts[rarity] / draws;
			// Tolérance large (+/- 3 points de pourcentage) pour un test
			// statistique non-flaky tout en détectant une vraie régression
			// de pondération (ex. poids inversés ou table vidée).
			expect(actualRatio).toBeGreaterThan(expectedRatio - 0.03);
			expect(actualRatio).toBeLessThan(expectedRatio + 0.03);
		}
	});

	it("falls back to the last card if rarity weights don't cover the whole pool (unknown rarity)", () => {
		const pool = [card(1, "InconnuInvalide")];
		expect(pickWeighted(pool).id).toBe(1);
	});
});
