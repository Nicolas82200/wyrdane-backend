const K_FACTOR = 32;

// Calcule les nouveaux MMR après un match. `scoreA` vaut 1 si A a gagné, 0 sinon.
const calculateElo = (
	ratingA: number,
	ratingB: number,
	scoreA: 0 | 1,
): { newRatingA: number; newRatingB: number } => {
	const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
	const expectedB = 1 - expectedA;

	const newRatingA = Math.round(ratingA + K_FACTOR * (scoreA - expectedA));
	const newRatingB = Math.round(ratingB + K_FACTOR * (1 - scoreA - expectedB));

	return { newRatingA, newRatingB };
};

export { calculateElo };
