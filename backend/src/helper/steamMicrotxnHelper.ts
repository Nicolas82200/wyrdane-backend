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
	// Montant dans les UNITÉS MINEURES de `currency` : des centimes pour EUR,
	// USD ou GBP, mais des yens entiers pour JPY, qui n'a pas de subdivision.
	// Ne jamais diviser ou multiplier par 100 en supposant deux décimales.
	amount: number;
	// Code ISO 4217 à 3 lettres. Steam exige qu'il corresponde au portefeuille
	// du joueur (voir getUserInfo) : une devise qui ne correspond pas fait
	// échouer InitTxn.
	currency: string;
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
		currency: item.currency,
		"itemid[0]": item.itemId,
		"qty[0]": String(item.quantity),
		"amount[0]": String(item.amount),
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

// ─── GetUserInfo : pays et devise du portefeuille du joueur ──────────────────
// Indispensable avant InitTxn : Steam ne convertit pas, il exige la devise
// réelle du joueur. Un joueur américain à qui on présente un montant en EUR
// voit simplement sa transaction refusée.
//
// Résultat mémorisé en mémoire pendant USER_INFO_TTL_MS : la devise d'un compte
// ne change qu'exceptionnellement, et sans ce cache chaque affichage du
// catalogue coûterait un aller-retour vers l'API Steam.
// ponytail: cache par processus, suffisant à une seule instance (voir
// « Stack sur le VPS ») ; passer sur un cache partagé le jour où il y en a deux.

interface GetUserInfoResponse {
	response?: {
		result: string;
		params?: { country: string; currency: string; status: string };
		error?: { errorcode: number; errordesc: string };
	};
}

interface SteamUserInfo {
	country: string;
	currency: string;
}

const USER_INFO_TTL_MS = 60 * 60 * 1000;
const userInfoCache = new Map<string, { at: number; info: SteamUserInfo }>();

const getUserInfo = async (steamId: string): Promise<SteamUserInfo | null> => {
	const cached = userInfoCache.get(steamId);
	if (cached && Date.now() - cached.at < USER_INFO_TTL_MS) return cached.info;

	const { STEAM_WEB_API_KEY, STEAM_APP_ID } = process.env;
	const url = new URL(
		`https://partner.steam-api.com/${MICROTXN_INTERFACE}/GetUserInfo/v2/`,
	);
	url.searchParams.set("key", STEAM_WEB_API_KEY as string);
	url.searchParams.set("steamid", steamId);
	url.searchParams.set("appid", STEAM_APP_ID as string);

	const res = await fetch(url);
	const data = (await res.json()) as GetUserInfoResponse;
	if (data.response?.result !== "OK") return null;

	const currency = data.response.params?.currency;
	const country = data.response.params?.country;
	if (!currency) return null;

	// Steam renvoie la devise en minuscules ("eur") selon les versions : on
	// normalise une fois ici, pour que tout le reste du code (clé de la table
	// de prix, comparaison) n'ait jamais à s'en soucier.
	const info: SteamUserInfo = {
		country: (country ?? "").toUpperCase(),
		currency: currency.toUpperCase(),
	};
	userInfoCache.set(steamId, { at: Date.now(), info });
	return info;
};

// ─── QueryTxn : l'état d'une commande selon Steam ────────────────────────────
// Seule source de vérité pour rattraper une commande dont on n'a pas vu la fin
// (joueur qui ferme le jeu après avoir payé) et pour détecter un remboursement,
// que Steam ne nous notifie jamais. Voir helper/shopReconciler.ts.

// Statuts documentés de l'API. Regroupés ici par CONSÉQUENCE, parce que c'est
// la seule chose qui nous intéresse : faut-il créditer, révoquer, ou abandonner ?
const TXN_STATUS = {
	// Le joueur a autorisé le paiement mais la transaction n'est pas finalisée :
	// c'est à nous d'appeler FinalizeTxn, et c'est exactement le cas du joueur
	// qui a fermé le jeu juste après avoir cliqué.
	APPROVED: "approved",
	// Déjà finalisée côté Steam : il ne reste qu'à créditer de notre côté.
	SUCCEEDED: "succeeded",
} as const;

// Issues qui annulent l'achat : argent rendu au joueur, ou jamais prélevé.
// Un cosmétique déjà crédité doit être RETIRÉ (voir revokePurchase).
const TXN_REVOKED_STATUSES = new Set([
	"refunded",
	"partialrefund",
	"chargeback",
	"revokedbydevparams",
	"revoked",
]);

// Issues définitivement perdues : rien n'a été prélevé, rien à rendre.
const TXN_FAILED_STATUSES = new Set(["failed", "cancelled", "canceled", "timedout"]);

interface QueryTxnResponse {
	response?: {
		result: string;
		params?: {
			orderid: string;
			transid: string;
			status: string;
			currency?: string;
		};
		error?: { errorcode: number; errordesc: string };
	};
}

// `null` = Steam n'a pas répondu, ou pas « OK » : à distinguer absolument d'un
// statut connu. L'appelant doit alors REESSAYER plus tard et ne surtout rien
// conclure — traiter une panne d'API comme un échec de paiement reviendrait à
// annuler des achats valides.
const queryTxn = async (orderId: number): Promise<string | null> => {
	const { STEAM_WEB_API_KEY, STEAM_APP_ID } = process.env;
	const url = new URL(
		`https://partner.steam-api.com/${MICROTXN_INTERFACE}/QueryTxn/v3/`,
	);
	url.searchParams.set("key", STEAM_WEB_API_KEY as string);
	url.searchParams.set("appid", STEAM_APP_ID as string);
	url.searchParams.set("orderid", String(orderId));

	const res = await fetch(url);
	const data = (await res.json()) as QueryTxnResponse;
	if (data.response?.result !== "OK") return null;

	const status = data.response.params?.status;
	return status ? status.toLowerCase() : null;
};

export {
	initTxn,
	finalizeTxn,
	getUserInfo,
	queryTxn,
	TXN_STATUS,
	TXN_REVOKED_STATUSES,
	TXN_FAILED_STATUSES,
};
export type { SteamUserInfo };
