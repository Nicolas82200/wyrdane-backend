import { Router } from "express";

import { getOne } from "../controller/userController";
import { exportMyData, deleteMyAccount } from "../controller/accountController";
import rateLimit from "../middleware/rateLimit";

const router = Router();

// Droits RGPD (voir controller/accountController.ts). Montés avant "/:id" pour
// que "me" ne soit jamais capturé comme un identifiant numérique.
// Export : requête lourde (une douzaine de SELECT), volontairement limitée.
router.get(
	"/me/export",
	rateLimit({ windowMs: 60 * 60 * 1000, max: 5, name: "account:export" }),
	exportMyData,
);
router.delete(
	"/me",
	rateLimit({ windowMs: 60 * 60 * 1000, max: 5, name: "account:delete" }),
	deleteMyAccount,
);

// GET http://localhost:3000/api/users/1
router.get("/:id", getOne);

export default router;
