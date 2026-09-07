import { Request, Response } from "express";

import {
	getOrCreateCode,
	getStatus,
	redeemCode,
	ReferralInvalidCodeError,
	ReferralSelfError,
	ReferralAlreadyReferredError,
	ReferralCodeUsedError,
} from "../model/referralModel";
import { getUserId } from "../helper/requestUser";

const getMyReferralCode = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const code = await getOrCreateCode(userId);
		res.status(200).json({ code });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const getMyReferralStatus = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const status = await getStatus(userId);
		res.status(200).json(status);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

const redeemMyReferralCode = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ message: "Non authentifié" });
			return;
		}

		const { code } = req.body as { code?: string };
		if (typeof code !== "string" || code.trim().length === 0) {
			res.status(400).json({ message: "Payload invalide" });
			return;
		}

		await redeemCode(userId, code.trim().toUpperCase());
		res.status(200).json({ success: true });
	} catch (error) {
		if (
			error instanceof ReferralInvalidCodeError ||
			error instanceof ReferralSelfError ||
			error instanceof ReferralAlreadyReferredError ||
			error instanceof ReferralCodeUsedError
		) {
			res.status(400).json({ error: error.code, message: error.message });
			return;
		}
		console.error(error);
		res.status(500).json({ message: "Server error" });
	}
};

export { getMyReferralCode, getMyReferralStatus, redeemMyReferralCode };
