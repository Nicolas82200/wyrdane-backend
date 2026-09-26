// Vérifie un ticket de session Steam (obtenu côté client via
// Steam.getAuthSessionTicket() dans GodotSteam) auprès de l'API Web Steamworks.
// Documentation : https://partner.steamgames.com/doc/webapi/ISteamUserAuth
//
// Utilise l'AppID de test 480 (Spacewar) : Valve permet à ce domaine public
// de vérifier des tickets pour cet AppID avec une simple clé Web API
// personnelle (steamcommunity.com/dev/apikey), sans accès Steamworks
// Partner. Le domaine partner.steam-api.com, lui, exige une vraie clé
// Publisher/Partner Group — inutilisable avec une clé personnelle (403).
//
// /!\ LIMITE DE SÉCURITÉ CONNUE, à lever au passage sur l'AppID réel (5052390)
// avec une clé Publisher. Tant qu'on vérifie les tickets pour l'AppID 480 :
//   - la vérification ne prouve pas la possession de Wyrdane (480 est public,
//     n'importe quel compte Steam peut donc créer un compte joueur) ;
//   - un ticket de session émis pour l'AppID 480 par un AUTRE programme est
//     accepté ici. Un tiers qui collecte les tickets 480 de ses propres
//     utilisateurs (beaucoup de jeux en développement utilisent cet AppID)
//     pourrait les rejouer contre cette API et prendre la main sur les comptes
//     Wyrdane correspondants ;
//   - les bans VAC/éditeur rendus par Steam ne concernent pas notre app, donc
//     un bannissement Wyrdane crédible est impossible.
// Le passage à `STEAM_APP_ID=5052390` + clé Publisher ferme les trois d'un coup,
// sans autre changement de code : d'où l'avertissement de démarrage ci-dessous,
// pour que cet état provisoire ne s'oublie pas en production.

interface AuthenticateUserTicketResponse {
  response?: {
    params?: {
      result: string;
      steamid: string;
      ownersteamid: string;
      vacbanned: boolean;
      publisherbanned: boolean;
    };
    error?: {
      errorcode: number;
      errordesc: string;
    };
  };
}

// Préfixe reconnu uniquement en dev (voir DEV_SKIP_STEAM_VERIFY) : un ticket
// réel de GodotSteam est un buffer binaire hex-encodé, jamais sous cette forme.
const DEV_TICKET_PREFIX = "DEV:";

// AppID public de test (Spacewar). Voir l'en-tête de ce fichier : s'en servir
// en production est une faiblesse d'authentification assumée, mais elle doit
// rester visible plutôt que de se fondre dans la configuration.
const STEAM_TEST_APP_ID = "480";
if (process.env.NODE_ENV === "production" && process.env.STEAM_APP_ID === STEAM_TEST_APP_ID) {
  console.warn(
    "⚠️  STEAM_APP_ID=480 (Spacewar) en production : les tickets de session ne " +
      "prouvent ni la possession du jeu ni leur provenance (voir l'en-tête de " +
      "steamHelper.ts). À remplacer par l'AppID 5052390 + clé Publisher.",
  );
}

const authenticateSteamTicket = async (ticket: string): Promise<string | null> => {
  // Bypass dev uniquement : AuthenticateUserTicket exige une clé Publisher
  // Web API (accès Steamworks Partner), qu'on n'a pas encore. Permet de tester
  // le flow ticket du client Godot sans elle. Jamais actif en production.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.DEV_SKIP_STEAM_VERIFY === "true" &&
    ticket.startsWith(DEV_TICKET_PREFIX)
  ) {
    console.warn("⚠️  DEV_SKIP_STEAM_VERIFY actif : ticket Steam non vérifié auprès de Steam (dev uniquement)");
    return ticket.slice(DEV_TICKET_PREFIX.length);
  }

  const { STEAM_WEB_API_KEY, STEAM_APP_ID } = process.env;
  const url = new URL(
    "https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/",
  );
  url.searchParams.set("key", STEAM_WEB_API_KEY as string);
  url.searchParams.set("appid", STEAM_APP_ID as string);
  url.searchParams.set("ticket", ticket);

  const res = await fetch(url);
  const rawBody = await res.text();
  let data: AuthenticateUserTicketResponse;
  try {
    data = JSON.parse(rawBody) as AuthenticateUserTicketResponse;
  } catch {
    // Steam répond parfois en HTML (clé Publisher invalide/manquante, endpoint
    // injoignable) au lieu du JSON attendu : on log un message exploitable au
    // lieu de laisser planter sur un SyntaxError opaque à la fermeture du parse.
    console.error(
      `authenticateSteamTicket: réponse non-JSON de Steam (status ${res.status}) : ${rawBody.slice(0, 200)}`,
    );
    return null;
  }

  const params = data.response?.params;
  if (!params || params.result !== "OK") return null;
  if (params.vacbanned || params.publisherbanned) return null;
  // ownersteamid != steamid = le jeu est joué via le partage familial Steam.
  // Refusé : c'est le vecteur le plus simple pour multiplier les comptes depuis
  // une seule licence (farm de parrainages, collusion en classé). Wyrdane n'a
  // aucun cas d'usage légitime de partage familial aujourd'hui — si cela change,
  // c'est ici qu'il faudra rouvrir, sciemment.
  if (params.ownersteamid && params.ownersteamid !== params.steamid) {
    console.warn(
      `authenticateSteamTicket: ticket refusé (partage familial Steam, owner=${params.ownersteamid})`,
    );
    return null;
  }

  return params.steamid;
};

interface GetPlayerSummariesResponse {
  response?: {
    players?: { steamid: string; personaname: string }[];
  };
}

// Pseudo Steam affiché ("persona name"), récupéré via l'API Web publique —
// même clé personnelle que authenticateSteamTicket, pas besoin d'accès
// Steamworks Partner pour cet endpoint. Renvoie null (plutôt que de lever)
// en cas d'échec réseau/clé manquante : appelé à chaque login, ne doit
// jamais faire échouer la connexion elle-même.
const fetchSteamPersonaName = async (steamId: string): Promise<string | null> => {
  try {
    const { STEAM_WEB_API_KEY } = process.env;
    const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
    url.searchParams.set("key", STEAM_WEB_API_KEY as string);
    url.searchParams.set("steamids", steamId);

    const res = await fetch(url);
    const data = (await res.json()) as GetPlayerSummariesResponse;
    return data.response?.players?.[0]?.personaname ?? null;
  } catch (error) {
    console.error("fetchSteamPersonaName failed", error);
    return null;
  }
};

export { authenticateSteamTicket, fetchSteamPersonaName };
