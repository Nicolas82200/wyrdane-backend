// Régénère cards_data.sql à partir des ressources .tres du jeu (E:\card-game),
// source de vérité pour le texte/les stats des cartes — la seed du backend se
// désynchronise silencieusement dès qu'une carte change côté jeu.
//
// Usage : node backend/scripts/generate-cards-data.mjs
// Écrase directement backend/src/database/cards_data.sql. Relire le diff git
// avant de commiter, puis rejouer `npm run db:migrate` (dev/local uniquement
// — script destructeur, DROP + recrée tout) pour appliquer.
//
// Suppose que le dépôt du jeu est cloné en E:\card-game (même hypothèse que
// wyrdane-website, voir son CLAUDE.md) — ajuster CARDS_DIR si ce n'est pas
// le cas sur la machine où ce script tourne.
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARDS_DIR = "E:/card-game/resources/cards";
const OUT_PATH = join(__dirname, "..", "src", "database", "cards_data.sql");

function walk(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (entry.endsWith(".tres")) out.push(full);
  }
  return out;
}

function readQuotedString(text, startIdx) {
  let i = startIdx;
  let out = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      out += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '"') {
      return { value: out, endIdx: i + 1 };
    }
    out += c;
    i++;
  }
  throw new Error("Unterminated string starting at " + startIdx);
}

function extractField(resourceBlock, key) {
  const re = new RegExp(`(^|\n)${key} = `, "g");
  const m = re.exec(resourceBlock);
  if (!m) return undefined;
  const valStart = m.index + m[0].length;
  const c = resourceBlock[valStart];
  if (c === '"') {
    return readQuotedString(resourceBlock, valStart + 1).value;
  }
  const rest = resourceBlock.slice(valStart);
  const numMatch = rest.match(/^-?\d+/);
  if (numMatch) return parseInt(numMatch[0], 10);
  return undefined;
}

function extractTexturePath(fullText, resourceBlock) {
  const m = resourceBlock.match(/(^|\n)texture = ExtResource\("([^"]+)"\)/);
  if (!m) return null;
  const id = m[2];
  const extRe = new RegExp(
    `\[ext_resource type="Texture2D"[^\]]*path="([^"]+)"[^\]]*id="${id}"\]`,
  );
  const extMatch = fullText.match(extRe);
  if (!extMatch) return null;
  return extMatch[1];
}

const RACE_BY_INT = {
  1: "Humain",
  4: "Mort-Vivant",
  5: "Demon",
  6: "Abomination",
};
const TYPE_MAP = {
  Minion: "Serviteur",
  Instant: "Incantation",
  Ritual: "Rituel",
  Enchantment: "Enchantement",
  Resource: "Ressource",
};
const RARITY_MAP = {
  Common: "Commune",
  Rare: "Rare",
  Epic: "Épique",
  Legendary: "Légendaire",
};
const LANE_MAP = { Front: "Avant", Back: "Arrière", Hybrid: "Hybride" };

function sqlStr(v) {
  if (v === null || v === undefined) return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function sqlNum(v) {
  if (v === null || v === undefined) return "NULL";
  return String(v);
}

const files = walk(CARDS_DIR);
const rows = [];
let tokenCount = 0;
let arenaCount = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const isToken = /is_token\s*=\s*true/.test(text);
  if (isToken) {
    tokenCount++;
    continue;
  }
  // CardData.arena_only (scripts/card/CardData.gd) : jamais proposée au
  // deckbuilder 1v1 ni au pool de packs côté jeu (CardLibrary.arena_only_cards,
  // séparé de all_cards) - ce script les incluait par erreur, laissant des
  // cartes Arena apparaître dans le catalogue du site comme des cartes
  // normales.
  const isArenaOnly = /arena_only\s*=\s*true/.test(text);
  if (isArenaOnly) {
    arenaCount++;
    continue;
  }
  const resIdx = text.indexOf("[resource]");
  if (resIdx === -1) {
    console.error("No [resource] block in", file);
    continue;
  }
  const resourceBlock = text.slice(resIdx);

  const name = extractField(resourceBlock, "card_name");
  const description = extractField(resourceBlock, "description") ?? "";
  const flavor = extractField(resourceBlock, "flavour_text") ?? "";
  const cost = extractField(resourceBlock, "cost") ?? 1;
  const raceInt = extractField(resourceBlock, "race") ?? 4;
  const cardType = extractField(resourceBlock, "card_type") ?? "Minion";
  const attack = extractField(resourceBlock, "attack") ?? 0;
  const health = extractField(resourceBlock, "health") ?? 0;
  const rarity = extractField(resourceBlock, "rarity") ?? "Common";
  const boardPosition = extractField(resourceBlock, "board_position") ?? "Front";
  const ritualDuration = extractField(resourceBlock, "ritual_duration") ?? 0;
  const texPath = extractTexturePath(text, resourceBlock);

  if (!name) {
    console.error("No card_name in", file);
    continue;
  }

  const race = RACE_BY_INT[raceInt];
  if (!race) {
    console.error("Unknown race int", raceInt, "in", file);
    continue;
  }
  const dbType = TYPE_MAP[cardType];
  if (!dbType) {
    console.error("Unknown card_type", cardType, "in", file);
    continue;
  }
  const dbRarity = RARITY_MAP[rarity] ?? rarity;
  const isMinion = cardType === "Minion";
  const lane = isMinion ? LANE_MAP[boardPosition] ?? "Avant" : null;
  const dbAttack = isMinion ? attack : null;
  const dbHealth = isMinion ? health : null;
  const charges = cardType === "Ritual" ? ritualDuration : null;
  const imagePath = texPath ? "/" + texPath.replace(/^res:\/\//, "") : null;

  rows.push({
    name,
    race,
    dbType,
    lane,
    cost,
    dbAttack,
    dbHealth,
    dbRarity,
    charges,
    description,
    flavor,
    imagePath,
    file,
  });
}

console.log("Parsed cards:", rows.length, "tokens skipped:", tokenCount, "arena-only skipped:", arenaCount);

const seen = new Map();
for (const r of rows) {
  if (seen.has(r.name)) {
    console.error("DUPLICATE NAME:", r.name, "in", r.file, "and", seen.get(r.name));
  }
  seen.set(r.name, r.file);
}

const lines = rows.map((r) => {
  return (
    `INSERT INTO cards (name, race, card_type, lane, cost, attack, hp, rarity, charges, effect, flavor, image_path) VALUES (` +
    [
      sqlStr(r.name),
      sqlStr(r.race),
      sqlStr(r.dbType),
      sqlStr(r.lane),
      sqlNum(r.cost),
      sqlNum(r.dbAttack),
      sqlNum(r.dbHealth),
      sqlStr(r.dbRarity),
      sqlNum(r.charges),
      sqlStr(r.description),
      sqlStr(r.flavor),
      sqlStr(r.imagePath),
    ].join(", ") +
    ");"
  );
});

writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8");
console.log("Wrote", lines.length, "rows to", OUT_PATH);
