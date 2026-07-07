/**
 * Mastra {@link WorkspaceFilesystem} implementations for Databricks Apps.
 *
 * {@link DatabricksWorkspaceFilesystem} maps a Mastra workspace namespace onto
 * an absolute Databricks path (Unity Catalog volume, workspace object tree, or
 * DBFS). {@link emptyFilesystem} is a read-only no-op mount used when no
 * dynamic mounts resolve for a request.
 *
 * Path helpers ({@link normalizeDatabricksBasePath}, {@link isDbfsPath}, …)
 * are exported for tests and callers that need to reason about Databricks
 * paths without constructing a filesystem.
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { apiUtils, commonUtils, logUtils } from "@dbx-tools/shared";
import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  FilesystemInfo,
  ListOptions,
  ReadOptions,
  RemoveOptions,
  WriteOptions,
} from "@mastra/core/workspace";
import {
  DirectoryNotEmptyError,
  DirectoryNotFoundError,
  FileExistsError,
  FileNotFoundError,
  IsDirectoryError,
  MastraFilesystem,
  NotDirectoryError,
  PermissionError,
  WorkspaceReadOnlyError,
  type MastraFilesystemOptions,
} from "@mastra/core/workspace";
import type { ProviderStatus } from "@mastra/core/workspace";
import { posix as path } from "node:path";
import { randomUUID } from "node:crypto";
import { getExecutionContext } from "@databricks/appkit";

/* ------------------------------ constants ------------------------------ */

const DBFS_READ_CHUNK_BYTES = 1024 * 1024;
const DBFS_PUT_MAX_BYTES = 1024 * 1024;
const EMPTY_FILESYSTEM_EPOCH = new Date(0);

/** Mastra error constructor for a known SDK filesystem failure, if any. */
function filesystemSdkErrorType(
  err: unknown,
): (new (path: string) => Error) | undefined {
  if (err) {
    const ctx = apiUtils.errorContext(err);
    if (ctx.notAccessible) {
      return FileNotFoundError;
    } else if (ctx.hasMessage("already", "exists")) {
      return FileExistsError;
    } else if (ctx.hasMessage("not", "directory")) {
      return NotDirectoryError;
    } else if (ctx.hasMessage("not", "file")) {
      return IsDirectoryError;
    }
  }
  return undefined;
}

const log = logUtils.logger("mastra/filesystems");

/** How {@link DatabricksWorkspaceFilesystem.init} handles a missing {@link basePath}. */
export type DatabricksMkdirsMode = boolean | "try";

/** Options for {@link DatabricksWorkspaceFilesystem}. */
export interface DatabricksWorkspaceFilesystemOptions extends MastraFilesystemOptions {
  /** Unique identifier for this filesystem instance. */
  id?: string;
  /** Auth-scoped Databricks workspace client. */
  client?: WorkspaceClient;
  /**
   * Absolute Databricks path that roots the workspace namespace, e.g.
   * `/Volumes/catalog/schema/volume` or `/dbfs/FileStore/shared`.
   */
  basePath: string;
  /**
   * When the {@link basePath} is missing at {@link init}, create it with the
   * matching Databricks `mkdirs` API. `"try"` (default) logs at debug and
   * falls back to an empty read-only namespace on failure; `true` fails init;
   * `false` skips creation and uses the empty namespace.
   *
   * A successful mkdir also satisfies the write-access probe when
   * {@link readOnly} is omitted.
   */
  mkdirs?: DatabricksMkdirsMode;
  /** Block writes while still allowing reads. When omitted, {@link init} probes write access. */
  readOnly?: boolean;
}

/* ------------------------- exported path helpers ------------------------- */

/** Normalize a Databricks base path (POSIX, no trailing slash). */
export function normalizeDatabricksBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error(`Databricks base path must be absolute: ${basePath}`);
  }
  return trimmed.replace(/\/+$/, "") || "/";
}

/** True when `absolutePath` is served by DBFS rather than the UC Files API. */
export function isDbfsPath(absolutePath: string): boolean {
  return absolutePath === "/dbfs" || absolutePath.startsWith("/dbfs/");
}

/** True when `absolutePath` is a Databricks workspace object path. */
export function isWorkspaceFilesPath(absolutePath: string): boolean {
  return (
    absolutePath === "/Workspace" ||
    absolutePath.startsWith("/Workspace/") ||
    absolutePath.startsWith("/Users/") ||
    absolutePath.startsWith("/Repos/")
  );
}

type FilesBackend = "dbfs" | "workspace" | "uc-files";

