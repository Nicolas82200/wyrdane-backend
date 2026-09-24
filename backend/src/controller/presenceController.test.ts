import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../model/presenceModel", () => ({
	heartbeat: vi.fn(),
}));

import { heartbeat } from "../model/presenceModel";
import { sendHeartbeat } from "./presenceController";

const mockedHeartbeat = heartbeat as ReturnType<typeof vi.fn>;

const mockRes = (): Response => {
	const res = {} as Response;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res;
};

const reqAs = (userId: number | undefined, body: Record<string, unknown> = {}): Request =>
	({ user: userId ? { id: userId } : undefined, body } as unknown as Request);

describe("sendHeartbeat", () => {
	beforeEach(() => vi.resetAllMocks());

	it("rejects unauthenticated requests", async () => {
		const res = mockRes();
		await sendHeartbeat(reqAs(undefined), res);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(mockedHeartbeat).not.toHaveBeenCalled();
	});

	it("forwards inGame=true", async () => {
		const res = mockRes();
		await sendHeartbeat(reqAs(1, { inGame: true }), res);
		expect(mockedHeartbeat).toHaveBeenCalledWith(1, true);
	});

	it("defaults inGame to false when absent", async () => {
		const res = mockRes();
		await sendHeartbeat(reqAs(1, {}), res);
		expect(mockedHeartbeat).toHaveBeenCalledWith(1, false);
	});
});
