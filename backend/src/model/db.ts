import mysql from "mysql2/promise";

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL } = process.env;

// Un pool : un ensemble de connexions réutilisables vers la base
// DB_SSL=true : requis pour les MySQL managés (ex. Aiven) qui exigent TLS,
// inutile contre une instance locale.
// charset explicite : le serveur MySQL du VPS a `character_set_client`
// par défaut sur latin1 (négocié côté client faute de locale dans le
// conteneur, alors que la colonne est bien en utf8mb4) — sans ce réglage,
// tout accent envoyé/lu par le pool risque le même mojibake ("Ã©") qui a
// dû être corrigé manuellement sur `cards` début 2026-08. mysql2 accepte
// l'alias "utf8mb4" (mappé sur sa collation par défaut).
const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT ? Number(DB_PORT) : undefined,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  charset: "utf8mb4",
  ssl: DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  // Explicite plutôt que le défaut mysql2 (10) : rend la limite visible et
  // ajustable ici plutôt que dépendante d'une valeur implicite de la lib.
  connectionLimit: 10,
  // OBLIGATOIRE — ne pas retirer. Sans cette option, mysql2 arrondit tout
  // BIGINT de 14 chiffres ou plus DANS LE DRIVER, avant que le moindre code
  // applicatif ne le voie : `if (len >= 14 && !supportBigNumbers) return
  // Number(s)` (node_modules/mysql2/lib/packets/packet.js). C'est ce qui
  // cassait le matchmaking : `matchmaking_tickets.steam_lobby_id` est un
  // BIGINT contenant un CSteamID 64 bits de 18 chiffres (57 bits
  // significatifs), rendu illisible par un double à 53 bits de mantisse —
  // l'hôte créait le lobby ...141593584, l'invité tentait de rejoindre
  // ...141593578, Steam refusait l'entrée en code 2
  // (k_EChatRoomEnterResponseDoesntExist) et les deux joueurs repartaient en
  // boucle de matchmaking. Le type TypeScript des lignes annonçait `string`,
  // mais un type ne contraint pas ce que renvoie un driver au runtime : les
  // tests mockent la base et passaient donc au vert sur un bug intact.
  // Avec supportBigNumbers, mysql2 ne renvoie une chaîne que lorsque la valeur
  // ne tient PAS exactement dans un Number (`Number.isSafeInteger`) — les
  // entiers sûrs restent des nombres, donc aucun autre BIGINT du schéma n'est
  // affecté : `purchase_ledger.order_id` est un auto-increment (toujours petit)
  // et le SteamID64 du joueur est déjà stocké en VARCHAR
  // (`linked_accounts.external_id`). Couvert par model/db.test.ts.
  supportBigNumbers: true,
});

export default pool;
