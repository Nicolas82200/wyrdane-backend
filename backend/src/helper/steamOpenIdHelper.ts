// Flow "Sign in through Steam" pour le site web (navigateur), distinct du
// flow à ticket utilisé par le client Godot (voir steamHelper.ts). C'est de
// l'OpenID 2.0 : on redirige le joueur vers Steam, il revient avec des
// paramètres signés qu'on doit revalider auprès de Steam avant de leur faire
// confiance (un attaquant pourrait sinon forger le callback lui-même).
// Documentation : https://partner.steamgames.com/doc/features/auth#openid

const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const OPENID_IDENTIFIER = "http://specs.openid.net/auth/2.0/identifier_select";

// check_authentication (mode "dumb", sans association stockée côté serveur)
// revalide la signature Steam mais ne protège PAS contre le rejeu d'une
// assertion déjà utilisée : c'est au relying party de suivre les
// openid.response_nonce déjà consommés (spec OpenID 2.0, section 11.3). Sans
// ça, une URL de callback complète et valide capturée une fois (logs, Referer
// d'une ressource tierce chargée depuis la page de callback...) pourrait être
// rejouée indéfiniment pour se reconnecter en tant que la victime.
//
// Store en mémoire (process unique, voir middleware/rateLimit.ts pour la même
// justification) : le nonce Steam commence par un timestamp ISO8601 UTC dont
// on borne la fraîcheur, donc la fenêtre à couvrir par le store reste courte.
const NONCE_MAX_AGE_MS = 5 * 60 * 1000;
const _seenNonces = new Map<string, number>(); // nonce -> expiration

const NONCE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
	const now = Date.now();
	for (const [nonce, expiresAt] of _seenNonces) {
		if (expiresAt <= now) _seenNonces.delete(nonce);
	}
}, NONCE_SWEEP_INTERVAL_MS).unref();

// Rejette un nonce trop vieux (dérive d'horloge tolérée dans les deux sens)
// ou déjà consommé — et le marque consommé sinon (usage unique).
const isNonceFreshAndUnused = (nonce: string | undefined): boolean => {
	if (!nonce) return false;
	const match = nonce.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);
	if (!match) return false;
	const timestamp = Date.parse(match[1]);
	if (Number.isNaN(timestamp) || Math.abs(Date.now() - timestamp) > NONCE_MAX_AGE_MS) return false;
	if (_seenNonces.has(nonce)) return false;
	_seenNonces.set(nonce, Date.now() + NONCE_MAX_AGE_MS);
	return true;
};

const buildAuthUrl = (returnTo: string, realm: string): string => {
	const url = new URL(STEAM_OPENID_ENDPOINT);
	url.searchParams.set("openid.ns", OPENID_NS);
	url.searchParams.set("openid.mode", "checkid_setup");
	url.searchParams.set("openid.return_to", returnTo);
	url.searchParams.set("openid.realm", realm);
	url.searchParams.set("openid.identity", OPENID_IDENTIFIER);
	url.searchParams.set("openid.claimed_id", OPENID_IDENTIFIER);
	return url.toString();
};

// Revalide les paramètres openid.* reçus sur le callback en les repostant à
// Steam avec openid.mode=check_authentication. Renvoie le steamid si valide.
const verifyAssertion = async (
	query: Record<string, string>,
): Promise<string | null> => {
	if (query["openid.ns"] !== OPENID_NS) return null;

	const body = new URLSearchParams(query);
	body.set("openid.mode", "check_authentication");

	const res = await fetch(STEAM_OPENID_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	const text = await res.text();

	if (!/is_valid\s*:\s*true/.test(text)) return null;
	if (!isNonceFreshAndUnused(query["openid.response_nonce"])) return null;

	const claimedId = query["openid.claimed_id"];
	const match = claimedId?.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/);
	return match ? match[1] : null;
};

export { buildAuthUrl, verifyAssertion };
