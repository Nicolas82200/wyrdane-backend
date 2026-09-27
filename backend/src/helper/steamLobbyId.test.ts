import { describe, expect, it, vi, afterEach } from "vitest";
import { isValidLobbyId, toExactLobbyId } from "./steamLobbyId";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isValidLobbyId", () => {
	it("accepts a 64-bit CSteamID sent as a digit string", () => {
		expect(isValidLobbyId("109775243141593584")).toBe(true);
	});

	// Un client pas encore mis à jour envoie un nombre : l'id est déjà arrondi
	// par JSON.parse, on le refuse plutôt que d'enregistrer une valeur corrompue.
	it("rejects a number, which has already lost precision", () => {
		expect(isValidLobbyId(109775243141593584)).toBe(false);
	});

	it("rejects anything that is not a plain positive integer string", () => {
		for (const raw of ["", "0", "-1", "12.5", "1e18", " 123", "123abc", null, undefined, {}]) {
			expect(isValidLobbyId(raw)).toBe(false);
		}
	});
});

describe("toExactLobbyId", () => {
	it("passes a string straight through, untouched", () => {
		expect(toExactLobbyId("109775243141593584")).toBe("109775243141593584");
	});

	it("reports no lobby yet when the column is still NULL", () => {
		// L'invité repolle tant que l'hôte n'a pas appelé report-lobby.
		expect(toExactLobbyId(null)).toBeUndefined();
		expect(toExactLobbyId(undefined)).toBeUndefined();
	});

	// Le symptôme du bug : mysql2 sans supportBigNumbers renvoyait un number.
	// On ne peut plus récupérer l'id (l'arrondi a eu lieu dans le driver), mais
	// ça ne doit plus jamais être silencieux.
	it("logs loudly when the driver hands back a number instead of a string", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		toExactLobbyId(109775243141593584);
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0][0]).toContain("supportBigNumbers");
	});
});
