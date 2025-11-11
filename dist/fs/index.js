import { a as normalizeBody, n as transformHeader, r as createTarPacker, t as createTarUnpacker } from "../unpacker-BD-PHhbh.js";
import * as fs from "node:fs/promises";
import { cpus } from "node:os";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

//#region src/fs/path.ts
const unicodeCache = /* @__PURE__ */ new Map();
const normalizeUnicode = (s) => {
	let result = unicodeCache.get(s);
	if (result !== void 0) unicodeCache.delete(s);
	result = result ?? s.normalize("NFD");
	unicodeCache.set(s, result);
	if (unicodeCache.size > 1e4) unicodeCache.delete(unicodeCache.keys().next().value);
	return result;
};
function validateBounds(targetPath, destDir, errorMessage) {
	const target = normalizeUnicode(path.resolve(targetPath));
	const dest = path.resolve(destDir);
	if (target !== dest && !target.startsWith(dest + path.sep)) throw new Error(errorMessage);
}
const win32Reserved = {
	":": "",
	"<": "",
	">": "",
	"|": "",
	"?": "",
	"*": "",
	"\"": ""
};
function normalizeName(name) {
	const path$1 = name.replace(/\\/g, "/");
	if (path$1.split("/").includes("..") || /^[a-zA-Z]:\.\./.test(path$1)) throw new Error(`${name} points outside extraction directory`);
	let relative = path$1;
	if (/^[a-zA-Z]:/.test(relative)) relative = relative.replace(/^[a-zA-Z]:[/\\]?/, "");
	else if (relative.startsWith("/")) relative = relative.replace(/^\/+/, "");
	if (process.platform === "win32") return relative.replace(/[<>:"|?*]/g, (char) => win32Reserved[char]);
	return relative;
}
const normalizeHeaderName = (s) => normalizeUnicode(normalizeName(s.replace(/\/+$/, "")));

//#endregion
//#region src/fs/pack.ts
const packTarSources = packTar;
function packTar(sources, options = {}) {
	const stream = new Readable({ read() {} });
	(async () => {
		const packer = createTarPacker((chunk) => stream.push(Buffer.from(chunk)), stream.destroy.bind(stream), () => stream.push(null));
		const { dereference = false, filter, map, baseDir, concurrency = cpus().length || 8 } = options;
		const isDir = typeof sources === "string";
		const directoryPath = isDir ? path.resolve(sources) : null;
		const jobs = isDir ? (await fs.readdir(directoryPath, { withFileTypes: true })).map((entry) => ({
			type: entry.isDirectory() ? "directory" : "file",
			source: path.join(directoryPath, entry.name),
			target: entry.name
		})) : sources;
		const results = /* @__PURE__ */ new Map();
		const resolvers = /* @__PURE__ */ new Map();
		const seenInodes = /* @__PURE__ */ new Map();
		let jobIndex = 0;
		let writeIndex = 0;
		let activeWorkers = 0;
		let allJobsQueued = false;
		const writer = async () => {
			const readBufferSmall = Buffer.alloc(64 * 1024);
			let readBufferLarge = null;
			while (true) {
				if (stream.destroyed) return;
				if (allJobsQueued && writeIndex >= jobs.length) break;
				if (!results.has(writeIndex)) {
					await new Promise((resolve) => resolvers.set(writeIndex, resolve));
					continue;
				}
				const result = results.get(writeIndex);
				results.delete(writeIndex);
				resolvers.delete(writeIndex);
				if (!result) {
					writeIndex++;
					continue;
				}
				packer.add(result.header);
				if (result.body) if (result.body instanceof Uint8Array) {
					if (result.body.length > 0) packer.write(result.body);
				} else if (result.body instanceof Readable || result.body instanceof ReadableStream) try {
					for await (const chunk of result.body) {
						if (stream.destroyed) break;
						packer.write(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
					}
				} catch (error) {
					stream.destroy(error);
					return;
				}
				else {
					const { handle, size } = result.body;
					const readBuffer = size > 1048576 ? readBufferLarge ??= Buffer.alloc(512 * 1024) : readBufferSmall;
					try {
						let bytesLeft = size;
						while (bytesLeft > 0 && !stream.destroyed) {
							const toRead = Math.min(bytesLeft, readBuffer.length);
							const { bytesRead } = await handle.read(readBuffer, 0, toRead, null);
							if (bytesRead === 0) break;
							packer.write(readBuffer.subarray(0, bytesRead));
							bytesLeft -= bytesRead;
						}
					} catch (error) {
						stream.destroy(error);
						return;
					} finally {
						await handle.close();
					}
				}
				packer.endEntry();
				writeIndex++;
			}
		};
		const controller = () => {
			if (stream.destroyed || allJobsQueued) return;
			while (activeWorkers < concurrency && jobIndex < jobs.length) {
				activeWorkers++;
				const currentIndex = jobIndex++;
				processJob(jobs[currentIndex], currentIndex).catch(stream.destroy.bind(stream)).finally(() => {
					activeWorkers--;
					controller();
				});
			}
			if (activeWorkers === 0 && jobIndex >= jobs.length) {
				allJobsQueued = true;
				resolvers.get(writeIndex)?.();
			}
		};
		const processJob = async (job, index) => {
			let jobResult = null;
			const target = normalizeName(job.target);
			try {
				if (job.type === "content" || job.type === "stream") {
					let body$1;
					let size;
					const isDir$1 = target.endsWith("/");
					if (job.type === "stream") {
						if (typeof job.size !== "number" || !isDir$1 && job.size <= 0 || isDir$1 && job.size !== 0) throw new Error(isDir$1 ? "Streams for directories must have size 0." : "Streams require a positive size.");
						size = job.size;
						body$1 = job.content;
					} else {
						const content = await normalizeBody(job.content);
						size = content.length;
						body$1 = content;
					}
					const stat$1 = {
						size: isDir$1 ? 0 : size,
						isFile: () => !isDir$1,
						isDirectory: () => isDir$1,
						isSymbolicLink: () => false,
						mode: job.mode,
						mtime: job.mtime ?? /* @__PURE__ */ new Date(),
						uid: job.uid ?? 0,
						gid: job.gid ?? 0
					};
					if (filter && !filter(target, stat$1)) return;
					let header$1 = {
						name: target,
						type: isDir$1 ? "directory" : "file",
						size: isDir$1 ? 0 : size,
						mode: stat$1.mode,
						mtime: stat$1.mtime,
						uid: stat$1.uid,
						gid: stat$1.gid,
						uname: job.uname,
						gname: job.gname
					};
					if (map) header$1 = map(header$1);
					jobResult = {
						header: header$1,
						body: isDir$1 ? void 0 : body$1
					};
					return;
				}
				let stat = await fs.lstat(job.source, { bigint: true });
				if (dereference && stat.isSymbolicLink()) {
					const linkTarget = await fs.readlink(job.source);
					const resolved = path.resolve(path.dirname(job.source), linkTarget);
					const resolvedBase = baseDir ?? directoryPath ?? process.cwd();
					if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return;
					stat = await fs.stat(job.source, { bigint: true });
				}
				if (filter && !filter(target, stat)) return;
				let header = {
					name: target,
					size: 0,
					mode: job.mode ?? Number(stat.mode),
					mtime: job.mtime ?? stat.mtime,
					uid: job.uid ?? Number(stat.uid),
					gid: job.gid ?? Number(stat.gid),
					uname: job.uname,
					gname: job.gname,
					type: "file"
				};
				let body;
				if (stat.isDirectory()) {
					header.type = "directory";
					header.name = target.endsWith("/") ? target : `${target}/`;
					try {
						for (const d of await fs.readdir(job.source, { withFileTypes: true })) jobs.push({
							type: d.isDirectory() ? "directory" : "file",
							source: path.join(job.source, d.name),
							target: `${header.name}${d.name}`
						});
					} catch {}
				} else if (stat.isSymbolicLink()) {
					header.type = "symlink";
					header.linkname = await fs.readlink(job.source);
				} else if (stat.isFile()) {
					header.size = Number(stat.size);
					if (stat.nlink > 1 && seenInodes.has(stat.ino)) {
						header.type = "link";
						header.linkname = seenInodes.get(stat.ino);
						header.size = 0;
					} else {
						if (stat.nlink > 1) seenInodes.set(stat.ino, target);
						if (header.size > 0) if (header.size < 32 * 1024) body = await fs.readFile(job.source);
						else body = {
							handle: await fs.open(job.source, "r"),
							size: header.size
						};
					}
				} else return;
				if (map) header = map(header);
				jobResult = {
					header,
					body
				};
			} finally {
				results.set(index, jobResult);
				resolvers.get(index)?.();
			}
		};
		controller();
		await writer();
		if (!stream.destroyed) packer.finalize();
	})().catch((error) => stream.destroy(error));
	return stream;
}

//#endregion
//#region src/fs/unpack.ts
function unpackTar(directoryPath, options = {}) {
	const { streamTimeout = 5e3,...fsOptions } = options;
	let timeoutId = null;
	const { handler, signal } = createFSHandler(directoryPath, fsOptions);
	const unpacker = createTarUnpacker(handler, fsOptions);
	let stream;
	function resetTimeout() {
		if (timeoutId) clearTimeout(timeoutId);
		if (streamTimeout !== Infinity && streamTimeout > 0) timeoutId = setTimeout(() => {
			const err = /* @__PURE__ */ new Error(`Stream timed out after ${streamTimeout}ms of inactivity.`);
			stream.destroy(err);
		}, streamTimeout);
	}
	stream = new Writable({
		write(chunk, _, callback) {
			resetTimeout();
			if (signal.aborted) return callback(signal.reason);
			try {
				unpacker.write(chunk);
				callback();
			} catch (writeErr) {
				callback(writeErr);
			}
		},
		async final(callback) {
			if (timeoutId) clearTimeout(timeoutId);
			try {
				if (signal.aborted) return callback(signal.reason);
				unpacker.end();
				await handler.process();
				callback();
			} catch (finalErr) {
				callback(finalErr);
			}
		}
	});
	stream.on("close", () => {
		if (timeoutId) clearTimeout(timeoutId);
	});
	resetTimeout();
	return stream;
}
function createFSHandler(directoryPath, options) {
	const { maxDepth = 1024, dmode, fmode, concurrency = cpus().length || 8 } = options;
	const abortController = new AbortController();
	const { signal } = abortController;
	const opQueue = [];
	let activeOps = 0;
	const pathPromises = /* @__PURE__ */ new Map();
	let activeEntryStream = null;
	let processingEnded = false;
	let resolveDrain;
	const drainPromise = new Promise((resolve) => {
		resolveDrain = resolve;
	});
	const processQueue = () => {
		if (signal.aborted) opQueue.length = 0;
		while (activeOps < concurrency && opQueue.length > 0) {
			activeOps++;
			const op = opQueue.shift();
			if (!op) break;
			op();
		}
		if (processingEnded && activeOps === 0 && opQueue.length === 0) resolveDrain();
	};
	const destDirPromise = (async () => {
		const symbolic = normalizeUnicode(path.resolve(directoryPath));
		await fs.mkdir(symbolic, { recursive: true });
		try {
			return {
				symbolic,
				real: await fs.realpath(symbolic)
			};
		} catch (err) {
			if (signal.aborted) throw signal.reason;
			throw err;
		}
	})();
	destDirPromise.catch((err) => {
		if (!signal.aborted) abortController.abort(err);
	});
	const ensureDirectoryExists = (dirPath) => {
		let promise = pathPromises.get(dirPath);
		if (promise) return promise;
		promise = (async () => {
			if (signal.aborted) throw signal.reason;
			const destDir = await destDirPromise;
			if (dirPath === destDir.symbolic) return "directory";
			await ensureDirectoryExists(path.dirname(dirPath));
			if (signal.aborted) throw signal.reason;
			try {
				const stat = await fs.lstat(dirPath);
				if (stat.isDirectory()) return "directory";
				if (stat.isSymbolicLink()) {
					const realPath = await fs.realpath(dirPath);
					validateBounds(realPath, destDir.real, `Symlink "${dirPath}" points outside the extraction directory.`);
					if ((await fs.stat(realPath)).isDirectory()) return "directory";
				}
				throw new Error(`"${dirPath}" is not a valid directory component.`);
			} catch (err) {
				if (err.code === "ENOENT") {
					await fs.mkdir(dirPath, { mode: dmode });
					return "directory";
				}
				throw err;
			}
		})();
		pathPromises.set(dirPath, promise);
		return promise;
	};
	return {
		handler: {
			onHeader(header) {
				if (signal.aborted) return;
				activeEntryStream = new PassThrough({ highWaterMark: header.size > 1048576 ? 524288 : void 0 });
				const entryStream = activeEntryStream;
				const startOperation = () => {
					let opPromise;
					try {
						const transformed = transformHeader(header, options);
						if (!transformed) {
							entryStream.resume();
							activeOps--;
							processQueue();
							return;
						}
						const name = normalizeHeaderName(transformed.name);
						const target = path.join(path.resolve(directoryPath), name);
						opPromise = (pathPromises.get(target) || Promise.resolve(void 0)).then(async (priorOp) => {
							if (signal.aborted) throw signal.reason;
							if (priorOp) {
								if (priorOp === "directory" && transformed.type !== "directory" || priorOp !== "directory" && transformed.type === "directory") throw new Error(`Path conflict ${transformed.type} over existing ${priorOp} at "${transformed.name}"`);
							}
							try {
								const destDir = await destDirPromise;
								if (maxDepth !== Infinity && name.split("/").length > maxDepth) throw new Error("Tar exceeds max specified depth.");
								const outPath = path.join(destDir.symbolic, name);
								validateBounds(outPath, destDir.symbolic, `Entry "${transformed.name}" points outside the extraction directory.`);
								const parentDir = path.dirname(outPath);
								await ensureDirectoryExists(parentDir);
								switch (transformed.type) {
									case "directory":
										await fs.mkdir(outPath, {
											recursive: true,
											mode: dmode ?? transformed.mode
										});
										break;
									case "file":
										await pipeline(entryStream, createWriteStream(outPath, {
											mode: fmode ?? transformed.mode,
											highWaterMark: transformed.size > 1048576 ? 524288 : void 0
										}));
										break;
									case "symlink": {
										const { linkname } = transformed;
										if (!linkname) return transformed.type;
										validateBounds(path.resolve(parentDir, linkname), destDir.symbolic, `Symlink "${linkname}" points outside the extraction directory.`);
										await fs.symlink(linkname, outPath);
										break;
									}
									case "link": {
										const { linkname } = transformed;
										if (!linkname) return transformed.type;
										const normalizedLink = normalizeUnicode(linkname);
										if (path.isAbsolute(normalizedLink)) throw new Error(`Hardlink "${linkname}" points outside the extraction directory.`);
										const linkTarget = path.join(destDir.symbolic, normalizedLink);
										validateBounds(linkTarget, destDir.symbolic, `Hardlink "${linkname}" points outside the extraction directory.`);
										await ensureDirectoryExists(path.dirname(linkTarget));
										const realTargetParent = await fs.realpath(path.dirname(linkTarget));
										validateBounds(path.join(realTargetParent, path.basename(linkTarget)), destDir.real, `Hardlink "${linkname}" points outside the extraction directory.`);
										if (linkTarget === outPath) return transformed.type;
										const targetPromise = pathPromises.get(linkTarget);
										if (targetPromise) await targetPromise;
										await fs.link(linkTarget, outPath);
										break;
									}
									default: return transformed.type;
								}
								if (transformed.mtime) await (transformed.type === "symlink" ? fs.lutimes : fs.utimes)(outPath, transformed.mtime, transformed.mtime).catch(() => {});
								return transformed.type;
							} finally {
								if (!entryStream.readableEnded) entryStream.resume();
							}
						});
						pathPromises.set(target, opPromise);
					} catch (err) {
						opPromise = Promise.reject(err);
						abortController.abort(err);
					}
					opPromise.catch((err) => abortController.abort(err)).finally(() => {
						activeOps--;
						processQueue();
					});
				};
				opQueue.push(startOperation);
				processQueue();
			},
			onData(chunk) {
				if (!signal.aborted) activeEntryStream?.write(chunk);
			},
			onEndEntry() {
				activeEntryStream?.end();
				activeEntryStream = null;
			},
			onError(error) {
				abortController.abort(error);
			},
			async process() {
				processingEnded = true;
				processQueue();
				await drainPromise;
				if (signal.aborted) throw signal.reason;
			}
		},
		signal
	};
}

//#endregion
export { packTar, packTarSources, unpackTar };