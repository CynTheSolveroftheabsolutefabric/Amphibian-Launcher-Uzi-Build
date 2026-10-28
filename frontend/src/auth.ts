import encodeQR from "qr";
import { client } from "./net";

const CLIENT_ID = "00000000402b5328";
const LIVE_SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
const LIVE_DEVICE_CODE_URL = "https://login.live.com/oauth20_connect.srf";
const LIVE_TOKEN_URL = "https://login.live.com/oauth20_token.srf";

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

interface OAuthResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	scope: string;
	refresh_token?: string;
}

interface AuthErrorResponse {
	error?: string;
	error_description?: string;
	errorMessage?: string;
	Message?: string;
	XErr?: number;
}

function authErrorMessage(json: AuthErrorResponse): string {
	if (json.XErr) {
		switch (json.XErr) {
			case 2148916227:
				return "xsts says this account is banned from xbox";
			case 2148916229:
				return "xsts says this account needs permission from its family organizer";
			case 2148916233:
				return "xsts says this account does not have a xbox account";
			case 2148916234:
				return "xsts says this account must accept the Xbox terms of service";
			case 2148916235:
				return "xsts says xbox live is not available in this account's country";
			case 2148916236:
			case 2148916237:
				return "xsts says this account needs adult verification";
			case 2148916238:
				return "xsts says this account is under 18 and needs to be added to a family";
			default:
				return `xsts error: ${json.XErr}`;
		}
	}
	return [json.error, json.error_description, json.errorMessage, json.Message]
		.filter((message) => typeof message === "string" && message.length > 0)
		.join(": ");
}

