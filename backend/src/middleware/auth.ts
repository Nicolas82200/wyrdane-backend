import { Request, Response, NextFunction } from "express";

import { decodeJWT } from "../helper/jwtHelper";

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

    next();
  } catch (error) {
    console.error(error);
    res.status(401).json({ message: "Unauthorized" });
  }
};

export default authorization;
