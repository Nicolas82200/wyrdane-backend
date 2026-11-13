// Rattrapage des achats de la boutique, en tâche de fond. Deux problèmes que
// le flux HTTP normal ne peut pas résoudre, parce que dans les deux cas
// personne n'appelle le serveur :
//
//   1. Le joueur autorise le paiement dans l'overlay Steam puis ferme le jeu
//      avant que le client n'appelle /api/shop/finalize-txn. Il a payé, sa
//      commande reste 'pending', et il n'a rien reçu. C'est LE cas qui génère
//      des tickets de support, et il n'est rattrapable qu'en allant demander à
//      Steam l'état réel de la commande (QueryTxn).
//   2. Valve rembourse, parfois sans rien demander à personne, et ne notifie
//      rien. Sans surveillance, un cosmétique remboursé reste acquis en jeu.
//
// Le principe est le même dans les deux cas : Steam est la seule source de
// vérité sur l'état d'une transaction, et on va l'interroger périodiquement.
//
// ⚠ Règle absolue : une panne de l'API Steam (queryTxn renvoie `null`) ne
// conclut RIEN. On laisse la commande telle quelle et on repassera. Traiter un
// silence comme un échec de paiement annulerait des achats valides.
//
// ponytail: une seule instance de backend (voir « Stack sur le VPS »), donc
// pas de verrou distribué — deux instances traiteraient les mêmes lignes en
// double. Les écritures restent idempotentes (lockPendingPurchase sérialise,
// completePurchase est un INSERT ... ON DUPLICATE KEY), mais le jour où il y a
// deux instances il faudra n'en élire qu'une.

import {
	queryTxn,
	finalizeTxn,
	TXN_STATUS,
	TXN_REVOKED_STATUSES,
	TXN_FAILED_STATUSES,
} from "./steamMicrotxnHelper";
import {
	findUnfinishedPurchases,
	findCompletedToRecheck,
	lockPendingPurchase,
	revertToPending,
	completePurchase,
	touchChecked,
	markFailed,
	revokePurchase,
	type PurchaseLedgerRow,
} from "../model/shopModel";

// Délai de grâce avant de s'intéresser à une commande non aboutie : en
// dessous, le flux normal est probablement encore en cours (le joueur est en
// train de saisir son moyen de paiement) et la reprendre ici ne ferait que
// courir contre lui.
const UNFINISHED_GRACE_MINUTES = 15;
// Au-delà, une commande que le joueur n'a jamais validée (statut Steam encore
// « Init ») est abandonnée : il a fermé l'overlay sans rien payer, la laisser
// ouverte la ferait réinterroger indéfiniment.
const ABANDON_AFTER_HOURS = 24;

// Fenêtre de surveillance des remboursements. Au-delà, on arrête de
// re-questionner : un remboursement Steam arrive dans les semaines qui suivent
// l'achat, pas deux ans après.
const REFUND_WATCH_DAYS = 180;
const REFUND_RECHECK_HOURS = 24;

// Volume par tour, pour ne pas prendre l'API Steam d'assaut après une coupure
// (ni bloquer la boucle d'événements sur des centaines d'appels enchaînés).
const UNFINISHED_BATCH = 25;
const REFUND_BATCH = 25;

const RUN_INTERVAL_MS = 5 * 60 * 1000;

interface ReconcileSummary {
	credited: number;
	failed: number;
	revoked: number;
	skipped: number;
}

const ageInHours = (createdAt: string): number =>
	(Date.now() - new Date(createdAt).getTime()) / 3_600_000;

// ─── Passe 1 : les commandes dont on n'a pas vu la fin ───────────────────────

const settleUnfinished = async (
	purchase: PurchaseLedgerRow,
	summary: ReconcileSummary,
): Promise<void> => {
	const status = await queryTxn(purchase.order_id);
	if (status === null) {
		// Steam muet : on ne conclut rien (voir l'en-tête).
		summary.skipped += 1;
		return;
	}

	if (status === TXN_STATUS.APPROVED || status === TXN_STATUS.SUCCEEDED) {
		await creditAuthorized(purchase, status, summary);
		return;
	}

	if (TXN_FAILED_STATUSES.has(status) || TXN_REVOKED_STATUSES.has(status)) {
		// Rien n'a été prélevé, ou l'argent a déjà été rendu : la commande est
		// close. Aucun cosmétique à retirer, elle n'a jamais été créditée.
		await markFailed(purchase.order_id);
		summary.failed += 1;
		return;
	}

	// Reste le cas « Init » : transaction ouverte, jamais autorisée. On attend,
	// puis on abandonne — le joueur a fermé l'overlay sans payer.
	if (ageInHours(purchase.created_at) >= ABANDON_AFTER_HOURS) {
		await markFailed(purchase.order_id);
		summary.failed += 1;
		return;
	}
	summary.skipped += 1;
};

