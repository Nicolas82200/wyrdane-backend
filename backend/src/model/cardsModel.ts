import type { RowDataPacket } from "mysql2";
import type { Cards } from "../types";
import db from "./db";

interface CardsRow extends Cards, RowDataPacket {}

const findAll = async (): Promise<CardsRow[]> => {
	const [rows] = await db.query<CardsRow[]>("SELECT * FROM `cards`");
	return rows;
};

export { findAll };