/** Per-backend async handler used by {@link dispatchFilesBackend}. */
type FilesBackendHandlers<T = unknown> = {
  dbfs: () => Promise<T>;
  workspace: () => Promise<T>;
  ucFiles: () => Promise<T>;
};

/**
 * Resolve a workspace-relative path to an absolute Databricks path under
 * `basePath`.
 */
export function resolveDatabricksAbsolutePath(
  basePath: string,
  inputPath: string,
): string {
  const root = normalizeDatabricksBasePath(basePath);
  const trimmed = inputPath.trim();
  if (!trimmed || trimmed === "/") return root;
  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (normalized === root || normalized.startsWith(`${root}/`)) {
    return path.normalize(normalized);
  }
  return path.normalize(path.join(root, normalized));
}

/** Map an absolute Databricks path back to the workspace namespace. */
export function toDatabricksWorkspacePath(
  basePath: string,
  absolutePath: string,
): string {
  const root = normalizeDatabricksBasePath(basePath);
  const normalized = path.normalize(absolutePath);
  if (normalized === root) return "/";
  if (normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length) || "/";
  }
  return normalized;
}

/* ---------------------------- private helpers ---------------------------- */

/** Pick the Databricks Files API backend for an absolute path. */
function resolveFilesBackend(absolutePath: string): FilesBackend {
  if (isDbfsPath(absolutePath)) return "dbfs";
  if (isWorkspaceFilesPath(absolutePath)) return "workspace";
  return "uc-files";
}

/** Run the handler that matches `absolutePath`'s Databricks backend. */
async function dispatchFilesBackend<T>(
  absolutePath: string,
  handlers: FilesBackendHandlers<T>,
): Promise<T> {
  const backend = resolveFilesBackend(absolutePath);
  if (backend === "dbfs") return handlers.dbfs();
  if (backend === "workspace") return handlers.workspace();
  return handlers.ucFiles();
}

/** Return `buffer` as a string when `encoding` is set, otherwise unchanged. */
function formatReadResult(buffer: Buffer, encoding?: BufferEncoding): string | Buffer {
  return encoding ? buffer.toString(encoding) : buffer;
}

