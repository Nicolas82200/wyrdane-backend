import { describe, expect, it } from "vitest";
import { RARITY_WEIGHTS, MAX_DUPLICATE_WEIGHT_REDUCTION, duplicateWeightFactor, pickWeighted } from "./packModel";
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

describe("duplicateWeightFactor", () => {
	it("leaves weights untouched for an empty collection", () => {
		expect(duplicateWeightFactor(0)).toBe(1);
	});

	it("reaches its strongest reduction on a complete collection", () => {
		expect(duplicateWeightFactor(1)).toBeCloseTo(1 - MAX_DUPLICATE_WEIGHT_REDUCTION, 10);
	});

	it("decreases monotonically with completion", () => {
		const steps = [0, 0.25, 0.5, 0.75, 1].map(duplicateWeightFactor);
		for (let i = 1; i < steps.length; i++) {
			expect(steps[i]).toBeLessThan(steps[i - 1]);
		}
	});

	it("never returns a negative or out-of-range factor, even for absurd input", () => {
		for (const completion of [-5, -0.1, 1.5, 42]) {
			const factor = duplicateWeightFactor(completion);
			expect(factor).toBeGreaterThan(0);
			expect(factor).toBeLessThanOrEqual(1);
		}
	});
});

describe("pickWeighted duplicate protection", () => {
	// Deux cartes de MEME rareté : à poids brut égal, seule la possession peut
	// départager, ce qui isole l'effet de la protection.
	const twinPool = () => [card(1, "Commune"), card(2, "Commune")];

	const shareOfSecond = (owned: Set<number>, completion: number, draws = 6000): number => {
		let second = 0;
		for (let i = 0; i < draws; i++) {
			if (pickWeighted(twinPool(), owned, completion).id === 2) second++;
		}
		return second / draws;
	};

	it("draws both cards equally when neither is owned", () => {
		expect(shareOfSecond(new Set(), 0.5)).toBeGreaterThan(0.45);
		expect(shareOfSecond(new Set(), 0.5)).toBeLessThan(0.55);
	});

	it("strongly favours the missing card over the owned one at high completion", () => {
		// Carte 1 possédée, carte 2 manquante, collection à 100 % (réduction max).
		const share = shareOfSecond(new Set([1]), 1);
		expect(share).toBeGreaterThan(0.85);
	});

	it("barely biases the draw for a beginner, who still needs duplicates", () => {
		// À 10 % de complétion la réduction est faible : le joueur doit continuer
		// à recevoir des exemplaires 2/3/4 des cartes qu'il possède déjà.
		const share = shareOfSecond(new Set([1]), 0.1);
		expect(share).toBeGreaterThan(0.5);
		expect(share).toBeLessThan(0.62);
	});

	it("keeps the original relative weights once every card is owned", () => {
		// Les DEUX cartes possédées : même facteur appliqué aux deux, donc le
		// tirage doit redevenir équiprobable — la protection s'efface.
		const share = shareOfSecond(new Set([1, 2]), 1);
		expect(share).toBeGreaterThan(0.45);
		expect(share).toBeLessThan(0.55);
	});

	it("never lets an owned card's weight fall to zero (a duplicate stays possible)", () => {
		// Carte 1 possédée et SEULE du pool : elle doit rester tirable, sinon
		// pickWeighted ne pourrait plus rien renvoyer une fois tout possédé.
		const pool = [card(1, "Commune")];
		expect(pickWeighted(pool, new Set([1]), 1).id).toBe(1);
	});

	it("behaves exactly like the unprotected draw when no collection is passed", () => {
		const pool = twinPool();
		let second = 0;
		for (let i = 0; i < 4000; i++) {
			if (pickWeighted(pool).id === 2) second++;
		}
		expect(second / 4000).toBeGreaterThan(0.45);
		expect(second / 4000).toBeLessThan(0.55);
	});
});
