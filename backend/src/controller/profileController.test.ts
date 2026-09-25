import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/profileModel", () => ({
	getProfile: vi.fn(),
}));
vi.mock("../model/friendModel", () => ({
	findFriendship: vi.fn(),
}));

import { getProfile } from "../model/profileModel";
import { findFriendship } from "../model/friendModel";
import { getMyProfile, getFriendProfile } from "./profileController";

const mocked = {
	getProfile: getProfile as ReturnType<typeof vi.fn>,
	findFriendship: findFriendship as ReturnType<typeof vi.fn>,
};

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number | undefined, params: Record<string, string> = {}): Request =>
	({ user: userId ? { id: userId } : undefined, params } as unknown as Request);

describe("getMyProfile", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const res = mockRes();
		await getMyProfile(reqAs(undefined), res);
		expect(res.status).toHaveBeenCalledWith(401);
	});

	it("returns 404 when the profile doesn't exist", async () => {
		mocked.getProfile.mockResolvedValue(null);
		const res = mockRes();
		await getMyProfile(reqAs(1), res);
		expect(res.status).toHaveBeenCalledWith(404);
	});

	it("returns the caller's own profile", async () => {
		mocked.getProfile.mockResolvedValue({ id: 1, username: "Nico" });
		const res = mockRes();
		await getMyProfile(reqAs(1), res);
		expect(mocked.getProfile).toHaveBeenCalledWith(1);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ id: 1, username: "Nico" });
	});
});

describe("getFriendProfile", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const res = mockRes();
		await getFriendProfile(reqAs(undefined, { userId: "2" }), res);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(mocked.getProfile).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric userId", async () => {
		const res = mockRes();
		await getFriendProfile(reqAs(1, { userId: "abc" }), res);
		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("allows a viewer to fetch their own profile through this route without a friendship check", async () => {
		mocked.getProfile.mockResolvedValue({ id: 1, username: "Nico" });
		const res = mockRes();
		await getFriendProfile(reqAs(1, { userId: "1" }), res);
		expect(mocked.findFriendship).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("rejects when the target is not an accepted friend", async () => {
		mocked.findFriendship.mockResolvedValue(null);
		const res = mockRes();
		await getFriendProfile(reqAs(1, { userId: "2" }), res);
		expect(res.status).toHaveBeenCalledWith(403);
		expect(mocked.getProfile).not.toHaveBeenCalled();
	});

	it("rejects when the friendship is still pending", async () => {
		mocked.findFriendship.mockResolvedValue({ id: 9, requester_id: 1, addressee_id: 2, status: "pending" });
		const res = mockRes();
		await getFriendProfile(reqAs(1, { userId: "2" }), res);
		expect(res.status).toHaveBeenCalledWith(403);
	});

	it("returns the friend's profile once the friendship is accepted", async () => {
		mocked.findFriendship.mockResolvedValue({ id: 9, requester_id: 1, addressee_id: 2, status: "accepted" });
		mocked.getProfile.mockResolvedValue({ id: 2, username: "Ami" });
		const res = mockRes();
		await getFriendProfile(reqAs(1, { userId: "2" }), res);
		expect(mocked.getProfile).toHaveBeenCalledWith(2);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ id: 2, username: "Ami" });
	});

	it("returns 404 when the target user doesn't exist", async () => {
		mocked.findFriendship.mockResolvedValue({ id: 9, requester_id: 1, addressee_id: 2, status: "accepted" });
		mocked.getProfile.mockResolvedValue(null);
		const res = mockRes();
		await getFriendProfile(reqAs(1, { userId: "2" }), res);
		expect(res.status).toHaveBeenCalledWith(404);
	});
});