/** Drain a fetch `ReadableStream` into a single `Buffer`. */
async function readResponseBody(
  contents: globalThis.ReadableStream<Uint8Array> | undefined,
): Promise<Buffer> {
  if (!contents) return Buffer.alloc(0);
  const reader = contents.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/** Coerce Mastra {@link FileContent} to a `Buffer`. */
function toBuffer(content: FileContent): Buffer {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  return Buffer.from(content);
}

/** Decode a DBFS read payload from base64. */
function decodeDbfsPayload(data: string | undefined): Buffer {
  if (!data) return Buffer.alloc(0);
  return Buffer.from(data, "base64");
}

/** Wrap a `Buffer` as a one-shot `ReadableStream` for UC file uploads. */
function bufferToReadableStream(buffer: Buffer): globalThis.ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

/** Parse an HTTP date header; returns epoch when missing or invalid. */
function parseHttpDate(value: string | undefined): Date {
  if (!value) return new Date(0);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : new Date(0);
}

/* ---------------- DatabricksWorkspaceFilesystem ---------------- */

/**
 * Mastra filesystem provider that reads and writes through a Databricks
 * {@link WorkspaceClient}.
 *
 * Workspace paths are absolute within the namespace (`/notes.md` maps to
 * `<basePath>/notes.md`). Unity Catalog volumes use the Files API;
 * `/dbfs/...` paths use DBFS.
 */
export class DatabricksWorkspaceFilesystem extends MastraFilesystem {
  readonly id: string;
  readonly name = "DatabricksWorkspaceFilesystem";
  readonly provider = "databricks";
  readonly basePath: string;
  status: ProviderStatus = "pending";

  private readonly client: WorkspaceClient;
  private readonly mkdirs: DatabricksMkdirsMode;
  private _readOnly: boolean | undefined;
  private _basePathMissing: boolean | undefined;

  get readOnly(): boolean | undefined {
    return this._readOnly;
  }

  /**
   * @param options.client - Defaults to the AppKit execution-context client.
   * @param options.mkdirs - Default `"try"`; see {@link DatabricksMkdirsMode}.
   * @param options.readOnly - When omitted, {@link init} probes write access.
   */
  constructor(options: DatabricksWorkspaceFilesystemOptions) {
    super({ name: "DatabricksWorkspaceFilesystem", ...options });
    this.id = options.id ?? `databricks-fs-${commonUtils.fnvHash(options.basePath)}`;
    this.client = options.client ?? getExecutionContext().client;
    this.basePath = normalizeDatabricksBasePath(options.basePath);
    this.mkdirs = options.mkdirs ?? "try";
    this._readOnly = options.readOnly;
  }

  /* --- path resolution --- */

  /** Resolve and sandbox a workspace-relative path under {@link basePath}. */
  private resolvePath(inputPath: string): string {
    const resolved = resolveDatabricksAbsolutePath(this.basePath, inputPath);
    if (resolved !== this.basePath && !resolved.startsWith(`${this.basePath}/`)) {
      throw new PermissionError(inputPath, "access");
    }
    return resolved;
  }

  /** Map a Databricks absolute path back to the workspace namespace. */
  private workspacePath(absolutePath: string): string {
    return toDatabricksWorkspacePath(this.basePath, absolutePath);
  }

  /** Throw when the filesystem is read-only. */
  private assertWritable(operation: string): void {
    if (this.readOnly) {
      throw new WorkspaceReadOnlyError(operation);
    }
  }

  /** Map SDK / HTTP errors to Mastra workspace filesystem errors. */
  private rethrow(err: unknown, inputPath: string): never {
    const workspacePath = inputPath.startsWith("/")
      ? inputPath
      : this.workspacePath(this.resolvePath(inputPath));
    const ErrorType = filesystemSdkErrorType(err);
    if (ErrorType) {
      throw new ErrorType(workspacePath);
    }
    const message = commonUtils.errorMessage(err);
    throw new Error(`Databricks filesystem ${workspacePath}: ${message}`);
  }

  /* --- lifecycle --- */

  /**
   * Probe whether {@link basePath} exists and cache the result on
   * {@link _basePathMissing}.
   */
  private async resolveBasePathStatus(): Promise<void> {
    if (this._basePathMissing !== undefined) return;
    try {
      await this.assertAbsoluteReadable(this.basePath);
      this._basePathMissing = false;
    } catch (err) {
      if (apiUtils.errorContext(err).notAccessible) {
        this._basePathMissing = true;
        return;
      }
      this.rethrow(err, "/");
    }
  }

  /** Delegate to {@link emptyFilesystem} when the base path is missing. */
  private async emptyFallback(): Promise<
    ReturnType<typeof emptyFilesystem> | undefined
  > {
    await this.resolveBasePathStatus();
    return this._basePathMissing ? emptyFilesystem() : undefined;
  }

  override async init(): Promise<void> {
    await this.resolveBasePathStatus();

    if (this._basePathMissing) {
      if (this.mkdirs === false) {
        return;
      }
      try {
        await this.mkdirAbsolute(this.basePath);
        this._basePathMissing = false;
        if (this._readOnly === undefined) {
          this._readOnly = false;
        }
      } catch (err) {
        if (this.mkdirs === true) {
          this.rethrow(err, "/");
        }
        log.debug("mkdirs:try-failed", {
          basePath: this.basePath,
          error: commonUtils.errorMessage(err),
        });
      }
      return;
    }

    if (this._readOnly === undefined) {
      await this.probeReadOnly();
    }
  }

  /**
   * Write and delete a ephemeral probe file to detect read-only access when
   * {@link DatabricksWorkspaceFilesystemOptions.readOnly} was not set.
   *
   * @returns `true` when the probe write (and cleanup) succeeded.
   */
  private async probeReadOnly(): Promise<boolean> {
    const absolutePath = this.resolvePath(`/.__dbx_fs_probe_${commonUtils.id()}`);
    try {
      await this.writeAbsolute(absolutePath, Buffer.from("probe\n"), true);
      this._readOnly = false;
    } catch {
      this._readOnly = true;
      return false;
    }
    try {
      await this.deleteAbsoluteFile(absolutePath);
    } catch {
      // Writable; leave a hidden probe file rather than failing init.
    }
    return true;
  }

  override async destroy(): Promise<void> {
    // Remote filesystem; nothing to tear down locally.
  }

  /* --- backend I/O --- */

  /** Probe that `absolutePath` exists (file or directory metadata). */
  private async assertAbsoluteReadable(absolutePath: string): Promise<void> {
    await dispatchFilesBackend(absolutePath, {
      dbfs: () => this.client.dbfs.getStatus({ path: absolutePath }),
      workspace: () => this.client.workspace.getStatus({ path: absolutePath }),
      ucFiles: () =>
        this.client.files.getDirectoryMetadata({ directory_path: absolutePath }),
    });
  }

  /** Read the full contents of `absolutePath` from the matching backend. */
  private async readAbsolute(absolutePath: string): Promise<Buffer> {
    return dispatchFilesBackend(absolutePath, {
      dbfs: () => this.readDbfsFile(absolutePath),
      workspace: () => this.readWorkspaceFile(absolutePath),
      ucFiles: async () => {
        const response = await this.client.files.download({ file_path: absolutePath });
        return readResponseBody(
          response.contents as globalThis.ReadableStream<Uint8Array> | undefined,
        );
      },
    });
  }

  /** Write `buffer` to `absolutePath` on the matching backend. */
  private async writeAbsolute(
    absolutePath: string,
    buffer: Buffer,
    overwrite: boolean,
  ): Promise<void> {
    await dispatchFilesBackend(absolutePath, {
      dbfs: () => this.writeDbfsFile(absolutePath, buffer, overwrite),
      workspace: () => this.writeWorkspaceFile(absolutePath, buffer, overwrite),
      ucFiles: () => this.uploadUcFile(absolutePath, buffer, overwrite),
    });
  }

  /** Upload a buffer to a Unity Catalog Files API path. */
  private uploadUcFile(
    absolutePath: string,
    buffer: Buffer,
    overwrite: boolean,
  ): Promise<unknown> {
    return this.client.files.upload({
      file_path: absolutePath,
      contents: bufferToReadableStream(buffer) as never,
      overwrite,
    });
  }

  /** Delete a single file at `absolutePath` (non-recursive). */
  private async deleteAbsoluteFile(absolutePath: string): Promise<void> {
    await dispatchFilesBackend(absolutePath, {
      dbfs: () => this.client.dbfs.delete({ path: absolutePath, recursive: false }),
      workspace: () =>
        this.client.workspace.delete({ path: absolutePath, recursive: false }),
      ucFiles: () => this.client.files.delete({ file_path: absolutePath }),
    });
  }

  /**
   * Delete a file or directory at `absolutePath`.
   *
   * DBFS and workspace APIs accept `recursive`; UC volumes recurse manually.
   */
  private async deleteAbsolutePath(
    absolutePath: string,
    recursive: boolean,
  ): Promise<void> {
    await dispatchFilesBackend(absolutePath, {
      dbfs: async () => {
        await this.client.dbfs.delete({ path: absolutePath, recursive });
      },
      workspace: async () => {
        await this.client.workspace.delete({ path: absolutePath, recursive });
      },
      ucFiles: async () => {
        if (recursive) {
          await this.deleteUcDirectoryRecursive(absolutePath);
          return;
        }
        const children = await this.listAbsoluteDirectory(absolutePath);
        if (children.length > 0) {
          throw new DirectoryNotEmptyError(this.workspacePath(absolutePath));
        }
        await this.client.files.deleteDirectory({ directory_path: absolutePath });
      },
    });
  }

  /** Create `absolutePath` and any missing parents on the matching backend. */
  private async mkdirAbsolute(absolutePath: string): Promise<void> {
    await dispatchFilesBackend(absolutePath, {
      dbfs: () => this.client.dbfs.mkdirs({ path: absolutePath }),
      workspace: () => this.client.workspace.mkdirs({ path: absolutePath }),
      ucFiles: () =>
        this.client.files.createDirectory({ directory_path: absolutePath }),
    });
  }

  private async readDbfsFile(absolutePath: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (true) {
      const response = await this.client.dbfs.read({
        path: absolutePath,
        offset,
        length: DBFS_READ_CHUNK_BYTES,
      });
      const chunk = decodeDbfsPayload(response.data);
      if (chunk.length === 0) break;
      chunks.push(chunk);
      offset += chunk.length;
      if (chunk.length < DBFS_READ_CHUNK_BYTES) break;
    }
    return Buffer.concat(chunks);
  }

  private async readWorkspaceFile(absolutePath: string): Promise<Buffer> {
    const response = await this.client.workspace.export({
      path: absolutePath,
      format: "AUTO",
    });
    return decodeDbfsPayload(response.content);
  }

  private async writeDbfsFile(
    absolutePath: string,
    buffer: Buffer,
    overwrite: boolean,
  ): Promise<void> {
    if (buffer.length <= DBFS_PUT_MAX_BYTES) {
      await this.client.dbfs.put({
        path: absolutePath,
        contents: buffer.toString("base64"),
        overwrite,
      });
      return;
    }
    const created = await this.client.dbfs.create({ path: absolutePath, overwrite });
    const handle = created.handle;
    if (handle === undefined) {
      throw new Error(`DBFS create did not return a handle for ${absolutePath}`);
    }
    for (let offset = 0; offset < buffer.length; offset += DBFS_PUT_MAX_BYTES) {
      const slice = buffer.subarray(offset, offset + DBFS_PUT_MAX_BYTES);
      await this.client.dbfs.addBlock({
        handle,
        data: slice.toString("base64"),
      });
    }
    await this.client.dbfs.close({ handle });
  }

  private async writeWorkspaceFile(
    absolutePath: string,
    buffer: Buffer,
    overwrite: boolean,
  ): Promise<void> {
    await this.client.workspace.import({
      path: absolutePath,
      format: "AUTO",
      content: buffer.toString("base64"),
      overwrite,
    });
  }

  /* --- MastraFilesystem API --- */

  getInfo(): FilesystemInfo<{ basePath: string }> {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      readOnly: this.readOnly,
      metadata: { basePath: this.basePath },
    };
  }

  getInstructions(): string {
    return [
      `Files live in Databricks under ${this.basePath}.`,
      "Workspace paths are absolute within this root (for example `/notes/report.md`).",
      "Workspace paths use `/Workspace/...`, `/Users/...`, or `/Repos/...` base paths.",
      "Unity Catalog volumes use `/Volumes/<catalog>/<schema>/<volume>/...` base paths.",
    ].join(" ");
  }

  /** Map a workspace-relative path to the backing Databricks absolute path. */
  resolveAbsolutePath(inputPath: string): string | undefined {
    return this.resolvePath(inputPath);
  }

  /** Read file contents from the workspace namespace. */
  async readFile(inputPath: string, options?: ReadOptions): Promise<string | Buffer> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.readFile(inputPath, options);
    const absolutePath = this.resolvePath(inputPath);
    try {
      const buffer = await this.readAbsolute(absolutePath);
      return formatReadResult(buffer, options?.encoding);
    } catch (err) {
      this.rethrow(err, inputPath);
    }
  }

  /** Write file contents into the workspace namespace. */
  async writeFile(
    inputPath: string,
    content: FileContent,
    options?: WriteOptions,
  ): Promise<void> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.writeFile(inputPath, content, options);
    this.assertWritable("writeFile");
    const absolutePath = this.resolvePath(inputPath);
    const buffer = toBuffer(content);
    const overwrite = options?.overwrite ?? true;
    try {
      if (!overwrite && (await this.exists(inputPath))) {
        throw new FileExistsError(inputPath);
      }
      await this.writeAbsolute(absolutePath, buffer, overwrite);
    } catch (err) {
      if (err instanceof FileExistsError) throw err;
      this.rethrow(err, inputPath);
    }
  }

  /** Append to an existing file, creating it when missing. */
  async appendFile(inputPath: string, content: FileContent): Promise<void> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.appendFile(inputPath, content);
    this.assertWritable("appendFile");
    const existing = (await this.exists(inputPath))
      ? await this.readFile(inputPath)
      : Buffer.alloc(0);
    const merged = Buffer.concat([
      Buffer.isBuffer(existing) ? existing : Buffer.from(existing, "utf8"),
      toBuffer(content),
    ]);
    await this.writeFile(inputPath, merged, { overwrite: true });
  }

  /** Delete a file in the workspace namespace. */
  async deleteFile(inputPath: string, options?: RemoveOptions): Promise<void> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.deleteFile(inputPath, options);
    this.assertWritable("deleteFile");
    const absolutePath = this.resolvePath(inputPath);
    try {
      if (!(await this.exists(inputPath))) {
        if (options?.force) return;
        throw new FileNotFoundError(inputPath);
      }
      const entry = await this.stat(inputPath);
      if (entry.type === "directory") {
        throw new IsDirectoryError(inputPath);
      }
      await this.deleteAbsoluteFile(absolutePath);
    } catch (err) {
      if (err instanceof FileNotFoundError || err instanceof IsDirectoryError)
        throw err;
      this.rethrow(err, inputPath);
    }
  }

  /** Copy a file within the workspace namespace. */
  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.copyFile(src, dest, options);
    this.assertWritable("copyFile");
    const overwrite = options?.overwrite ?? true;
    if (!overwrite && (await this.exists(dest))) {
      throw new FileExistsError(dest);
    }
    const content = await this.readFile(src);
    await this.writeFile(dest, content, { overwrite: true });
  }

  /** Move or rename a file within the workspace namespace. */
  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.moveFile(src, dest, options);
    this.assertWritable("moveFile");
    const srcAbsolute = this.resolvePath(src);
    const destAbsolute = this.resolvePath(dest);
    const overwrite = options?.overwrite ?? true;
    try {
      if (!overwrite && (await this.exists(dest))) {
        throw new FileExistsError(dest);
      }
      if (
        resolveFilesBackend(srcAbsolute) === "dbfs" &&
        resolveFilesBackend(destAbsolute) === "dbfs"
      ) {
        await this.client.dbfs.move({
          source_path: srcAbsolute,
          destination_path: destAbsolute,
        });
        return;
      }
      await this.copyFile(src, dest, { overwrite: true });
      await this.deleteFile(src, { force: true });
    } catch (err) {
      if (err instanceof FileExistsError) throw err;
      this.rethrow(err, dest);
    }
  }

  /** Create a directory in the workspace namespace. */
  async mkdir(inputPath: string, options?: { recursive?: boolean }): Promise<void> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.mkdir(inputPath, options);
    this.assertWritable("mkdir");
    const absolutePath = this.resolvePath(inputPath);
    try {
      await this.mkdirAbsolute(absolutePath);
      if (!options?.recursive) {
        return;
      }
    } catch (err) {
      this.rethrow(err, inputPath);
    }
  }

  /** Remove a directory from the workspace namespace. */
  async rmdir(inputPath: string, options?: RemoveOptions): Promise<void> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.rmdir(inputPath, options);
    this.assertWritable("rmdir");
    const absolutePath = this.resolvePath(inputPath);
    try {
      if (!(await this.exists(inputPath))) {
        if (options?.force) return;
        throw new DirectoryNotFoundError(inputPath);
      }
      const entry = await this.stat(inputPath);
      if (entry.type !== "directory") {
        throw new NotDirectoryError(inputPath);
      }
      await this.deleteAbsolutePath(absolutePath, options?.recursive ?? false);
    } catch (err) {
      if (
        err instanceof DirectoryNotFoundError ||
        err instanceof NotDirectoryError ||
        err instanceof DirectoryNotEmptyError
      ) {
        throw err;
      }
      this.rethrow(err, inputPath);
    }
  }

  /**
   * Recursively delete a Unity Catalog directory tree.
   *
   * DBFS and workspace trees use native recursive delete via
   * {@link deleteAbsolutePath} instead.
   */
  private async deleteUcDirectoryRecursive(absolutePath: string): Promise<void> {
    for (const child of await this.listAbsoluteDirectory(absolutePath)) {
      const childAbsolute = path.join(absolutePath, child.name);
      if (child.type === "directory") {
        await this.deleteUcDirectoryRecursive(childAbsolute);
      } else {
        await this.deleteAbsoluteFile(childAbsolute);
      }
    }
    await this.client.files.deleteDirectory({ directory_path: absolutePath });
  }

  /* --- directory listing --- */

  /** List entries in a workspace directory. */
  async readdir(inputPath: string, options?: ListOptions): Promise<FileEntry[]> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.readdir(inputPath, options);
    const absolutePath = this.resolvePath(inputPath);
    try {
      const entries = await this.listAbsoluteDirectory(absolutePath);
      const filtered = this.filterEntries(entries, options);
      if (!options?.recursive) return filtered;
      return this.readDirectoryRecursive(absolutePath, options, 0);
    } catch (err) {
      this.rethrow(err, inputPath);
    }
  }

  private async readDirectoryRecursive(
    absolutePath: string,
    options: ListOptions,
    depth: number,
    relativePrefix = "",
  ): Promise<FileEntry[]> {
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    const entries = this.filterEntries(
      await this.listAbsoluteDirectory(absolutePath),
      options,
    );
    const collected: FileEntry[] = [];
    for (const entry of entries) {
      const relativeName = relativePrefix
        ? path.join(relativePrefix, entry.name)
        : entry.name;
      collected.push({ ...entry, name: relativeName });
      if (entry.type !== "directory" || depth >= maxDepth) continue;
      collected.push(
        ...(await this.readDirectoryRecursive(
          path.join(absolutePath, entry.name),
          options,
          depth + 1,
          relativeName,
        )),
      );
    }
    return collected;
  }

  private async listAbsoluteDirectory(absolutePath: string): Promise<FileEntry[]> {
    return dispatchFilesBackend(absolutePath, {
      dbfs: async () => {
        const entries: FileEntry[] = [];
        for await (const info of this.client.dbfs.list({ path: absolutePath })) {
          entries.push({
            name: path.basename(info.path ?? ""),
            type: info.is_dir ? "directory" : "file",
            size: info.file_size,
          });
        }
        return entries;
      },
      workspace: async () => {
        const entries: FileEntry[] = [];
        for await (const info of this.client.workspace.list({ path: absolutePath })) {
          entries.push({
            name: path.basename(info.path ?? ""),
            type: info.object_type === "DIRECTORY" ? "directory" : "file",
          });
        }
        return entries;
      },
      ucFiles: async () => {
        const entries: FileEntry[] = [];
        for await (const entry of this.client.files.listDirectoryContents({
          directory_path: absolutePath,
        })) {
          entries.push({
            name: entry.name ?? path.basename(entry.path ?? ""),
            type: entry.is_directory ? "directory" : "file",
            size: entry.file_size,
          });
        }
        return entries;
      },
    });
  }

  /** Apply Mastra list filters (`extension`, etc.) to directory entries. */
  private filterEntries(entries: FileEntry[], options?: ListOptions): FileEntry[] {
    if (!options?.extension) return entries;
    const extensions = Array.isArray(options.extension)
      ? options.extension
      : [options.extension];
    const normalized = extensions.map((ext) =>
      ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
    );
    return entries.filter((entry) => {
      if (entry.type !== "file") return true;
      const lower = entry.name.toLowerCase();
      return normalized.some((ext) => lower.endsWith(ext));
    });
  }

  /* --- metadata --- */

  /** Return whether `inputPath` exists in the workspace namespace. */
  async exists(inputPath: string): Promise<boolean> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.exists(inputPath);
    try {
      await this.stat(inputPath);
      return true;
    } catch (err) {
      if (err instanceof FileNotFoundError) return false;
      throw err;
    }
  }

  /** Return file or directory metadata for `inputPath`. */
  async stat(inputPath: string): Promise<FileStat> {
    await this.ensureReady();
    const empty = await this.emptyFallback();
    if (empty) return empty.stat(inputPath);
    const absolutePath = this.resolvePath(inputPath);
    const workspacePath = this.workspacePath(absolutePath);
    try {
      return await dispatchFilesBackend(absolutePath, {
        dbfs: async () => {
          const info = await this.client.dbfs.getStatus({ path: absolutePath });
          return {
            name: path.basename(info.path ?? absolutePath),
            path: workspacePath,
            type: info.is_dir ? ("directory" as const) : ("file" as const),
            size: info.file_size ?? 0,
            createdAt: new Date(info.modification_time ?? 0),
            modifiedAt: new Date(info.modification_time ?? 0),
          };
        },
        workspace: async () => {
          const info = await this.client.workspace.getStatus({ path: absolutePath });
          return {
            name: path.basename(info.path ?? absolutePath),
            path: workspacePath,
            type:
              info.object_type === "DIRECTORY"
                ? ("directory" as const)
                : ("file" as const),
            size: 0,
            createdAt: new Date(info.created_at ?? 0),
            modifiedAt: new Date(info.modified_at ?? 0),
          };
        },
        ucFiles: () => this.statUcAbsolute(absolutePath, workspacePath, inputPath),
      });
    } catch (err) {
      this.rethrow(err, inputPath);
    }
  }

  /**
   * Stat a Unity Catalog path by probing file metadata first, then
   * directory metadata.
   */
  private async statUcAbsolute(
    absolutePath: string,
    workspacePath: string,
    inputPath: string,
  ): Promise<FileStat> {
    try {
      const metadata = await this.client.files.getMetadata({
        file_path: absolutePath,
      });
      return {
        name: path.basename(absolutePath),
        path: workspacePath,
        type: "file" as const,
        size: Number(metadata["content-length"] ?? 0),
        createdAt: parseHttpDate(metadata["last-modified"]),
        modifiedAt: parseHttpDate(metadata["last-modified"]),
        mimeType: metadata["content-type"],
      };
    } catch (fileErr) {
      if (!apiUtils.errorContext(fileErr).notAccessible) {
        this.rethrow(fileErr, inputPath);
      }
      await this.client.files.getDirectoryMetadata({
        directory_path: absolutePath,
      });
      return {
        name: path.basename(absolutePath),
        path: workspacePath,
        type: "directory" as const,
        size: 0,
        createdAt: new Date(0),
        modifiedAt: new Date(0),
      };
    }
  }
}

