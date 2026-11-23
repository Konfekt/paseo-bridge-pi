// An offline model for Pi that Paseo runs in the background during tests.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function offlineProvider(pi: any) {
  pi.registerProvider("bridge-offline", {
    api: "bridge-offline-rpc", baseUrl: "http://127.0.0.1:1", apiKey: "offline-fixture-not-a-secret",
    streamSimple(model: any, context: any) {
      const last = context.messages.at(-1);
      const text = JSON.stringify(last?.content ?? "").slice(0, 80);
      const side = JSON.stringify(context.messages).includes("<side_question>");
      const content = [{ type: "text", text: side ? "background side answer" : `background answered: ${text}` }];
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: { role: "assistant", content,
        api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() } } as any));
      return stream;
    },
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
  });
}
