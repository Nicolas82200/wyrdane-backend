import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
	default: {
		query: vi.fn(),
	},
}));

import db from "./db";
import { heartbeat } from "./presenceModel";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn> };

describe("heartbeat", () => {
	beforeEach(() => vi.clearAllMocks());

	it("updates last_heartbeat_at and in_game for the caller", async () => {
		mockedDb.query.mockResolvedValueOnce([{}]);

		await heartbeat(1, true);

		const [sql, params] = mockedDb.query.mock.calls[0];
		expect(sql).toContain("UPDATE users SET last_heartbeat_at = NOW()");
		expect(params).toEqual([true, 1]);
	});
});
