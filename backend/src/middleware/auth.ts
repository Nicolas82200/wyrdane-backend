import { Request, Response, NextFunction } from "express";

import { decodeJWT } from "../helper/jwtHelper";
import { isAccountDeleted } from "./deletedAccount";

// Middleware d'autorisation : on le place AVANT les routes à protéger.
// Le token est désormais lu depuis le cookie httpOnly (et non plus l'en-tête).
const authorization = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const cookieToken = req.cookies.auth_token as string | undefined; // "Bearer <token>"
    if (!cookieToken) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const [, token] = cookieToken.split(" ");
    req.user = decodeJWT(token); // lève une erreur si le token est invalide/expiré

    // Un JWT émis AVANT une suppression de compte reste cryptographiquement
    // valide jusqu'à 1h : la session doit être refusée ici, au seul endroit qui
    // décide déjà si une session vaut quelque chose (voir
    // middleware/deletedAccount.ts pour la fenêtre couverte et pourquoi ce n'est
    // pas une requête en base).
    const userId = (req.user as { id?: unknown } | undefined)?.id;
    if (typeof userId === "number" && isAccountDeleted(userId)) {
      res.status(401).json({ message: "Compte supprimé" });
      return;
    }

    next();
  } catch (error) {
    console.error(error);
    res.status(401).json({ message: "Unauthorized" });
  }
};

export default authorization;
