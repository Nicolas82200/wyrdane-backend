import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/db", () => ({
	default: { query: vi.fn() },
}));
vi.mock("../model/systemStatusModel", () => ({
	readSystemStatus: vi.fn(),
}));

import pool from "../model/db";
import { readSystemStatus } from "../model/systemStatusModel";
import { getHealth } from "./healthController";

const mockedPool = pool as unknown as { query: ReturnType<typeof vi.fn> };
const mockedRead = readSystemStatus as ReturnType<typeof vi.fn>;

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const mockReq = (headerValue?: string): Request =>
	({ get: (name: string) => (name === "x-health-key" ? headerValue : undefined) }) as unknown as Request;

const bodyOf = (res: Response) => (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe("getHealth", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedPool.query.mockResolvedValue([[{ 1: 1 }]]);
		process.env.HEALTH_KEY = "secret";
	});
	afterEach(() => {
		delete process.env.HEALTH_KEY;
	});

	it("answers 200 with the public level only, when no key is presented", async () => {
		const res = mockRes();
		await getHealth(mockReq(), res);

		expect(res.status).toHaveBeenCalledWith(200);
		const body = bodyOf(res);
		expect(body).toEqual({ ok: true, db: "up" });
		// Le detail d'exploitation ne doit pas fuiter : « les sauvegardes sont
		// mortes depuis 5 jours » renseigne precisement qui ne devrait pas.
		expect(body.backup).toBeUndefined();
		expect(mockedRead).not.toHaveBeenCalled();
	});

	it("answers 503 when the database does not respond, so a monitor shouts", async () => {
		mockedPool.query.mockRejectedValue(new Error("ECONNREFUSED"));
		const res = mockRes();
		await getHealth(mockReq(), res);

		expect(res.status).toHaveBeenCalledWith(503);
		expect(bodyOf(res)).toMatchObject({ ok: false, db: "down" });
	});

	it("adds the backup detail for the right key, and does not call it stale while fresh", async () => {
		mockedRead.mockResolvedValue(hoursAgo(5));
		const res = mockRes();
		await getHealth(mockReq("secret"), res);

		expect(bodyOf(res).backup).toMatchObject({ stale: false });
		expect(bodyOf(res).backup.ageHours).toBeCloseTo(5, 0);
	});

	it("flags a backup older than the 36 h threshold as stale", async () => {
		mockedRead.mockResolvedValue(hoursAgo(40));
		const res = mockRes();
		await getHealth(mockReq("secret"), res);

		expect(bodyOf(res).backup.stale).toBe(true);
	});

	// 24 h + le temps d'execution est l'ecart NORMAL entre deux passages du cron
	// de 3h05 : un seuil a 24 h sonnerait tous les matins et on apprendrait a
	// ignorer l'alerte. C'est la raison d'etre des 36 h, pas un chiffre arbitraire.
	it("does not flag the normal gap between two nightly runs", async () => {
		mockedRead.mockResolvedValue(hoursAgo(25));
		const res = mockRes();
		await getHealth(mockReq("secret"), res);

		expect(bodyOf(res).backup.stale).toBe(false);
	});

	// Le cas qu'on veut surtout voir remonter : aucune sauvegarde n'a jamais ete
	// enregistree. Compter l'absence de donnee comme « frais » rendrait la route
	// rassurante precisement quand il n'y a rien a sauvegarder dessus.
	it("treats a missing timestamp as stale rather than as fine", async () => {
		mockedRead.mockResolvedValue(null);
		const res = mockRes();
		await getHealth(mockReq("secret"), res);

		expect(bodyOf(res).backup).toMatchObject({ lastAt: null, ageHours: null, stale: true });
	});

	it("ignores a wrong key instead of leaking the detail", async () => {
		mockedRead.mockResolvedValue(hoursAgo(1));
		const res = mockRes();
		await getHealth(mockReq("wrong"), res);

		expect(bodyOf(res).backup).toBeUndefined();
	});

	// Sans HEALTH_KEY cote serveur, un client qui n'envoie aucun en-tete ne doit
	// pas se retrouver autorise par comparaison de deux undefined.
	it("stays closed when no key is configured server-side", async () => {
		delete process.env.HEALTH_KEY;
		const res = mockRes();
		await getHealth(mockReq(), res);

		expect(bodyOf(res).backup).toBeUndefined();
	});
});
