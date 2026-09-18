import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../helper/discordHelper", () => ({
	sendDiscordWebhook: vi.fn(),
}));
vi.mock("../model/reportsModel", () => ({
	findUsername: vi.fn(),
}));

import { sendDiscordWebhook } from "../helper/discordHelper";
import { findUsername } from "../model/reportsModel";
import { createReport } from "./reportsController";

const mocked = {
	sendDiscordWebhook: sendDiscordWebhook as ReturnType<typeof vi.fn>,
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
		expect(mocked.sendDiscordWebhook).not.toHaveBeenCalled();
	});

	it("rejects an unknown report type", async () => {
		const req = reqAs(1, { type: "not-a-type", description: "ça plante" });
		const res = mockRes();

		await createReport(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendDiscordWebhook).not.toHaveBeenCalled();
	});

	it("rejects an empty description", async () => {
		const req = reqAs(1, { type: "bug", description: "   " });
		const res = mockRes();

		await createReport(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendDiscordWebhook).not.toHaveBeenCalled();
	});

	it("rejects a cheating report without a reported user", async () => {
		const req = reqAs(1, { type: "cheating", description: "il triche" });
		const res = mockRes();

		await createReport(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendDiscordWebhook).not.toHaveBeenCalled();
	});

	it("sends the report to Discord and returns 200 for a valid bug report", async () => {
		const req = reqAs(1, { type: "bug", description: "Le jeu crash au mulligan." });
		const res = mockRes();

		await createReport(req, res);

		expect(mocked.sendDiscordWebhook).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.arrayContaining([
					expect.objectContaining({ name: "Description", value: "Le jeu crash au mulligan." }),
				]),
			}),
			expect.stringContaining("Reporter"),
		);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ success: true });
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

		const [[embedArg]] = mocked.sendDiscordWebhook.mock.calls;
		const fieldValues = embedArg.fields.map((f: { value: string }) => f.value).join(" ");
		expect(fieldValues).toContain("Cheater");
		expect(fieldValues).toContain("match-123");
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ success: true });
	});
});
