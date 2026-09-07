import { describe, expect, it } from "vitest";
import { CARD_PRICE_BY_RARITY, DUST_VALUE_BY_RARITY, MAX_COPIES_PER_CARD } from "./collectionModel";

const RARITIES = ["Commune", "Rare", "Épique", "Légendaire"];

describe("CARD_PRICE_BY_RARITY", () => {
	it("defines a positive price for every rarity", () => {
		for (const rarity of RARITIES) {
			expect(CARD_PRICE_BY_RARITY[rarity]).toBeGreaterThan(0);
		}
	});

	it("is monotonically increasing with rarity (rarer cards cost more)", () => {
		expect(CARD_PRICE_BY_RARITY.Commune).toBeLessThan(CARD_PRICE_BY_RARITY.Rare);
		expect(CARD_PRICE_BY_RARITY.Rare).toBeLessThan(CARD_PRICE_BY_RARITY["Épique"]);
		expect(CARD_PRICE_BY_RARITY["Épique"]).toBeLessThan(CARD_PRICE_BY_RARITY["Légendaire"]);
	});
});

describe("DUST_VALUE_BY_RARITY", () => {
	it("defines a positive dust value for every rarity", () => {
		for (const rarity of RARITIES) {
			expect(DUST_VALUE_BY_RARITY[rarity]).toBeGreaterThan(0);
		}
	});

	it("is monotonically increasing with rarity", () => {
		expect(DUST_VALUE_BY_RARITY.Commune).toBeLessThan(DUST_VALUE_BY_RARITY.Rare);
		expect(DUST_VALUE_BY_RARITY.Rare).toBeLessThan(DUST_VALUE_BY_RARITY["Épique"]);
		expect(DUST_VALUE_BY_RARITY["Épique"]).toBeLessThan(DUST_VALUE_BY_RARITY["Légendaire"]);
	});

	it("never dusts a card for more gold than buying it outright would cost", () => {
		for (const rarity of RARITIES) {
			expect(DUST_VALUE_BY_RARITY[rarity]).toBeLessThan(CARD_PRICE_BY_RARITY[rarity]);
		}
	});
});

describe("MAX_COPIES_PER_CARD", () => {
	it("is a positive integer matching the client's DeckBuilder.MAX_COPIES", () => {
		expect(MAX_COPIES_PER_CARD).toBe(4);
	});
});