/* --------------------------- empty filesystem --------------------------- */

/** Normalize paths for the in-memory empty filesystem namespace. */
function normalizeEmptyFilesystemPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed || trimmed === ".") return "/";
  const normalized = trimmed.startsWith("/")
    ? path.normalize(trimmed)
    : path.normalize(`/${trimmed}`);
  return normalized === "." ? "/" : normalized;
}

/**
 * Read-only in-memory {@link WorkspaceFilesystem} with a single empty root.
 * Use {@link emptyFilesystem} rather than constructing directly.
 */
class EmptyFilesystem extends MastraFilesystem {
  readonly id = "empty-fs";
  readonly name = "EmptyFilesystem";
  readonly provider = "empty";
  readonly readOnly = true;
  status: ProviderStatus = "pending";

  constructor() {
    super({ name: "EmptyFilesystem" });
  }

  override async init(): Promise<void> {
    // No remote or on-disk resources to provision.
  }

  override async destroy(): Promise<void> {
    // Stateless; nothing to release.
  }

  getInfo(): FilesystemInfo {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      readOnly: this.readOnly,
    };
  }

  getInstructions(): string {
    return "This filesystem is empty and read-only.";
  }

  private rootStat(): FileStat {
    return {
      name: "/",
      path: "/",
      type: "directory",
      size: 0,
      createdAt: EMPTY_FILESYSTEM_EPOCH,
      modifiedAt: EMPTY_FILESYSTEM_EPOCH,
    };
  }

  private assertWritable(operation: string): void {
    throw new WorkspaceReadOnlyError(operation);
  }

  override async readFile(
    inputPath: string,
    _options?: ReadOptions,
  ): Promise<string | Buffer> {
    await this.ensureReady();
    const normalized = normalizeEmptyFilesystemPath(inputPath);
    if (normalized === "/") {
      throw new IsDirectoryError(normalized);
    }
    throw new FileNotFoundError(normalized);
  }

  override async writeFile(
    _inputPath: string,
    _content: FileContent,
    _options?: WriteOptions,
  ): Promise<void> {
    await this.ensureReady();
    this.assertWritable("writeFile");
  }

  override async appendFile(_inputPath: string, _content: FileContent): Promise<void> {
    await this.ensureReady();
    this.assertWritable("appendFile");
  }

  override async deleteFile(inputPath: string, options?: RemoveOptions): Promise<void> {
    await this.ensureReady();
    const normalized = normalizeEmptyFilesystemPath(inputPath);
    if (normalized === "/") {
      throw new IsDirectoryError(normalized);
    }
    if (options?.force) return;
    throw new FileNotFoundError(normalized);
  }

  override async copyFile(
    src: string,
    _dest: string,
    _options?: CopyOptions,
  ): Promise<void> {
    await this.ensureReady();
    const normalizedSrc = normalizeEmptyFilesystemPath(src);
    if (normalizedSrc !== "/") {
      throw new FileNotFoundError(normalizedSrc);
    }
    throw new IsDirectoryError(normalizedSrc);
  }

  override async moveFile(
    src: string,
    dest: string,
    options?: CopyOptions,
  ): Promise<void> {
    await this.copyFile(src, dest, options);
  }

  override async mkdir(
    _inputPath: string,
    _options?: { recursive?: boolean },
  ): Promise<void> {
    await this.ensureReady();
    this.assertWritable("mkdir");
  }

  override async rmdir(inputPath: string, options?: RemoveOptions): Promise<void> {
    await this.ensureReady();
    const normalized = normalizeEmptyFilesystemPath(inputPath);
    if (normalized === "/") {
      throw new DirectoryNotEmptyError(normalized);
    }
    if (options?.force) return;
    throw new DirectoryNotFoundError(normalized);
  }

  override async readdir(
    inputPath: string,
    _options?: ListOptions,
  ): Promise<FileEntry[]> {
    await this.ensureReady();
    const normalized = normalizeEmptyFilesystemPath(inputPath);
    if (normalized === "/") return [];
    throw new DirectoryNotFoundError(normalized);
  }

  override async exists(inputPath: string): Promise<boolean> {
    await this.ensureReady();
    return normalizeEmptyFilesystemPath(inputPath) === "/";
  }

  override async stat(inputPath: string): Promise<FileStat> {
    await this.ensureReady();
    const normalized = normalizeEmptyFilesystemPath(inputPath);
    if (normalized === "/") return this.rootStat();
    throw new FileNotFoundError(normalized);
  }
}

/** Memoized singleton empty read-only filesystem for no-op mounts. */
export const emptyFilesystem = commonUtils.memoize(() => new EmptyFilesystem());
