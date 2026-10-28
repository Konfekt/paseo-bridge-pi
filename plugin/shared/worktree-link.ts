type LinkKeyEvent = {
	key: string;
	repeat?: boolean;
	preventDefault(): void;
	stopPropagation(): void;
};

/**
 * RN Web's PressResponder defers role=link Enter activation to the browser,
 * but a workspace command has no href (navigation is the public host callback).
 * Use Pressable's public web onKeyDown hook; native hosts receive no web props.
 */
export function worktreeLinkKeyboardProps(platform: string, disabled: boolean, open: () => void) {
	return platform === "web" ? {
		onKeyDown(event: LinkKeyEvent) {
			if (disabled || event.key !== "Enter" || event.repeat) return;
			event.preventDefault();
			event.stopPropagation();
			open();
		},
	} : {};
}
