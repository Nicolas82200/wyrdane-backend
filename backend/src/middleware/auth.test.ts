import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../helper/jwtHelper", () => ({
	decodeJWT: vi.fn(),
}));

import { decodeJWT } from "../helper/jwtHelper";
import authorization from "./auth";

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

describe("authorization middleware", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects with 401 when there is no auth_token cookie", () => {
		const req = { cookies: {} } as unknown as Request;
		const res = mockRes();
		const next = vi.fn();

		authorization(req, res, next);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(next).not.toHaveBeenCalled();
	});

	it("rejects with 401 when decodeJWT throws (invalid/expired token)", () => {
		const req = { cookies: { auth_token: "Bearer bad.token.here" } } as unknown as Request;
		const res = mockRes();
		const next = vi.fn();
		(decodeJWT as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("jwt expired");
		});

		authorization(req, res, next);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(next).not.toHaveBeenCalled();
	});

	it("sets req.user and calls next() for a valid token", () => {
		const req = { cookies: { auth_token: "Bearer good.token.here" } } as unknown as Request;
		const res = mockRes();
		const next = vi.fn();
		(decodeJWT as ReturnType<typeof vi.fn>).mockReturnValue({ id: 7, name: "Joueur" });

		authorization(req, res, next);

		expect(decodeJWT).toHaveBeenCalledWith("good.token.here");
		expect(req.user).toEqual({ id: 7, name: "Joueur" });
		expect(next).toHaveBeenCalledTimes(1);
		expect(res.status).not.toHaveBeenCalled();
	});
});
