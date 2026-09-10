import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/userModel", () => ({
	findOne: vi.fn(),
}));

import { findOne } from "../model/userModel";
import { getOne } from "./userController";

const mockedFindOne = findOne as ReturnType<typeof vi.fn>;

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number | undefined, paramId: string): Request =>
	({ user: userId ? { id: userId } : undefined, params: { id: paramId } } as unknown as Request);

describe("getOne", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects a non-numeric id", async () => {
		const req = reqAs(1, "not-a-number");
		const res = mockRes();
		await getOne(req, res);
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mockedFindOne).not.toHaveBeenCalled();
	});

	it("rejects reading another user's profile (IDOR)", async () => {
		const req = reqAs(1, "2");
		const res = mockRes();
		await getOne(req, res);
		expect(res.status).toHaveBeenCalledWith(404);
		expect(mockedFindOne).not.toHaveBeenCalled();
	});

	it("returns the caller's own profile", async () => {
		mockedFindOne.mockResolvedValue([{ id: 1, username: "Player1" }]);
		const req = reqAs(1, "1");
		const res = mockRes();
		await getOne(req, res);
		expect(mockedFindOne).toHaveBeenCalledWith(1);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ id: 1, username: "Player1" });
	});

	it("returns 404 when the caller's own row is somehow missing", async () => {
		mockedFindOne.mockResolvedValue([]);
		const req = reqAs(1, "1");
		const res = mockRes();
		await getOne(req, res);
		expect(res.status).toHaveBeenCalledWith(404);
	});
});
