// Vérifie un ticket de session Steam (obtenu côté client via
// Steam.getAuthSessionTicket() dans GodotSteam) auprès de l'API Web Steamworks.
// Documentation : https://partner.steamgames.com/doc/webapi/ISteamUserAuth

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
    "https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/",
  );
  url.searchParams.set("key", STEAM_WEB_API_KEY as string);
  url.searchParams.set("appid", STEAM_APP_ID as string);
  url.searchParams.set("ticket", ticket);

  const res = await fetch(url);
  const data = (await res.json()) as AuthenticateUserTicketResponse;

  const params = data.response?.params;
  if (!params || params.result !== "OK") return null;
  if (params.vacbanned || params.publisherbanned) return null;

  return params.steamid;
};

export { authenticateSteamTicket };
