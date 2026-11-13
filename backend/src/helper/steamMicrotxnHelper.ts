// Wrap l'API Web Steamworks Microtransactions : InitTxn démarre l'achat côté
// serveur, FinalizeTxn le confirme une fois que Steam a débité le joueur.
// Documentation : https://partner.steamgames.com/doc/webapi/ISteamMicroTxn
//
// Bac à sable (tester un achat sans dépenser d'argent réel) : STEAM_MICROTXN_SANDBOX
// à "1"/"true" bascule les DEUX appels sur l'interface ISteamMicroTxnSandbox.
// L'overlay d'achat s'affiche et se comporte exactement comme en vrai, mais
// aucun compte n'est débité et rien n'apparaît dans l'historique d'achats Steam
// du joueur — c'est l'équivalent Steam des cartes de test Stripe. Côté jeu il
// n'y a rien à changer : le client ne connaît que /api/shop (voir
// BackendClient.shop_init_txn), il ne sait pas quelle interface est utilisée.
//
// ⚠ Le bac à sable n'est utilisable que par les comptes ayant un accès
// développeur à l'AppID, et il ne doit JAMAIS rester actif en production :
// chaque achat y serait gratuit. D'où l'avertissement au démarrage ci-dessous.

const SANDBOX = ["1", "true", "yes"].includes(
	(process.env.STEAM_MICROTXN_SANDBOX ?? "").toLowerCase(),
);

const MICROTXN_INTERFACE = SANDBOX ? "ISteamMicroTxnSandbox" : "ISteamMicroTxn";

if (SANDBOX && process.env.NODE_ENV === "production") {
	console.warn(
		"⚠️  STEAM_MICROTXN_SANDBOX actif en production : tous les achats de la " +
			"boutique sont gratuits et ne débitent personne. À retirer.",
	);
}

interface InitTxnItem {
	itemId: string;
	quantity: number;
	amountCents: number;
	description: string;
	category: string;
}

interface InitTxnResponse {
	response?: {
		result: string;
		params?: { orderid: string; transid: string };
		error?: { errorcode: number; errordesc: string };
	};
}

interface FinalizeTxnResponse {
	response?: {
		result: string;
		error?: { errorcode: number; errordesc: string };
	};
}

const initTxn = async (
	orderId: number,
	steamId: string,
	item: InitTxnItem,
): Promise<string | null> => {
	const { STEAM_WEB_API_KEY, STEAM_APP_ID } = process.env;
	const url = new URL(
		`https://partner.steam-api.com/${MICROTXN_INTERFACE}/InitTxn/v3/`,
	);

	const body = new URLSearchParams({
		key: STEAM_WEB_API_KEY as string,
		orderid: String(orderId),
		steamid: steamId,
		appid: STEAM_APP_ID as string,
		itemcount: "1",
		language: "fr",
		currency: "EUR",
		"itemid[0]": item.itemId,
		"qty[0]": String(item.quantity),
		"amount[0]": String(item.amountCents),
		"description[0]": item.description,
		"category[0]": item.category,
	});

	const res = await fetch(url, { method: "POST", body });
	const data = (await res.json()) as InitTxnResponse;

	if (data.response?.result !== "OK") return null;
	return data.response.params?.transid ?? null;
};

const finalizeTxn = async (orderId: number): Promise<boolean> => {
	const { STEAM_WEB_API_KEY, STEAM_APP_ID } = process.env;
	const url = new URL(
		`https://partner.steam-api.com/${MICROTXN_INTERFACE}/FinalizeTxn/v2/`,
	);

	const body = new URLSearchParams({
		key: STEAM_WEB_API_KEY as string,
		orderid: String(orderId),
		appid: STEAM_APP_ID as string,
	});

	const res = await fetch(url, { method: "POST", body });
	const data = (await res.json()) as FinalizeTxnResponse;

	return data.response?.result === "OK";
};

export { initTxn, finalizeTxn };
