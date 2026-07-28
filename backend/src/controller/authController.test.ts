import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../helper/steamHelper", () => ({
	authenticateSteamTicket: vi.fn(),
}));
vi.mock("../helper/steamOpenIdHelper", () => ({
	buildAuthUrl: vi.fn(() => "https://steamcommunity.com/openid/login?mock=1"),
	verifyAssertion: vi.fn(),
}));
vi.mock("../model/userModel", () => ({
	findBySteamId: vi.fn(),
	createWithSteamAccount: vi.fn(),
}));
vi.mock("../model/collectionModel", () => ({
	grantAllCards: vi.fn(),
}));
vi.mock("../helper/jwtHelper", () => ({
	encodeJWT: vi.fn(() => "signed.jwt.token"),
}));

import { authenticateSteamTicket } from "../helper/steamHelper";
import { verifyAssertion } from "../helper/steamOpenIdHelper";
import { findBySteamId, createWithSteamAccount } from "../model/userModel";
import { grantAllCards } from "../model/collectionModel";
import { steamLogin, steamOpenIdCallback, logout, authVerif } from "./authController";

const mocked = {
	authenticateSteamTicket: authenticateSteamTicket as ReturnType<typeof vi.fn>,
	verifyAssertion: verifyAssertion as ReturnType<typeof vi.fn>,
	findBySteamId: findBySteamId as ReturnType<typeof vi.fn>,
	createWithSteamAccount: createWithSteamAccount as ReturnType<typeof vi.fn>,
	grantAllCards: grantAllCards as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	res.cookie = vi.fn().mockReturnValue(res);
	res.clearCookie = vi.fn().mockReturnValue(res);
	res.redirect = vi.fn().mockReturnValue(res);
	res.sendStatus = vi.fn().mockReturnValue(res);
	return res;
};

describe("steamLogin", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		process.env.NODE_ENV = "test";
		delete process.env.DEV_GRANT_ALL_CARDS;
	});

	it("rejects a request without a ticket", async () => {
		const req = { body: {} } as unknown as Request;
		const res = mockRes();

		await steamLogin(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mocked.authenticateSteamTicket).not.toHaveBeenCalled();
	});

	it("rejects an invalid/unverifiable Steam ticket", async () => {
		mocked.authenticateSteamTicket.mockResolvedValue(null);
		const req = { body: { ticket: "bogus" } } as unknown as Request;
		const res = mockRes();

		await steamLogin(req, res);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(mocked.findBySteamId).not.toHaveBeenCalled();
	});

	it("logs in an existing player without creating a new account", async () => {
		mocked.authenticateSteamTicket.mockResolvedValue("76561198000000001");
		mocked.findBySteamId.mockResolvedValue([{ id: 1, username: "Vétéran" }]);
		const req = { body: { ticket: "ok" } } as unknown as Request;
		const res = mockRes();

		await steamLogin(req, res);

		expect(mocked.createWithSteamAccount).not.toHaveBeenCalled();
		expect(res.cookie).toHaveBeenCalledWith("auth_token", "Bearer signed.jwt.token", expect.any(Object));
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("creates a new account on first login and does not grant the full collection by default", async () => {
		mocked.authenticateSteamTicket.mockResolvedValue("76561198000000002");
		mocked.findBySteamId.mockResolvedValue([]);
		mocked.createWithSteamAccount.mockResolvedValue({ id: 2, username: "Player000002" });
		const req = { body: { ticket: "ok" } } as unknown as Request;
		const res = mockRes();

		await steamLogin(req, res);

		expect(mocked.createWithSteamAccount).toHaveBeenCalledWith("Player000002", "76561198000000002");
		expect(mocked.grantAllCards).not.toHaveBeenCalled();
	});

	it("grants the full collection to new accounts only when DEV_GRANT_ALL_CARDS is enabled", async () => {
		process.env.DEV_GRANT_ALL_CARDS = "true";
		mocked.authenticateSteamTicket.mockResolvedValue("76561198000000003");
		mocked.findBySteamId.mockResolvedValue([]);
		mocked.createWithSteamAccount.mockResolvedValue({ id: 3, username: "Player000003" });
		const req = { body: { ticket: "ok" } } as unknown as Request;
		const res = mockRes();

		await steamLogin(req, res);

		expect(mocked.grantAllCards).toHaveBeenCalledWith(3);
	});

	it("sets a cross-site-safe cookie (SameSite=None, Secure) in production", async () => {
		process.env.NODE_ENV = "production";
		mocked.authenticateSteamTicket.mockResolvedValue("1");
		mocked.findBySteamId.mockResolvedValue([{ id: 1, username: "X" }]);
		const req = { body: { ticket: "ok" } } as unknown as Request;
		const res = mockRes();

		await steamLogin(req, res);

		expect(res.cookie).toHaveBeenCalledWith(
			"auth_token",
			expect.any(String),
			expect.objectContaining({ sameSite: "none", secure: true }),
		);
	});
});

describe("steamOpenIdCallback", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects when the OpenID assertion cannot be verified against Steam", async () => {
		mocked.verifyAssertion.mockResolvedValue(null);
		const req = { query: {} } as unknown as Request;
		const res = mockRes();

		await steamOpenIdCallback(req, res);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(res.redirect).not.toHaveBeenCalled();
	});

	it("logs the player in and redirects to the frontend on a valid assertion", async () => {
		process.env.FRONTEND_URL = "https://wyrdane.example";
		mocked.verifyAssertion.mockResolvedValue("76561198000000001");
		mocked.findBySteamId.mockResolvedValue([{ id: 1, username: "X" }]);
		const req = { query: {} } as unknown as Request;
		const res = mockRes();

		await steamOpenIdCallback(req, res);

		expect(res.redirect).toHaveBeenCalledWith("https://wyrdane.example");
	});
});

describe("logout / authVerif", () => {
	it("clears the auth cookie on logout", () => {
		const req = {} as Request;
		const res = mockRes();
		logout(req, res);
		expect(res.clearCookie).toHaveBeenCalledWith("auth_token");
		expect(res.sendStatus).toHaveBeenCalledWith(200);
	});

	it("echoes back the authenticated user on authVerif", () => {
		const req = { user: { id: 1, name: "X" } } as unknown as Request;
		const res = mockRes();
		authVerif(req, res);
		expect(res.json).toHaveBeenCalledWith({ authValid: true, users: { id: 1, name: "X" } });
	});
});
