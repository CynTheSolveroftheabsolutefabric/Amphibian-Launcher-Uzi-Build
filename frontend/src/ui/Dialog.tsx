import { css, type ComponentChild, type FC } from "dreamland/core";
import iconClose from "@ktibow/iconset-material-symbols/close";
import { Button, Icon } from "./Button";

export function Dialog(
	this: FC<{ name: string; open: boolean; children?: ComponentChild }>,
) {
	this.cx.mount = () => {
		const root = this.root as HTMLDialogElement;
		const update = () => {
			if (this.open && !root.open) {
				// Establish the closed styles even when the dialog is created open.
				root.getBoundingClientRect();
				root.showModal();
			} else if (!this.open && root.open) root.close();
		};
		// Dreamland runs this hook while constructing the tree, before it is attached.
		use(this.open).listen(() => queueMicrotask(update));
		queueMicrotask(update);
	};

	return (
		<dialog
			class="component-dialog"
			aria-label={use(this.name)}
			inert={use(this.open).not()}
			on:cancel={() => (this.open = false)}
			on:close={() => {
				if (!(this.root as HTMLDialogElement).open) this.open = false;
			}}
		>
			<div class="header">
				<h2>{use(this.name)}</h2>
				<div class="expand" />
				<Button on:click={() => (this.open = false)} icon="full" title="Close">
					<Icon icon={iconClose} />
				</Button>
			</div>
			<div class="children">{this.children}</div>
		</dialog>
	);
}
Dialog.style = css`
	:scope {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;

		background: var(--bg-sub);
		color: var(--fg);
		border: 1.25px solid var(--surface3);
		border-radius: 1.5rem;

		width: min(40rem, 100%);
		min-height: min(50rem, 100%);
		max-height: min(50rem, 100%);

		position: fixed;
		inset: 0;
		opacity: 0;

		scale: 0.9;
		transform: rotate3d(1, 0, 0, -20deg);
		filter: brightness(1.5);

		pointer-events: none;
		transition:
			opacity 0.25s,
			transform 0.175s,
			filter 0.2s,
			scale 0.2s,
			background 0.1s,
			border-color 0.1s;
		transition-timing-function: ease;
		transition-delay: 0.05s, 0.05s, 0.05s, 0.05s;
		transform-origin: 50% 0%;
		perspective: 1250px;
	}

	:scope[open] {
		opacity: 1;
		transform: rotate3d(1, 0, 0, 0deg);
		filter: brightness(1);
		transition-delay: 0.05s, 0.05s, 0.05s, 0.2s;
		pointer-events: auto;
	}

	:scope[open]::backdrop {
		background: rgba(32, 28, 28, 0.35);
	}

	:scope::backdrop {
		background: rgba(32, 28, 28, 0);
		transition: background 0.2s;
	}

	.header {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		border-bottom: 1.8px solid var(--surface2);
		transition: border-color 0.1s ease;
		padding-bottom: 0.5rem;
		user-select: none;
		-webkit-user-select: none;
	}

	.header h2 {
		margin: 0;
	}

	.children {
		overflow-y: scroll;
		overflow-x: hidden;
		scrollbar-width: none;
		scrollbar-color: transparent transparent;
	}

	.expand {
		flex: 1;
	}
`;