// Le joueur a bien payé. `Approved` veut dire qu'il a autorisé mais que la
// transaction n'est pas finalisée côté Steam : c'est à nous d'appeler
// FinalizeTxn. `Succeeded` veut dire qu'elle l'est déjà (notre appel est
// probablement parti avant que le serveur ne redémarre) et il ne reste qu'à
// créditer.
const creditAuthorized = async (
	purchase: PurchaseLedgerRow,
	status: string,
	summary: ReconcileSummary,
): Promise<void> => {
	// Même verrou que la route HTTP de finalisation : si le client appelle
	// /finalize-txn au même moment, un seul des deux passe.
	const locked = await lockPendingPurchase(purchase.order_id, purchase.user_id);
	if (!locked) {
		summary.skipped += 1;
		return;
	}

	if (status === TXN_STATUS.APPROVED) {
		let ok = false;
		try {
			ok = await finalizeTxn(purchase.order_id);
		} finally {
			if (!ok) await revertToPending(purchase.order_id);
		}
		if (!ok) {
			// Échec transitoire possible : on rend la commande au prochain tour
			// plutôt que de la clore sur un seul refus.
			summary.skipped += 1;
			return;
		}
	}

	await completePurchase(purchase.order_id, purchase.user_id, purchase.item_id);
	summary.credited += 1;
	console.log(
		`[shop] commande ${purchase.order_id} rattrapée (statut Steam « ${status} ») ` +
			`— cosmétique ${purchase.item_id} crédité au joueur ${purchase.user_id}`,
	);
};

// ─── Passe 2 : les remboursements ────────────────────────────────────────────

const checkRefund = async (
	purchase: PurchaseLedgerRow,
	summary: ReconcileSummary,
): Promise<void> => {
	const status = await queryTxn(purchase.order_id);
	if (status === null) {
		summary.skipped += 1;
		return;
	}
	if (!TXN_REVOKED_STATUSES.has(status)) {
		// Toujours valide : on note qu'on l'a vue, pour ne pas la réinterroger
		// avant REFUND_RECHECK_HOURS.
		await touchChecked(purchase.order_id);
		return;
	}
	await revokePurchase(purchase.order_id, purchase.user_id, purchase.item_id);
	summary.revoked += 1;
	console.log(
		`[shop] commande ${purchase.order_id} remboursée (statut Steam « ${status} ») ` +
			`— cosmétique ${purchase.item_id} retiré au joueur ${purchase.user_id}`,
	);
};

// ─── Tour complet ────────────────────────────────────────────────────────────

// Exporté pour les tests et pour un déclenchement manuel. Les erreurs par
// commande sont avalées et journalisées : une ligne cassée (ou un hoquet
// réseau sur un seul appel) ne doit pas interrompre le reste du tour.
const reconcileOnce = async (): Promise<ReconcileSummary> => {
	const summary: ReconcileSummary = { credited: 0, failed: 0, revoked: 0, skipped: 0 };

	const unfinished = await findUnfinishedPurchases(UNFINISHED_GRACE_MINUTES, UNFINISHED_BATCH);
	for (const purchase of unfinished) {
		try {
			await settleUnfinished(purchase, summary);
		} catch (error) {
			console.error(`[shop] échec du rattrapage de la commande ${purchase.order_id} :`, error);
		}
	}

	const completed = await findCompletedToRecheck(
		REFUND_WATCH_DAYS,
		REFUND_RECHECK_HOURS,
		REFUND_BATCH,
	);
	for (const purchase of completed) {
		try {
			await checkRefund(purchase, summary);
		} catch (error) {
			console.error(
				`[shop] échec de la vérification de remboursement de la commande ${purchase.order_id} :`,
				error,
			);
		}
	}

	return summary;
};

// Démarré depuis index.ts et non à l'import : sans ça, le simple fait
// d'importer ce module dans un test lancerait un minuteur et des requêtes.
// `.unref()` pour ne pas retenir le processus à l'arrêt.
const startShopReconciler = (): void => {
	const run = (): void => {
		reconcileOnce()
			.then((summary) => {
				const touched = summary.credited + summary.failed + summary.revoked;
				// Silence quand il n'y a rien eu à faire : ce tour passe toutes
				// les 5 minutes, un log systématique noierait les vrais.
				if (touched > 0) {
					console.log(
						`[shop] réconciliation : ${summary.credited} rattrapée(s), ` +
							`${summary.failed} abandonnée(s), ${summary.revoked} remboursée(s)`,
					);
				}
			})
			.catch((error) => {
				console.error("[shop] tour de réconciliation échoué :", error);
			});
	};
	setInterval(run, RUN_INTERVAL_MS).unref();
	// Un premier tour peu après le démarrage : c'est précisément au redémarrage
	// qu'il reste des commandes interrompues en vol à reprendre.
	setTimeout(run, 30_000).unref();
};

export {
	reconcileOnce,
	startShopReconciler,
	UNFINISHED_GRACE_MINUTES,
	ABANDON_AFTER_HOURS,
	REFUND_WATCH_DAYS,
	REFUND_RECHECK_HOURS,
};
