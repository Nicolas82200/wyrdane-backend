import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../helper/mailHelper", () => ({
	sendMail: vi.fn(),
}));
vi.mock("../model/reportsModel", () => ({
	findUsername: vi.fn(),
}));

import { sendMail } from "../helper/mailHelper";
import { findUsername } from "../model/reportsModel";
import { createReport } from "./reportsController";

const mocked = {
	sendMail: sendMail as ReturnType<typeof vi.fn>,
	findUsername: findUsername as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	res.sendStatus = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number | undefined, body: Record<string, unknown>): Request =>
	({ user: userId ? { id: userId } : undefined, body } as unknown as Request);

describe("createReport", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocked.findUsername.mockResolvedValue("Reporter");
	});

	it("rejects an unauthenticated request", async () => {
		const req = reqAs(undefined, { type: "bug", description: "ça plante" });
		const res = mockRes();

		await createReport(req, res);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(mocked.sendMail).not.toHaveBeenCalled();
	});

	it("rejects an unknown report type", async () => {
		const req = reqAs(1, { type: "not-a-type", description: "ça plante" });
		const res = mockRes();

		await createReport(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendMail).not.toHaveBeenCalled();
	});

	it("rejects an empty description", async () => {
		const req = reqAs(1, { type: "bug", description: "   " });
		const res = mockRes();

		await createReport(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendMail).not.toHaveBeenCalled();
	});

	it("rejects a cheating report without a reported user", async () => {
		const req = reqAs(1, { type: "cheating", description: "il triche" });
		const res = mockRes();

		await createReport(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendMail).not.toHaveBeenCalled();
	});

	it("sends the mail and returns 200 for a valid bug report", async () => {
		const req = reqAs(1, { type: "bug", description: "Le jeu crash au mulligan." });
		const res = mockRes();

		await createReport(req, res);

		expect(mocked.sendMail).toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringContaining("Le jeu crash au mulligan.") }),
		);
		expect(res.sendStatus).toHaveBeenCalledWith(200);
	});

	it("includes the reported player and match id for a cheating report", async () => {
		mocked.findUsername.mockResolvedValueOnce("Reporter").mockResolvedValueOnce("Cheater");
		const req = reqAs(1, {
			type: "cheating",
			description: "Coups impossibles",
			reportedUserId: 2,
			matchId: "match-123",
		});
		const res = mockRes();

		await createReport(req, res);

		const [[mailArg]] = mocked.sendMail.mock.calls;
		expect(mailArg.text).toContain("Cheater");
		expect(mailArg.text).toContain("match-123");
		expect(res.sendStatus).toHaveBeenCalledWith(200);
	});
});
