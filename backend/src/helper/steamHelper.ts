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

const authenticateSteamTicket = async (ticket: string): Promise<string | null> => {
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
