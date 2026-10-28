import { css, type ComponentChild, type FC } from "dreamland/core";
import type { IconifyIcon } from "@iconify/types";

export function Button(
	this: FC<{
		"on:click"?: (event: MouseEvent) => void;
		children?: ComponentChild;
		class?: string;
		type?: "primary" | "normal" | "listitem" | "listaction";
		icon?: "full" | "left" | "none";
		disabled?: boolean;
		title?: string;
	}>,
) {
	return (
		<button
			type="button"
			on:click={this["on:click"] || (() => {})}
			class={use(this.icon, this.type, this.class).map(
				([icon, type, className]) =>
					`component-btn icon-${icon || "none"} type-${type || "normal"} ${className || ""}`,
			)}
			disabled={use(this.disabled)}
			title={use(this.title)}
			aria-label={use(this.title)}
		>
			{this.children}
		</button>
	);
}
Button.style = css`
	:scope {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		border: none;
		border-radius: 20rem;
		padding: 0.5rem;
		font-family: var(--font-body);
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		transform-origin: 50% 100%;
		perspective: 1250px;
		transition:
			background 0.15s,
			color 0.15s,
			transform 0.15s,
			border-color 0.15s;
	}
	:scope:not(:disabled, .type-listitem) {
		--border-color: color-mix(in srgb, var(--fg) 10.5%, transparent);
		box-shadow: inset 0 -0.85px 1px 0 var(--border-color);
	}
	:scope:not(:disabled):hover {
		transform: rotate3d(1, 0, 0, 7.5deg);
	}
	:scope:not(:disabled):active {
		transform: rotate3d(1, 0, 0, 17.5deg);
	}
	:scope:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	:scope.icon-full :global(svg),
	:scope.icon-left :global(svg) {
		width: 1.5rem;
		height: 1.5rem;
	}
	:scope.icon-full {
		border-radius: 4rem;
	}
	:scope.icon-left {
		gap: 0.25rem;
	}
	:scope.type-primary {
		background: var(--accent);
		color: var(--fg);
		--border-color: color-mix(in srgb, var(--accent) 55%, var(--fg));
	}
	:scope.type-normal,
	:scope.type-listaction {
		background: var(--surface1);
		color: var(--fg);
	}
	:scope.type-listitem {
		background: transparent;
		color: var(--fg);
		border-radius: 0.85rem;
		padding-block: 0.75rem;
		padding-inline: 0.5rem;
		transition-duration: 0.1s;
	}
	:scope.type-primary:not(:disabled):hover {
		background: color-mix(in srgb, var(--accent) 80%, white);
	}
	:scope.type-primary:not(:disabled):active {
		background: color-mix(in srgb, var(--accent) 70%, white);
	}
	:scope.type-normal:not(:disabled):hover {
		background: var(--surface3);
	}
	:scope.type-normal:not(:disabled):active {
		background: var(--surface4);
	}
	:scope.type-listitem:not(:disabled):hover {
		background: var(--surface0);
	}
	:scope.type-listitem:not(:disabled):active {
		background: var(--surface1);
	}
	:scope.type-listaction:not(:disabled):hover {
		background: var(--surface2);
	}
	:scope.type-listaction:not(:disabled):active {
		background: var(--surface3);
	}
	:scope:disabled {
		background: var(--surface0);
		color: var(--surface6);
		cursor: not-allowed;
		border-color: transparent;
	}
`;

export function Icon(this: FC<{ icon: IconifyIcon; class?: string }>) {
	this.cx.mount = () => {
		const update = () => (this.root.innerHTML = this.icon.body);
		use(this.icon).listen(update);
		update();
	};
	return (
		<svg
			width="1em"
			height="1em"
			viewBox={use(this.icon).map(
				(icon) => `0 0 ${icon.width || 24} ${icon.height || 24}`,
			)}
			xmlns="http://www.w3.org/2000/svg"
			class={use(this.class).map(
				(className) => `component-icon ${className || ""}`,
			)}
			aria-hidden="true"
		/>
	);
}
Icon.style = css`
	:scope {
		display: inline-block;
		flex-shrink: 0;
	}
`;

export function Link(this: FC<{ href: string; children?: ComponentChild }>) {
	return (
		<a
			href={use(this.href)}
			class="component-link"
			target="_blank"
			rel="noopener noreferrer"
		>
			{this.children}
		</a>
	);
}
