import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RemoteTarget } from "../contracts.ts";
import { type ExecOptions, Executor, type PreparedCommand } from "./exec.ts";
import { REMOTE_HELPER_FILENAME, REMOTE_HELPER_SOURCE } from "./remote-helper.ts";
import { sha256Hex, shellQuote, ToolFailure } from "./util.ts";

/**
 * Hostnames are concatenated into an argv we hand to ssh. Anything outside this
 * shape — a leading dash that ssh would read as a flag, whitespace, shell
 * metacharacters — is rejected rather than escaped, because there is no
 * legitimate host that needs them.
 */
const HOST_PATTERN =
	/^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/;

export interface ValidatedTarget {
	host: string;
	port: number | undefined;
	identityFile: string | undefined;
	knownHostsFile: string | undefined;
	cwd: string;
}

/** Paths handed to ssh as option values must not be readable as flags. */
function validatePathOption(value: string | undefined, label: string): string | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const path = value.trim();
	if (path.startsWith("-")) throw new ToolFailure(`Refusing ${label} that starts with "-": ${path}`);
	return path;
}

export function validateTarget(target: RemoteTarget): ValidatedTarget {
	const host = target.host.trim();
	if (host.length === 0) throw new ToolFailure("Remote target has an empty host.");
	if (host.startsWith("-")) throw new ToolFailure(`Refusing SSH host that starts with "-": ${host}`);
	if (!HOST_PATTERN.test(host)) throw new ToolFailure(`Refusing unsafe SSH host: ${host}`);

	let port: number | undefined;
	if (target.port !== undefined) {
		if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
			throw new ToolFailure(`Invalid SSH port: ${target.port}`);
		}
		port = target.port;
	}

	const identityFile = validatePathOption(target.identityFile, "identity file");
	const knownHostsFile = validatePathOption(target.knownHostsFile, "known hosts file");
	if (knownHostsFile !== undefined && !knownHostsFile.startsWith("/")) {
		throw new ToolFailure(`Known hosts file must be an absolute path, received: ${knownHostsFile}`);
	}

	const cwd = target.cwd.trim();
	if (!cwd.startsWith("/"))
		throw new ToolFailure(`Remote cwd must be an absolute POSIX path, received: ${target.cwd}`);
	return { host, port, identityFile, knownHostsFile, cwd };
}

/**
 * Identity of the SSH *connection*, deliberately excluding `cwd`. Directories
 * vary per call — an agent may work in a remote worktree while the parent
 * session sits at the repository root — but they all share one multiplexed
 * connection and one control socket.
 *
 * The trust store is part of the identity: two targets that differ only in
 * `knownHostsFile` must not end up sharing a master connection that was
 * authenticated against the other one's host keys.
 */
export function connectionKey(target: RemoteTarget): string {
	const validated = validateTarget(target);
	return `ssh:${validated.host}:${validated.port ?? 22}:${validated.identityFile ?? ""}:${validated.knownHostsFile ?? ""}`;
}

/** Remote cache root; expanded by the remote shell, never by us. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, deliberately left for the remote shell.
const REMOTE_CACHE_EXPR = '"${XDG_CACHE_HOME:-$HOME/.cache}/salam"';

/**
 * Runs commands on an SSH target. One OpenSSH ControlMaster is shared by every
 * command for the lifetime of the session, so per-call cost is a multiplexed
 * channel rather than a fresh TCP + auth handshake.
 */
export class RemoteExecutor extends Executor {
	readonly id: string;
	readonly defaultCwd: string;
	private readonly target: ValidatedTarget;
	private readonly baseArgs: string[];
	private readonly controlPath: string;
	private cacheDirectory: Promise<string> | undefined;
	private helperInstall: Promise<string> | undefined;
	private closed = false;

	constructor(
		readonly remote: RemoteTarget,
		home: string,
	) {
		super();
		this.target = validateTarget(remote);
		this.id = connectionKey(remote);
		this.defaultCwd = this.target.cwd;
		const socketDir = join(home, "ssh");
		mkdirSync(socketDir, { recursive: true, mode: 0o700 });
		// Unix socket paths are length-limited (~104 bytes on macOS), so the
		// control socket is a short digest rather than the readable target name.
		this.controlPath = join(
			socketDir,
			`m-${sha256Hex(this.id).slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`,
		);
		this.baseArgs = [
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=5",
			"-o",
			"ControlMaster=auto",
			"-o",
			`ControlPath=${this.controlPath}`,
			"-o",
			"ControlPersist=600",
			"-o",
			"ServerAliveInterval=20",
			"-o",
			"ServerAliveCountMax=3",
			"-o",
			"LogLevel=ERROR",
		];
		if (this.target.port !== undefined) this.baseArgs.push("-p", String(this.target.port));
		if (this.target.identityFile !== undefined) {
			this.baseArgs.push("-i", this.target.identityFile, "-o", "IdentitiesOnly=yes");
		}
		if (this.target.knownHostsFile !== undefined) {
			// Pins host-key trust to an explicit store. StrictHostKeyChecking is left
			// at the user's configured value — a pinned store is a stricter trust
			// decision, never an excuse to stop verifying host keys.
			this.baseArgs.push("-o", `UserKnownHostsFile=${this.target.knownHostsFile}`);
		}
	}

