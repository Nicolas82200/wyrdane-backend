import "dotenv/config";
import app from "./app";
import { runDataPatches } from "./database/dataPatches";
import { startShopReconciler } from "./helper/shopReconciler";

const PORT = process.env.PORT || 3000;

// Un patch de données manquant ne doit pas empêcher le serveur de démarrer :
// on loggue l'échec et on sert quand même.
runDataPatches().catch((error) => {
	console.error("Échec des patchs de données au démarrage :", error);
});

// Rattrapage des achats de la boutique (commandes payées dont on n'a pas vu la
// fin, remboursements Steam) : démarré ici et non à l'import, pour qu'importer
// le module dans un test ne lance ni minuteur ni requête. Voir
// helper/shopReconciler.ts.
startShopReconciler();

app.listen(PORT, () => {
	console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
