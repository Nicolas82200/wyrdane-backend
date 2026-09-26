import fs from "node:fs";
import path from "node:path";
import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import router from "./router";

const app = express();

// L'API tourne derrière Nginx (voir CLAUDE.md « Stack sur le VPS ») : sans ce
// réglage, `req.ip` vaut l'adresse du proxy (127.0.0.1) pour TOUTES les
// requêtes, et le limiteur de débit par IP (middleware/rateLimit.ts, clé de
// repli sur les routes publiques) met donc tout le monde dans le même seau —
// un seul client pouvait épuiser le quota de `/api/auth/steam` et empêcher
// n'importe qui d'autre de se connecter pendant toute la fenêtre. `1` (et non
// `true`) : on ne fait confiance qu'au dernier proxy, le nôtre, pour que la
// valeur de `X-Forwarded-For` ne soit pas usurpable par un client qui
// enverrait sa propre chaîne d'en-têtes.
app.set("trust proxy", 1);

app.use(
	cors({
		origin: process.env.FRONTEND_URL,
		credentials: true,
	}),
);

// Parseur JSON dédié aux rapports de plantage, monté AVANT le parseur global
// et sur ce seul chemin : un rapport transporte le log de session complet,
// plusieurs centaines de Ko. Avec la seule limite globale ci-dessous, Express
// rejetait ces rapports en 413 avant même que le contrôleur ne les voie — le
// crash reporting était de fait inopérant dès qu'un log dépassait 100 ko.
// L'ordre compte : body-parser ne retouche pas une requête dont le corps a déjà
// été parsé, donc ce parseur gagne sur /api/crash-report et le global
// s'applique partout ailleurs.
//
// 10 Mo, et non 5 : la borne métier est de 5 millions de CARACTÈRES (côté
// client CrashReporter.LOG_MAX_CHARS, revérifiée ici par
// crashReportController.MAX_LOG_INPUT_LENGTH), ce qui pèse davantage en octets
// — les accents comptent double en UTF-8 et l'échappement JSON des retours
// ligne ajoute encore quelques pourcents. Un log français peut donc approcher
// 6 Mo sur le fil : une limite de transport trop serrée reproduirait le bug
// qu'on corrige ici, en plus silencieux. Le volume reste borné par cette borne
// métier et par le rate-limit de la route (10/h), pas par ce chiffre.
app.use("/api/crash-report", express.json({ limit: "10mb" }));

// Limite explicite plutôt que le défaut implicite d'Express (100 ko, même
// valeur) : rend la borne visible et ajustable ici. Elle protège toutes les
// autres routes d'un corps de requête démesuré.
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.get("/", (req: Request, res: Response) => {
	res.status(200).json({ message: "API Wyrdane - up & running" });
});

app.use("/api", router);

// Fichiers statiques AVANT le 404
const publicFolderPath = path.join(__dirname, "../public");
if (fs.existsSync(publicFolderPath)) {
	app.use(express.static(publicFolderPath));
}

// 404 : toujours en dernier
app.use((req: Request, res: Response) => {
	res.status(404).json({ message: "Not Found" });
});
console.log(
	"publicFolderPath:",
	publicFolderPath,
	fs.existsSync(publicFolderPath),
);
export default app;
