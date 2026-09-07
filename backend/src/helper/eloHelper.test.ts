import { describe, expect, it } from "vitest";
import { calculateElo } from "./eloHelper";

describe("calculateElo", () => {
	it("swings both ratings by the same amount when players are equally rated", () => {
		const { newRatingA, newRatingB } = calculateElo(1000, 1000, 1);
		expect(newRatingA - 1000).toBe(16);
		expect(1000 - newRatingB).toBe(16);
	});

	it("is zero-sum: a player's change mirrors their opponent's change", () => {
		const win = calculateElo(1200, 1000, 1);
		const loss = calculateElo(1200, 1000, 0);
		expect(win.newRatingA - 1200).toBe(-(win.newRatingB - 1000));
		expect(loss.newRatingA - 1200).toBe(-(loss.newRatingB - 1000));
	});

	it("rewards the underdog more for beating a higher-rated opponent", () => {
		const upset = calculateElo(900, 1300, 1);
		const expectedWin = calculateElo(1300, 1300, 1);
		expect(upset.newRatingA - 900).toBeGreaterThan(expectedWin.newRatingA - 1300);
	});

	it("penalizes a favorite more for losing to a much weaker opponent than an even loss", () => {
		const upsetLoss = calculateElo(1300, 900, 0);
		const evenLoss = calculateElo(1300, 1300, 0);
		expect(1300 - upsetLoss.newRatingA).toBeGreaterThan(1300 - evenLoss.newRatingA);
	});

	it("never lets the winner's rating decrease or the loser's increase", () => {
		for (const [a, b] of [[1000, 1000], [800, 1600], [2000, 400]] as const) {
			const result = calculateElo(a, b, 1);
			expect(result.newRatingA).toBeGreaterThanOrEqual(a);
			expect(result.newRatingB).toBeLessThanOrEqual(b);
		}
	});
});
