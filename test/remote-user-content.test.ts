import assert from "node:assert/strict";
import test from "node:test";
import { remoteUserContent } from "../extension/remote-user-content.ts";

test("text-only remote messages keep their exact string representation", () => {
  const message = "  literal JSON {\"x\":1}\nsecond line  ";
  assert.equal(remoteUserContent(message), message);
  assert.equal(remoteUserContent(message, []), message);
});

test("images survive remote message construction in order without mutation", () => {
  const images = [
    { type: "image" as const, data: "synthetic-first", mimeType: "image/png" },
    { type: "image" as const, data: "synthetic-second", mimeType: "image/jpeg" },
  ];
  const before = structuredClone(images);
  const content = remoteUserContent("Look at these", images);
  assert.deepEqual(content, [{ type: "text", text: "Look at these" }, ...images]);
  assert.ok(Array.isArray(content));
  assert.equal(content[1], images[0]);
  assert.equal(content[2], images[1]);
  assert.deepEqual(images, before);
});

test("image-only remote messages do not lose their image blocks", () => {
  const image = { type: "image" as const, data: "synthetic", mimeType: "image/png" };
  assert.deepEqual(remoteUserContent("", [image]), [{ type: "text", text: "" }, image]);
});
