import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../helper/mailHelper", () => ({
	sendMail: vi.fn(),
}));

import { sendMail } from "../helper/mailHelper";
import { submitContact } from "./contactController";

const mocked = {
	sendMail: sendMail as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	res.sendStatus = vi.fn().mockReturnValue(res);
	return res;
};

const validBody = {
	name: "Alice",
	email: "alice@example.com",
	category: "bug",
	message: "Le jeu crash au mulligan.",
};

describe("submitContact", () => {
	beforeEach(() => vi.resetAllMocks());

	it("sends the mail and returns 200 on a valid submission", async () => {
		const req = { body: validBody } as Request;
		const res = mockRes();

		await submitContact(req, res);

		expect(mocked.sendMail).toHaveBeenCalledWith(
			expect.objectContaining({ replyTo: "alice@example.com" }),
		);
		expect(res.sendStatus).toHaveBeenCalledWith(200);
	});

	it("rejects a submission missing required fields", async () => {
		const req = { body: { name: "Alice" } } as unknown as Request;
		const res = mockRes();

		await submitContact(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendMail).not.toHaveBeenCalled();
	});

	it("rejects an invalid email", async () => {
		const req = { body: { ...validBody, email: "not-an-email" } } as Request;
		const res = mockRes();

		await submitContact(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendMail).not.toHaveBeenCalled();
	});

	it("rejects an unknown category", async () => {
		const req = { body: { ...validBody, category: "not-a-category" } } as Request;
		const res = mockRes();

		await submitContact(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.sendMail).not.toHaveBeenCalled();
	});

	it("silently accepts (without sending mail) when the honeypot field is filled", async () => {
		const req = { body: { ...validBody, website: "https://spam.example" } } as Request;
		const res = mockRes();

		await submitContact(req, res);

		expect(res.sendStatus).toHaveBeenCalledWith(200);
		expect(mocked.sendMail).not.toHaveBeenCalled();
	});

	it("includes the portfolio link in the mail body when provided", async () => {
		const req = {
			body: { ...validBody, category: "illustrator", portfolioLink: "https://portfolio.example" },
		} as Request;
		const res = mockRes();

		await submitContact(req, res);

		expect(mocked.sendMail).toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringContaining("https://portfolio.example") }),
		);
	});
});
