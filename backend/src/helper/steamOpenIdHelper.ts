// Flow "Sign in through Steam" pour le site web (navigateur), distinct du
// flow à ticket utilisé par le client Godot (voir steamHelper.ts). C'est de
// l'OpenID 2.0 : on redirige le joueur vers Steam, il revient avec des
// paramètres signés qu'on doit revalider auprès de Steam avant de leur faire
// confiance (un attaquant pourrait sinon forger le callback lui-même).
// Documentation : https://partner.steamgames.com/doc/features/auth#openid

const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const OPENID_IDENTIFIER = "http://specs.openid.net/auth/2.0/identifier_select";

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

	const claimedId = query["openid.claimed_id"];
	const match = claimedId?.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/);
	return match ? match[1] : null;
};

export { buildAuthUrl, verifyAssertion };
