import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, useRevealedText } from "@getpaseo/plugin/client/react-native";
import type {
	PluginClientContext,
	PluginTimelineItemProps,
	PluginTimelineTransformerContribution,
} from "@getpaseo/plugin/client";
import { z } from "zod";

const KIND = "paseo-bridge-pi-thinking";

type Data = { text: string; phase: "streaming" | "complete" };

function boldParts(
	text: string,
	streaming: boolean,
): (string | { text: string; bold: true })[] {
	const parts: (string | { text: string; bold: true })[] = [];
	let cursor = 0;
	const pattern = /\*\*([^*]+)\*\*/g;
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > cursor) parts.push(text.slice(cursor, index));
		parts.push({ text: match[1], bold: true });
		cursor = index + match[0].length;
	}
	if (cursor < text.length) {
		const tail = text.slice(cursor);
		const opening = streaming ? tail.indexOf("**") : -1;
		if (opening >= 0) {
			if (opening > 0) parts.push(tail.slice(0, opening));
			parts.push({ text: tail.slice(opening + 2), bold: true });
		} else parts.push(tail);
	}
	return parts.length ? parts : [text];
}

function ThinkingRenderer({ item, theme }: PluginTimelineItemProps<Data>) {
	const [expanded, setExpanded] = useState(false);
	const text = useRevealedText(item.data.text, item.data.phase);
	const parts = boldParts(
		text.replace(/\r?\n$/, ""),
		item.data.phase === "streaming",
	);
	return (
		<View
			style={{
				borderLeftWidth: 2,
				borderLeftColor: theme.colors.border,
				paddingLeft: 10,
				marginVertical: 4,
			}}
		>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={expanded ? "Collapse thinking" : "Expand thinking"}
				accessibilityState={{ expanded }}
				onPress={() => setExpanded((value) => !value)}
				style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
			>
				<Icon name="Brain" size={14} color={theme.colors.foregroundMuted} />
				<Text style={{ color: theme.colors.foregroundMuted }}>Thinking</Text>
			</Pressable>
			{expanded ? (
				<Text
					selectable
					style={{
						color: theme.colors.foregroundMuted,
						marginTop: 6,
						lineHeight: 20,
					}}
				>
					{parts.map((part, index) =>
						typeof part === "string" ? (
							part
						) : (
							<Text key={index} style={{ fontWeight: "700" }}>
								{part.text}
							</Text>
						),
					)}
				</Text>
			) : null}
		</View>
	);
}

export function contributeThinking(client: PluginClientContext): () => void {
	const transformer: PluginTimelineTransformerContribution<"reasoning"> = {
		id: KIND,
		query: { itemType: "reasoning" },
		transform(input) {
			// Projection receives the accumulated reasoning row; leave the original
			// event intact and format only its displayed copy.
			const text = input.item.text;
			return {
				items: [
					{
						type: "plugin",
						kind: KIND,
						version: 1,
						data: { text, phase: input.phase },
					},
				],
			};
		},
	};
	const stopTransform = client.addTimelineTransformer(transformer);
	const stopRenderer = client.addTimelineRenderer({
		kind: KIND,
		version: 1,
		schema: z.object({
			text: z.string(),
			phase: z.enum(["streaming", "complete"]),
		}),
		Component: ThinkingRenderer,
	});
	return () => {
		stopRenderer();
		stopTransform();
	};
}
