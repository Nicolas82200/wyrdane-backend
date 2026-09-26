import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendDiscordWebhook } from "./discordHelper";

const ORIGINAL_ENV = process.env.DISCORD_CRASH_WEBHOOK_URL;

describe("sendDiscordWebhook", () => {
	beforeEach(() => {
		process.env.DISCORD_CRASH_WEBHOOK_URL = "https://discord.com/api/webhooks/test";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
	});

	afterEach(() => {
		process.env.DISCORD_CRASH_WEBHOOK_URL = ORIGINAL_ENV;
		vi.unstubAllGlobals();
	});

	it("is a no-op when the webhook URL is not configured", async () => {
		process.env.DISCORD_CRASH_WEBHOOK_URL = "";

		await sendDiscordWebhook({ title: "test" });

		expect(fetch).not.toHaveBeenCalled();
	});

	it("sends plain JSON when no attachment is given", async () => {
		await sendDiscordWebhook({ title: "test" }, "my-thread");

		const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(url).toBe("https://discord.com/api/webhooks/test");
		expect(options.body).not.toBeInstanceOf(FormData);
		const parsed = JSON.parse(options.body as string);
		expect(parsed.thread_name).toBe("my-thread");
	});

	it("sends multipart form data with the file when an attachment is given", async () => {
		await sendDiscordWebhook({ title: "test" }, "my-thread", { filename: "log.txt", content: "hello world" });

		const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(options.body).toBeInstanceOf(FormData);
		const form = options.body as FormData;
		expect(form.get("payload_json")).toContain("my-thread");
		const file = form.get("files[0]") as File;
		expect(file.name).toBe("log.txt");
	});

	it("never throws when the fetch call rejects", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

		await expect(sendDiscordWebhook({ title: "test" })).resolves.toBeUndefined();
	});
});
