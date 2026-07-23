import "dotenv/config";
import app from "./app";
import { runDataPatches } from "./database/dataPatches";

const PORT = process.env.PORT || 3000;

// Un patch de données manquant ne doit pas empêcher le serveur de démarrer :
// on loggue l'échec et on sert quand même.
runDataPatches().catch((error) => {
	console.error("Échec des patchs de données au démarrage :", error);
});

app.listen(PORT, () => {
	console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
