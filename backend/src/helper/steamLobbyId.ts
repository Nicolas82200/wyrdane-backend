// Un id de lobby Steam est un CSteamID 64 bits (18 chiffres, 57 bits
// significatifs) : il ne tient pas dans un double (53 bits de mantisse) et doit
// donc voyager en chaîne de chiffres, de la base jusqu'au client Godot.
//
// Deux endroits l'ont déjà corrompu par le passé, et les deux sont silencieux :
//   1. `JSON.parse` du body / `Number(...)` à la sérialisation côté Express ;
//   2. mysql2 lui-même, qui arrondit tout BIGINT >= 14 chiffres quand
//      `supportBigNumbers` est absent (voir model/db.ts).
// Dans les deux cas l'invité rejoignait un lobby voisin inexistant, Steam
// refusait l'entrée en code 2 (k_EChatRoomEnterResponseDoesntExist) et les deux
// joueurs repartaient en boucle de matchmaking sans jamais se connecter — un
// échec sans erreur nulle part, d'où ces gardes explicites.

// Valide un id reçu d'un client (report-lobby, création d'invitation).
const LOBBY_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

const isValidLobbyId = (raw: unknown): raw is string =>
	typeof raw === "string" && LOBBY_ID_PATTERN.test(raw);

// Normalise un id lu en base avant de le renvoyer au client. Une valeur
// `number` ici signifie que `supportBigNumbers` a été perdu côté pool : l'id est
// DÉJÀ arrondi et irrécupérable (l'information est perdue dans le driver), donc
// on ne fait pas semblant de le réparer — on le journalise bruyamment pour que
// la régression soit diagnosticable côté serveur, le client Godot émettant de
// son côté son propre avertissement (voir BackendClient.parse_lobby_id).
const toExactLobbyId = (raw: unknown): string | undefined => {
	if (raw === null || raw === undefined) return undefined;
	if (typeof raw === "string") return raw;
	console.error(
		`[steamLobbyId] id de lobby reçu de la base en ${typeof raw} (${String(raw)}) et non en string : ` +
			"la précision 64 bits est déjà perdue, vérifier supportBigNumbers dans model/db.ts",
	);
	return String(raw);
};

export { isValidLobbyId, toExactLobbyId, LOBBY_ID_PATTERN };
