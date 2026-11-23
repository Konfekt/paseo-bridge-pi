import { StringDecoder } from "node:string_decoder";

/** Split a byte stream into JSONL lines, tolerating UTF-8 split across chunks. */
export function lineReader(stream, onLine) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const onData = (chunk) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line.trim()) onLine(line, parseJson(line));
		}
	};
	stream.on("data", onData);
	return () => stream.off("data", onData);
}

export function parseJson(line) {
	try {
		const value = JSON.parse(line);
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

export const jsonLine = (value) => `${JSON.stringify(value)}\n`;
