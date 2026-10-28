import { css, type FC } from "dreamland/core";

export function Switch(
	this: FC<
		{
			"on:change"?: (() => void) | ((e: Event) => void);
			on: boolean;
			title: string;
			disabled: boolean;
			class?: string;
		},
		{}
	>,
) {
	return (
		<div class="component-switch">
			<span class="switch-label">{use(this.title)}</span>
			<label
				class={use(this.class).map(
					(className) => `switch-container ${className || ""}`,
				)}
			>
				<input
					type="checkbox"
					disabled={use(this.disabled)}
					checked={use(this.on)}
					on:change={this["on:change"] || (() => {})}
					aria-label={use(this.title)}
					title={use(this.title, this.disabled).map(
						([title, disabled]) => title + (disabled ? " (disabled)" : ""),
					)}
				/>
				<span class="switch-slider"></span>
			</label>
		</div>
	);
}
Switch.style = css`
	:scope {
		align-items: center;
		display: flex;
		justify-content: space-between;

		user-select: none;
		-webkit-user-select: none;
	}

	.switch-container {
		position: relative;
		display: inline-block;
		width: 3.2rem;
		height: 1.8rem;
		flex: 0 0 auto;
		max-width: 3.2rem;
	}

	.switch-container input {
		position: absolute;
		inset: 0;
		z-index: 1;
		opacity: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		cursor: pointer;
	}
	.switch-container input:disabled {
		cursor: not-allowed;
	}

	.switch-slider {
		position: absolute;
		cursor: pointer;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: var(--surface3);
		transition:
			background 0.2s,
			transform 0.2s,
			width 0.2s;
		border-radius: 2rem;
		box-shadow:
			inset 0px 0px 5px -0.1px color-mix(in srgb, var(--fg) 10%, transparent),
			inset 0px -0.7px 1px 0px color-mix(in srgb, var(--fg) 17.5%, transparent);
	}

	.switch-slider::before {
		position: absolute;
		content: "";
		height: 1.4rem;
		width: 1.4rem;
		left: 0.2rem;
		bottom: 0.2rem;
		background-color: white;
		transition:
			background 0.2s,
			transform 0.2s,
			width 0.2s;
		border-radius: 1.5rem;
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
	}

	input:checked + .switch-slider {
		background-color: var(--accent);
	}

	input:active + .switch-slider {
		background-color: var(--surface5);
	}

	.switch-container:hover input:checked:not(:disabled) + .switch-slider {
		background-color: color-mix(in srgb, var(--accent) 87.5%, var(--fg));
	}

	input:checked:active + .switch-slider {
		background-color: color-mix(in srgb, var(--accent) 70%, var(--fg));
	}

	.switch-container:hover input:not(:checked):not(:disabled) + .switch-slider {
		background-color: var(--surface4);
	}

	input:not(:disabled):active + .switch-slider::before {
		width: 1.7rem;
		transition:
			background 0.2s,
			transform 0.2s,
			width 0.2s;
	}

	input:not(:disabled):checked:active + .switch-slider::before {
		transform: translateX(1.1rem);
	}

	input:disabled + .switch-slider {
		background-color: var(--surface0);
		cursor: not-allowed;
	}

	input:checked:disabled + .switch-slider {
		background-color: color-mix(in srgb, var(--accent) 50%, var(--surface3));
	}

	input:checked + .switch-slider::before {
		transform: translateX(1.4rem);
	}

	input:disabled + .switch-slider::before {
		background-color: color-mix(in srgb, #888888 92.5%, var(--accent));
	}

	input:checked:disabled + .switch-slider::before {
		background-color: color-mix(in srgb, #bbbbbb 92.5%, var(--accent));
	}

	input:focus-visible + .switch-slider {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
`;