async function authRequest<T>(
	context: string,
	url: string,
	options?: RequestInit,
	allowedErrors: readonly string[] = [],
	onResponse?: (response: Response) => void
): Promise<T> {
	let res: Response;
	try {
		res = await client.fetch(url, options);
	} catch (error) {
		throw new Error(
			`${context} failed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}
	onResponse?.(res);

	const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
	// Xbox can return its error code in a header with an empty response body.
	const xboxError = Number(res.headers.get("x-err"));
	if (!res.ok && xboxError) {
		throw new Error(`${context} failed (${status}): ${authErrorMessage({ XErr: xboxError })}`);
	}
	let json: unknown;
	try {
		json = await res.json();
	} catch (error) {
		throw new Error(`${context} failed (${status}): invalid JSON response.`, {
			cause: error,
		});
	}
	if (!json || typeof json !== "object" || Array.isArray(json)) {
		throw new Error(`${context} failed (${status}): invalid response.`);
	}

	const data = json as AuthErrorResponse;
	// Device-code polling uses HTTP 400 while waiting for the user to sign in.
	const allowedError = (res.ok || res.status === 400)
		&& typeof data.error === "string" && allowedErrors.includes(data.error);
	if ((!res.ok || data.error || data.XErr) && !allowedError) {
		const message = authErrorMessage(data);
		throw new Error(`${context} failed (${status})${message ? `: ${message}` : "."}`);
	}
	return json as T;
}

export interface Token {
	access: string;
	expires: number;
	refresh: string;
}

interface DeviceCodeResult {
	url: string;
	code: string;
	token: Promise<Token>;
}

function convertOAuthResponse(res: OAuthResponse, previousRefresh?: string): Token {
	const refresh = res.refresh_token ?? previousRefresh;
	if (
		typeof res.access_token !== "string" || !res.access_token
		|| typeof refresh !== "string" || !refresh
		|| !Number.isFinite(res.expires_in) || res.expires_in <= 0
	) {
		throw new Error("Microsoft authentication returned incomplete token information.");
	}
	return {
		access: res.access_token,
		refresh,
		expires: Date.now() + res.expires_in * 1000,
	};
}

export async function deviceCodeAuth(): Promise<DeviceCodeResult> {
	const requestedAt = Date.now();
	let cookie = "";
	const deviceCodeData = await authRequest<DeviceCodeResponse>(
		"Microsoft device code request",
		LIVE_DEVICE_CODE_URL,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				scope: LIVE_SCOPE,
				response_type: "device_code",
			}).toString(),
		},
		[],
		(response) => {
			// Epoxy transports HTTP outside browser fetch's cookie handling.
			const cookies = response.headers.getSetCookie?.();
			cookie = (cookies?.length ? cookies : [response.headers.get("set-cookie") ?? ""])
				.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
		}
	);

	const { device_code, user_code, verification_uri, interval, expires_in } = deviceCodeData;

	if (!device_code || !user_code || !verification_uri
		|| !Number.isFinite(interval) || interval <= 0
		|| !Number.isFinite(expires_in) || expires_in <= 0) {
		throw new Error("Failed to obtain device code information.");
	}
	const tokenGenerator = async () => {
		const expiresAt = requestedAt + expires_in * 1000;
		let pollIntervalMs = interval * 1000;

		while (Date.now() < expiresAt) {
			await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, expiresAt - Date.now())));
			if (Date.now() >= expiresAt) break;
			const pollingResponse = await authRequest<OAuthResponse & AuthErrorResponse>(
				"Microsoft token polling",
				`${LIVE_TOKEN_URL}?client_id=${CLIENT_ID}`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						...(cookie ? { Cookie: cookie } : {}),
					},
					body: new URLSearchParams({
						client_id: CLIENT_ID,
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						device_code: device_code,
					}).toString(),
				},
				["authorization_pending", "slow_down"]
			);

			if (pollingResponse.access_token) {
				return convertOAuthResponse(pollingResponse);
			} else if (pollingResponse.error === "slow_down") {
				pollIntervalMs += 5000;
			} else if (pollingResponse.error !== "authorization_pending") {
				throw new Error("Microsoft token polling did not return a token.");
			}
		}

		throw new Error("Microsoft sign-in code expired. Please sign in again.");
	};
	return { url: verification_uri, code: user_code, token: tokenGenerator() };
}

export async function refreshToken(refresh: string): Promise<Token> {
	const json = await authRequest<OAuthResponse>(
		"Microsoft token refresh",
		LIVE_TOKEN_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				scope: LIVE_SCOPE,
				grant_type: "refresh_token",
				refresh_token: refresh,
			}).toString(),
		}
	);
	return convertOAuthResponse(json, refresh);
}

type AuthCodeResult = DeviceCodeResult & {
	link_url: string;
	qr_svg: string;
	qr_svg_uri: string;
};

export async function startDeviceCodeAuth(): Promise<AuthCodeResult> {
	const codeGenerator = await deviceCodeAuth();
	const linkUrl = "https://microsoft.com/link?otc=" + codeGenerator.code;
	const qrSvg = encodeQR(linkUrl, "svg", {
		scale: 6,
		border: 1,
	});
	return {
		...codeGenerator,
		link_url: linkUrl,
		qr_svg: qrSvg,
		qr_svg_uri: `data:image/svg+xml;base64,${btoa(qrSvg)}`,
	};
}

async function signedXboxRequest<T>(
	context: string,
	url: string,
	payload: object,
	privateKey: CryptoKey,
	contractVersion?: string
): Promise<T> {
	const body = JSON.stringify(payload);
	// Xbox signature policy 1: big-endian version and Windows FILETIME, then
	// NUL-delimited HTTP method, path, authorization header (empty), and UTF-8 body.
	const timestamp = BigInt(Date.now()) * 10000n + 116444736000000000n;
	const fields = new TextEncoder().encode(`POST\0${new URL(url).pathname}\0\0${body}\0`);
	const message = new Uint8Array(14 + fields.length);
	const messageView = new DataView(message.buffer);
	messageView.setUint32(0, 1);
	messageView.setBigUint64(5, timestamp);
	message.set(fields, 14);
	const signature = new Uint8Array(await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" }, privateKey, message
	));
	// WebCrypto returns the fixed-width r || s signature Xbox expects (not DER).
	const header = new Uint8Array(12 + signature.length);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(0, 1);
	headerView.setBigUint64(4, timestamp);
	header.set(signature, 12);
	return authRequest<T>(context, url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			Signature: btoa(String.fromCharCode(...header)),
			...(contractVersion ? { "x-xbl-contract-version": contractVersion } : {}),
		},
		body,
	});
}

async function sisuAuth(msToken: string): Promise<{ token: string; userHash: string }> {
	// The same proof key signs device authentication and SISU authorization.
	// The private key stays in memory and is never exported or persisted.
	const keys = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]
	);
	const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", keys.publicKey);
	const proofKey = { kty, crv, x, y, alg: "ES256", use: "sig" };
	const device = await signedXboxRequest<{ Token?: string }>(
		"Xbox device authentication",
		"https://device.auth.xboxlive.com/device/authenticate",
		{
			Properties: {
				AuthMethod: "ProofOfPossession",
				Id: `{${crypto.randomUUID()}}`,
				DeviceType: "Win32",
				SerialNumber: `{${crypto.randomUUID()}}`,
				Version: "0.0.0",
				ProofKey: proofKey,
			},
			RelyingParty: "http://auth.xboxlive.com",
			TokenType: "JWT",
		},
		keys.privateKey,
		"1"
	);
	if (typeof device.Token !== "string" || !device.Token) {
		throw new Error("Xbox device authentication did not return a token.");
	}
	const sisu = await signedXboxRequest<{
		AuthorizationToken?: {
			Token?: string;
			DisplayClaims?: { xui?: { uhs?: string }[] };
		};
	}>(
		"Xbox SISU authorization",
		"https://sisu.xboxlive.com/authorize",
		{
			AccessToken: `t=${msToken}`,
			AppId: CLIENT_ID,
			DeviceToken: device.Token,
			Sandbox: "RETAIL",
			UseModernGamertag: true,
			SiteName: "user.auth.xboxlive.com",
			RelyingParty: "rp://api.minecraftservices.com/",
			ProofKey: proofKey,
		},
		keys.privateKey
	);
	const token = sisu.AuthorizationToken?.Token;
	const userHash = sisu.AuthorizationToken?.DisplayClaims?.xui?.[0]?.uhs;
	if (typeof token !== "string" || !token || typeof userHash !== "string" || !userHash) {
		throw new Error("Xbox SISU authorization did not return a token and user hash.");
	}
	return { token, userHash };
}

async function mcAuth(xstsToken: string, xstsHash: string): Promise<string> {
	const json = await authRequest<{ access_token?: string }>(
		"Minecraft authentication",
		"https://api.minecraftservices.com/authentication/login_with_xbox",
		{
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			method: "POST",
			body: JSON.stringify({
				identityToken: `XBL3.0 x=${xstsHash};${xstsToken}`,
			}),
		}
	);
	const token = json["access_token"];
	if (!token) throw new Error("minecraft did not return a token");

	if (!(await checkOwnership(token))) throw new Error("account does not own minecraft");

	return token;
}

export async function checkOwnership(mcToken: string): Promise<boolean> {
	const json = await authRequest<{ items?: { name: string }[] }>(
		"Minecraft ownership check",
		"https://api.minecraftservices.com/entitlements/mcstore",
		{
			headers: {
				Authorization: `Bearer ${mcToken}`,
			},
		}
	);
	if (!Array.isArray(json.items)) {
		throw new Error("Minecraft ownership check did not return entitlements.");
	}
	return json.items.some(
		(item) => item.name === "product_minecraft" || item.name === "game_minecraft"
	);
}

// https://gist.github.com/Plagiatus/ce5f18bc010395fc45d8553905e10f55
export interface UserInfo {
	id: string;
	name: string;
	skins: SkinInfo[];
	capes: CapeInfo[];
}
export interface AccessoryInfo {
	id: string;
	state: "ACTIVE" | "INACTIVE";
	url: string;
}
export interface SkinInfo extends AccessoryInfo {
	variant: string;
}
export interface CapeInfo extends AccessoryInfo {
	alias: string;
}

export async function getProfile(mcToken: string): Promise<UserInfo> {
	const json = await authRequest<UserInfo>(
		"Minecraft profile request",
		"https://api.minecraftservices.com/minecraft/profile",
		{
			headers: {
				Authorization: `Bearer ${mcToken}`,
			},
		}
	);
	if (!json["id"] || !json["name"])
		throw new Error("mc did not return a profile");

	return json;
}

export async function minecraftAuth(msToken: string): Promise<string> {
	const xstsInfo = await sisuAuth(msToken);
	return mcAuth(xstsInfo.token, xstsInfo.userHash);
}
