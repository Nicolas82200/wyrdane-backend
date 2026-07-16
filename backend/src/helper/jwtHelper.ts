import jwt, { JwtPayload } from "jsonwebtoken";

export interface JwtUser {
  id: number;
  name: string;
}

// Crée un token signé contenant le payload (infos non sensibles de l'user)
const encodeJWT = (payload: JwtUser): string =>
  jwt.sign(payload, process.env.TOKEN_SECRET as string, { expiresIn: "1h" });

// Vérifie la SIGNATURE et l'EXPIRATION du token, puis retourne son contenu.
// /!\ NE JAMAIS utiliser jwt.decode() pour authentifier : decode() ne vérifie
//     rien, il lit juste le contenu -> un token forgé passerait.
const decodeJWT = (token: string): string | JwtPayload =>
  jwt.verify(token, process.env.TOKEN_SECRET as string);

export { encodeJWT, decodeJWT };
