import { Request, Response } from "express";

import { findAll } from "../model/cardsModel";

const getAll = async (req: Request, res: Response): Promise<void> => {
	try {
		const cards = await findAll();
		res.status(200).json(cards);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getAll };
