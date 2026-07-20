import fs from "node:fs";
import path from "node:path";
import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import router from "./router";
import pool from "./model/db";

const app = express();

app.use(
	cors({
		origin: process.env.FRONTEND_URL,
		credentials: true,
	}),
);

app.use(express.json());
app.use(cookieParser());

app.get("/", (req: Request, res: Response) => {
	res.status(200).json({ message: "API WildWalker - up & running" });
});

// Diagnostic temporaire : vérifie la connexion à la base Aiven
app.get("/health", async (req: Request, res: Response) => {
	try {
		await pool.query("SELECT 1");
		res.status(200).json({ db: "ok" });
	} catch (error) {
		res.status(500).json({ db: "error", message: (error as Error).message });
	}
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
