// Wrap l'API Web Steamworks Microtransactions : InitTxn démarre l'achat côté
// serveur, FinalizeTxn le confirme une fois que Steam a débité le joueur.
// Documentation : https://partner.steamgames.com/doc/webapi/ISteamMicroTxn

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
		"https://partner.steam-api.com/ISteamMicroTxn/InitTxn/v3/",
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
		"https://partner.steam-api.com/ISteamMicroTxn/FinalizeTxn/v2/",
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