	get host(): string {
		return this.target.host;
	}

	private sshArgs(script: string, independent = false): string[] {
		const transport = independent
			? ["-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no"]
			: [];
		return [...transport, ...this.baseArgs, this.target.host, "/bin/sh", "-c", shellQuote(script)];
	}

	protected prepare(argv: readonly string[], options: ExecOptions): PreparedCommand {
		const cwd = options.cwd ?? this.target.cwd;
		const environment = Object.entries(options.env ?? {}).map(([name, value]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
				throw new ToolFailure(`Invalid environment variable name: ${name}`);
			return `${name}=${value}`;
		});
		const command = (environment.length ? ["env", ...environment, ...argv] : argv).map(shellQuote).join(" ");
		// Managed process groups and PTYs use Executor's authenticated supervisor,
		// not remote PID markers. This is only the transport for an argv.
		return {
			spec: {
				file: "ssh",
				args: this.sshArgs(
					`cd ${shellQuote(cwd)} || exit 127; exec ${command}`,
					options.independentTransport,
				),
			},
		};
	}

	protected async locate(name: string, signal?: AbortSignal): Promise<string | null> {
		const result = await this.exec(["/bin/sh", "-c", 'command -v "$1" 2>/dev/null || exit 1', "sh", name], {
			signal,
			timeoutMs: 20_000,
		});
		const first = result.stdout.split("\n")[0]?.trim();
		return result.code === 0 && first ? first : null;
	}

	private async resolveCacheDirectory(signal?: AbortSignal): Promise<string> {
		const result = await this.exec(["/bin/sh", "-c", `printf %s ${REMOTE_CACHE_EXPR}`], {
			signal,
			timeoutMs: 30_000,
		});
		if (result.code !== 0) {
			const reason = result.stderr.trim() || result.spawnError || `ssh exited with ${result.code}`;
			throw new ToolFailure(`Cannot reach ${this.target.host} over SSH: ${reason}`);
		}
		const directory = result.stdout.trim();
		if (!directory.startsWith("/")) {
			throw new ToolFailure(`Unexpected remote cache path on ${this.target.host}: ${directory || "(empty)"}`);
		}
		return directory;
	}

	/**
	 * Absolute path of the installed helper. Installation is content-addressed and
	 * happens at most once per session; a target that already has this exact
	 * version costs a single `test -r`.
	 */
	helperPath(signal?: AbortSignal): Promise<string> {
		this.helperInstall ??= this.installHelper(signal).catch((error: unknown) => {
			this.helperInstall = undefined;
			throw error;
		});
		return this.helperInstall;
	}

	private async installHelper(signal?: AbortSignal): Promise<string> {
		this.cacheDirectory ??= this.resolveCacheDirectory(signal).catch((error: unknown) => {
			this.cacheDirectory = undefined;
			throw error;
		});
		const directory = await this.cacheDirectory;
		const path = `${directory}/${REMOTE_HELPER_FILENAME}`;
		const probe = await this.exec(["/bin/sh", "-c", 'test -r "$1"', "sh", path], {
			signal,
			timeoutMs: 30_000,
		});
		if (probe.code === 0) return path;
		const install = await this.exec(
			[
				"/bin/sh",
				"-c",
				'set -e; mkdir -p "$(dirname "$1")"; t="$1.tmp.$$"; cat > "$t"; chmod 700 "$t"; mv -f "$t" "$1"',
				"sh",
				path,
			],
			{ signal, stdin: REMOTE_HELPER_SOURCE, timeoutMs: 60_000 },
		);
		if (install.code !== 0) {
			const reason = install.stderr.trim() || install.spawnError || `exit ${install.code}`;
			throw new ToolFailure(
				`Failed to install the salam helper at ${path} on ${this.target.host}: ${reason}`,
			);
		}
		return path;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const { promise, resolve } = Promise.withResolvers<void>();
		const exit = spawn("ssh", [...this.baseArgs, "-O", "exit", this.target.host], { stdio: "ignore" });
		exit.on("error", () => resolve());
		exit.on("close", () => resolve());
		const guard = setTimeout(resolve, 3000);
		guard.unref?.();
		await promise;
		clearTimeout(guard);
	}
}
