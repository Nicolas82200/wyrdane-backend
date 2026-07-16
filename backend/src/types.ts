import type { JwtPayload } from "jsonwebtoken";

export interface User {
	id: number;
	username: string;
	created_at: string;
}
export interface Decks {
	id: number;
	user_id: number;
	name: string;
	created_at: string;
}

export interface DeckCard {
	deck_id: number;
	card_id: number;
	quantity: number;
	name: string;
	race: string;
	card_type: string;
	lane: string | null;
	cost: number;
	attack: number | null;
	hp: number | null;
	rarity: string;
	charges: number | null;
	effect: string | null;
	flavor: string | null;
	image_path: string;
}

export interface DeckWithCards extends Decks {
	cards: DeckCard[];
}
export interface Cards {
	id: number;
	name: string;
	race: string;
	card_type: number;
	lane: string | null;
	cost: number;
	attack: number | null;
	hp: number | null;
	rarity: string;
	charges: number | null;
	effect: string | null;
	flavor: string | null;
	image_path: string;
}

// Déclaration de module : on ajoute la propriété `user` au type Request
// d'Express, pour pouvoir écrire req.user dans le middleware d'auth.
declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			user?: string | JwtPayload;
		}
	}
}
