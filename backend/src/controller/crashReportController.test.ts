import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../helper/discordHelper", () => ({
	sendDiscordWebhook: vi.fn(),
}));

import { sendDiscordWebhook } from "../helper/discordHelper";
import { submitCrashReport } from "./crashReportController";

const mocked = {
	sendDiscordWebhook: sendDiscordWebhook as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	res.sendStatus = vi.fn().mockReturnValue(res);
	return res;
};

const validBody = {
	crashType: "crash",
	platform: "Windows 11",
	gameVersion: "1.4.2",
	reporterName: "Alice",
	log: "ERROR: something went wrong\nSCRIPT ERROR: at battle.gd:42",
};

describe("submitCrashReport", () => {
	beforeEach(() => vi.resetAllMocks());

	it("forwards the report to Discord and returns 200 on a valid submission", async () => {
		const req = { body: validBody } as Request;
		const res = mockRes();

		await submitCrashReport(req, res);

		expect(mocked.sendDiscordWebhook).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: expect.arrayContaining([
					expect.objectContaining({ name: "Fin du log" }),
				]),
			}),
		);
		expect(res.sendStatus).toHaveBeenCalledWith(200);
	});

	it("rejects an unknown crash type", async () => {
		const req = { body: { ...validBody, crashType: "not-a-type" } } as Request;
		const res = mockRes();

		await submitCrashReport(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendDiscordWebhook).not.toHaveBeenCalled();
	});

	it("rejects a submission missing the log", async () => {
		const req = { body: { ...validBody, log: undefined } } as unknown as Request;
		const res = mockRes();

		await submitCrashReport(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendDiscordWebhook).not.toHaveBeenCalled();
	});

	it("rejects an oversized log", async () => {
		const req = { body: { ...validBody, log: "x".repeat(200_001) } } as Request;
		const res = mockRes();

		await submitCrashReport(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendDiscordWebhook).not.toHaveBeenCalled();
	});

	it("truncates the log to only its last characters when oversized for a Discord field", async () => {
		const req = { body: { ...validBody, log: "x".repeat(5000) } } as Request;
		const res = mockRes();

		await submitCrashReport(req, res);

		const call = mocked.sendDiscordWebhook.mock.calls[0][0];
		const logField = call.fields.find((f: { name: string }) => f.name === "Fin du log");
		expect(logField.value.length).toBeLessThan(1024);
		expect(logField.value).toContain("tronqué");
	});

	it("silently accepts (without notifying Discord) when the honeypot field is filled", async () => {
		const req = { body: { ...validBody, website: "https://spam.example" } } as Request;
		const res = mockRes();

		await submitCrashReport(req, res);

		expect(mocked.sendDiscordWebhook).not.toHaveBeenCalled();
		expect(res.sendStatus).toHaveBeenCalledWith(200);
	});
});
