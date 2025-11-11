//#region src/tar/constants.ts
const BLOCK_SIZE = 512;
const BLOCK_SIZE_MASK = 511;
const DEFAULT_FILE_MODE = 420;
const DEFAULT_DIR_MODE = 493;
const USTAR_NAME_OFFSET = 0;
const USTAR_NAME_SIZE = 100;
const USTAR_MODE_OFFSET = 100;
const USTAR_MODE_SIZE = 8;
const USTAR_UID_OFFSET = 108;
const USTAR_UID_SIZE = 8;
const USTAR_GID_OFFSET = 116;
const USTAR_GID_SIZE = 8;
const USTAR_SIZE_OFFSET = 124;
const USTAR_SIZE_SIZE = 12;
const USTAR_MTIME_OFFSET = 136;
const USTAR_MTIME_SIZE = 12;
const USTAR_CHECKSUM_OFFSET = 148;
const USTAR_CHECKSUM_SIZE = 8;
const USTAR_TYPEFLAG_OFFSET = 156;
const USTAR_TYPEFLAG_SIZE = 1;
const USTAR_LINKNAME_OFFSET = 157;
const USTAR_LINKNAME_SIZE = 100;
const USTAR_MAGIC_OFFSET = 257;
const USTAR_MAGIC_SIZE = 6;
const USTAR_VERSION_OFFSET = 263;
const USTAR_VERSION_SIZE = 2;
const USTAR_UNAME_OFFSET = 265;
const USTAR_UNAME_SIZE = 32;
const USTAR_GNAME_OFFSET = 297;
const USTAR_GNAME_SIZE = 32;
const USTAR_PREFIX_OFFSET = 345;
const USTAR_PREFIX_SIZE = 155;
const USTAR_VERSION = "00";
const USTAR_MAX_UID_GID = 2097151;
const USTAR_MAX_SIZE = 8589934591;
const TYPEFLAG = {
	file: "0",
	link: "1",
	symlink: "2",
	"character-device": "3",
	"block-device": "4",
	directory: "5",
	fifo: "6",
	"pax-header": "x",
	"pax-global-header": "g",
	"gnu-long-name": "L",
	"gnu-long-link-name": "K"
};
const FLAGTYPE = {
	"0": "file",
	"1": "link",
	"2": "symlink",
	"3": "character-device",
	"4": "block-device",
	"5": "directory",
	"6": "fifo",
	x: "pax-header",
	g: "pax-global-header",
	L: "gnu-long-name",
	K: "gnu-long-link-name"
};
const ZERO_BLOCK = new Uint8Array(BLOCK_SIZE);

//#endregion
//#region src/tar/utils.ts
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function writeString(view, offset, size, value) {
	if (value) encoder.encodeInto(value, view.subarray(offset, offset + size));
}
function writeOctal(view, offset, size, value) {
	if (value === void 0) return;
	const octalString = value.toString(8).padStart(size - 1, "0");
	encoder.encodeInto(octalString, view.subarray(offset, offset + size - 1));
}
function readString(view, offset, size) {
	const end = view.indexOf(0, offset);
	const sliceEnd = end === -1 || end > offset + size ? offset + size : end;
	return decoder.decode(view.subarray(offset, sliceEnd));
}
function readOctal(view, offset, size) {
	let value = 0;
	const end = offset + size;
	for (let i = offset; i < end; i++) {
		const charCode = view[i];
		if (charCode === 0) break;
		if (charCode === 32) continue;
		value = (value << 3) + (charCode - 48);
	}
	return value;
}
function readNumeric(view, offset, size) {
	if (view[offset] & 128) {
		let result = 0;
		result = view[offset] & 127;
		for (let i = 1; i < size; i++) result = result * 256 + view[offset + i];
		if (!Number.isSafeInteger(result)) throw new Error("TAR number too large");
		return result;
	}
	return readOctal(view, offset, size);
}
async function streamToBuffer(stream) {
	const chunks = [];
	const reader = stream.getReader();
	let totalLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalLength += value.length;
		}
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	} finally {
		reader.releaseLock();
	}
}
async function normalizeBody(body) {
	if (body === null || body === void 0) return new Uint8Array(0);
	if (body instanceof Uint8Array) return body;
	if (typeof body === "string") return encoder.encode(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
	throw new TypeError("Unsupported content type for entry body.");
}
const isBodyless = (header) => header.type === "directory" || header.type === "symlink" || header.type === "link";

//#endregion
//#region src/tar/checksum.ts
const CHECKSUM_SPACE = 32;
const ASCII_ZERO = 48;
function validateChecksum(block) {
	const stored = readOctal(block, USTAR_CHECKSUM_OFFSET, USTAR_CHECKSUM_SIZE);
	let sum = 0;
	for (let i = 0; i < block.length; i++) if (i >= USTAR_CHECKSUM_OFFSET && i < USTAR_CHECKSUM_OFFSET + USTAR_CHECKSUM_SIZE) sum += CHECKSUM_SPACE;
	else sum += block[i];
	return stored === sum;
}
function writeChecksum(block) {
	block.fill(CHECKSUM_SPACE, USTAR_CHECKSUM_OFFSET, USTAR_CHECKSUM_OFFSET + USTAR_CHECKSUM_SIZE);
	let checksum = 0;
	for (const byte of block) checksum += byte;
	for (let i = USTAR_CHECKSUM_OFFSET + 6 - 1; i >= USTAR_CHECKSUM_OFFSET; i--) {
		block[i] = (checksum & 7) + ASCII_ZERO;
		checksum >>= 3;
	}
	block[USTAR_CHECKSUM_OFFSET + 6] = 0;
	block[USTAR_CHECKSUM_OFFSET + 7] = CHECKSUM_SPACE;
}

//#endregion
//#region src/tar/pax.ts
function generatePax(header) {
	const paxRecords = {};
	if (header.name.length > USTAR_NAME_SIZE) {
		if (findUstarSplit(header.name) === null) paxRecords.path = header.name;
	}
	if (header.linkname && header.linkname.length > USTAR_NAME_SIZE) paxRecords.linkpath = header.linkname;
	if (header.uname && header.uname.length > USTAR_UNAME_SIZE) paxRecords.uname = header.uname;
	if (header.gname && header.gname.length > USTAR_GNAME_SIZE) paxRecords.gname = header.gname;
	if (header.uid != null && header.uid > USTAR_MAX_UID_GID) paxRecords.uid = String(header.uid);
	if (header.gid != null && header.gid > USTAR_MAX_UID_GID) paxRecords.gid = String(header.gid);
	if (header.size != null && header.size > USTAR_MAX_SIZE) paxRecords.size = String(header.size);
	if (header.pax) Object.assign(paxRecords, header.pax);
	const paxEntries = Object.entries(paxRecords);
	if (paxEntries.length === 0) return null;
	const paxBody = encoder.encode(paxEntries.map(([key, value]) => {
		const record = `${key}=${value}\n`;
		const partLength = encoder.encode(record).length + 1;
		let totalLength = partLength + String(partLength).length;
		totalLength = partLength + String(totalLength).length;
		return `${totalLength} ${record}`;
	}).join(""));
	return {
		paxHeader: createTarHeader({
			name: decoder.decode(encoder.encode(`PaxHeader/${header.name}`).slice(0, 100)),
			size: paxBody.length,
			type: "pax-header",
			mode: 420,
			mtime: header.mtime,
			uname: header.uname,
			gname: header.gname,
			uid: header.uid,
			gid: header.gid
		}),
		paxBody
	};
}
function findUstarSplit(path) {
	if (path.length <= USTAR_NAME_SIZE) return null;
	const minSlashIndex = path.length - USTAR_NAME_SIZE - 1;
	const slashIndex = path.lastIndexOf("/", USTAR_PREFIX_SIZE);
	if (slashIndex > 0 && slashIndex >= minSlashIndex) return {
		prefix: path.slice(0, slashIndex),
		name: path.slice(slashIndex + 1)
	};
	return null;
}

//#endregion
//#region src/tar/header.ts
function createTarHeader(header) {
	const view = new Uint8Array(BLOCK_SIZE);
	const size = header.type === "directory" || header.type === "symlink" || header.type === "link" ? 0 : header.size ?? 0;
	let name = header.name;
	let prefix = "";
	if (!header.pax?.path) {
		const split = findUstarSplit(name);
		if (split) {
			name = split.name;
			prefix = split.prefix;
		}
	}
	writeString(view, USTAR_NAME_OFFSET, USTAR_NAME_SIZE, name);
	writeOctal(view, USTAR_MODE_OFFSET, USTAR_MODE_SIZE, header.mode ?? (header.type === "directory" ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE));
	writeOctal(view, USTAR_UID_OFFSET, USTAR_UID_SIZE, header.uid ?? 0);
	writeOctal(view, USTAR_GID_OFFSET, USTAR_GID_SIZE, header.gid ?? 0);
	writeOctal(view, USTAR_SIZE_OFFSET, USTAR_SIZE_SIZE, size);
	writeOctal(view, USTAR_MTIME_OFFSET, USTAR_MTIME_SIZE, Math.floor((header.mtime?.getTime() ?? Date.now()) / 1e3));
	writeString(view, USTAR_TYPEFLAG_OFFSET, USTAR_TYPEFLAG_SIZE, TYPEFLAG[header.type ?? "file"]);
	writeString(view, USTAR_LINKNAME_OFFSET, USTAR_LINKNAME_SIZE, header.linkname);
	writeString(view, USTAR_MAGIC_OFFSET, USTAR_MAGIC_SIZE, "ustar\0");
	writeString(view, USTAR_VERSION_OFFSET, USTAR_VERSION_SIZE, USTAR_VERSION);
	writeString(view, USTAR_UNAME_OFFSET, USTAR_UNAME_SIZE, header.uname);
	writeString(view, USTAR_GNAME_OFFSET, USTAR_GNAME_SIZE, header.gname);
	writeString(view, USTAR_PREFIX_OFFSET, USTAR_PREFIX_SIZE, prefix);
	writeChecksum(view);
	return view;
}
function parseUstarHeader(block, strict) {
	if (strict && !validateChecksum(block)) throw new Error("Invalid tar header checksum.");
	const typeflag = readString(block, USTAR_TYPEFLAG_OFFSET, USTAR_TYPEFLAG_SIZE);
	const header = {
		name: readString(block, USTAR_NAME_OFFSET, USTAR_NAME_SIZE),
		mode: readOctal(block, USTAR_MODE_OFFSET, USTAR_MODE_SIZE),
		uid: readNumeric(block, USTAR_UID_OFFSET, USTAR_UID_SIZE),
		gid: readNumeric(block, USTAR_GID_OFFSET, USTAR_GID_SIZE),
		size: readNumeric(block, USTAR_SIZE_OFFSET, USTAR_SIZE_SIZE),
		mtime: /* @__PURE__ */ new Date(readNumeric(block, USTAR_MTIME_OFFSET, USTAR_MTIME_SIZE) * 1e3),
		type: FLAGTYPE[typeflag] || "file",
		linkname: readString(block, USTAR_LINKNAME_OFFSET, USTAR_LINKNAME_SIZE)
	};
	const magic = readString(block, USTAR_MAGIC_OFFSET, USTAR_MAGIC_SIZE);
	if (magic.trim() === "ustar") {
		header.uname = readString(block, USTAR_UNAME_OFFSET, USTAR_UNAME_SIZE);
		header.gname = readString(block, USTAR_GNAME_OFFSET, USTAR_GNAME_SIZE);
	}
	if (magic === "ustar") header.prefix = readString(block, USTAR_PREFIX_OFFSET, USTAR_PREFIX_SIZE);
	return header;
}
const PAX_MAPPING = {
	path: ["name", (v) => v],
	linkpath: ["linkname", (v) => v],
	size: ["size", (v) => parseInt(v, 10)],
	mtime: ["mtime", parseFloat],
	uid: ["uid", (v) => parseInt(v, 10)],
	gid: ["gid", (v) => parseInt(v, 10)],
	uname: ["uname", (v) => v],
	gname: ["gname", (v) => v]
};
function parsePax(buffer) {
	const decoder$1 = new TextDecoder("utf-8");
	const overrides = {};
	const pax = {};
	let offset = 0;
	while (offset < buffer.length) {
		const spaceIndex = buffer.indexOf(32, offset);
		if (spaceIndex === -1) break;
		const length = parseInt(decoder$1.decode(buffer.subarray(offset, spaceIndex)), 10);
		if (Number.isNaN(length) || length === 0) break;
		const recordEnd = offset + length;
		const [key, value] = decoder$1.decode(buffer.subarray(spaceIndex + 1, recordEnd - 1)).split("=", 2);
		if (key && value !== void 0) {
			pax[key] = value;
			const mapping = PAX_MAPPING[key];
			if (mapping) {
				const [targetKey, parser] = mapping;
				const parsedValue = parser(value);
				if (typeof parsedValue === "string" || !Number.isNaN(parsedValue)) overrides[targetKey] = parsedValue;
			}
		}
		offset = recordEnd;
	}
	if (Object.keys(pax).length > 0) overrides.pax = pax;
	return overrides;
}
function applyOverrides(header, overrides) {
	if (overrides.name !== void 0) header.name = overrides.name;
	if (overrides.linkname !== void 0) header.linkname = overrides.linkname;
	if (overrides.size !== void 0) header.size = overrides.size;
	if (overrides.mtime !== void 0) header.mtime = /* @__PURE__ */ new Date(overrides.mtime * 1e3);
	if (overrides.uid !== void 0) header.uid = overrides.uid;
	if (overrides.gid !== void 0) header.gid = overrides.gid;
	if (overrides.uname !== void 0) header.uname = overrides.uname;
	if (overrides.gname !== void 0) header.gname = overrides.gname;
	if (overrides.pax) header.pax = Object.assign({}, header.pax ?? {}, overrides.pax);
}
function getMetaParser(type) {
	switch (type) {
		case "pax-global-header":
		case "pax-header": return parsePax;
		case "gnu-long-name": return (data) => ({ name: readString(data, 0, data.length) });
		case "gnu-long-link-name": return (data) => ({ linkname: readString(data, 0, data.length) });
		default: return;
	}
}
function getHeaderBlocks(header) {
	const base = createTarHeader(header);
	const pax = generatePax(header);
	if (!pax) return [base];
	const paxPadding = -pax.paxBody.length & BLOCK_SIZE_MASK;
	const paddingBlocks = paxPadding > 0 ? [ZERO_BLOCK.subarray(0, paxPadding)] : [];
	return [
		pax.paxHeader,
		pax.paxBody,
		...paddingBlocks,
		base
	];
}

//#endregion
//#region src/tar/packer.ts
const EOF_BUFFER = new Uint8Array(BLOCK_SIZE * 2);
function createTarPacker(onData, onError, onFinalize) {
	let currentHeader = null;
	let bytesWritten = 0;
	let finalized = false;
	return {
		add(header) {
			if (finalized) {
				const error = /* @__PURE__ */ new Error("No new tar entries after finalize.");
				onError(error);
				throw error;
			}
			if (currentHeader !== null) {
				const error = /* @__PURE__ */ new Error("Previous entry must be completed before adding a new one");
				onError(error);
				throw error;
			}
			try {
				const size = header.type === "directory" || header.type === "symlink" || header.type === "link" ? 0 : header.size ?? 0;
				const headerBlocks = getHeaderBlocks({
					...header,
					size
				});
				for (const block of headerBlocks) onData(block);
				currentHeader = {
					...header,
					size
				};
				bytesWritten = 0;
			} catch (error) {
				onError(error);
			}
		},
		write(chunk) {
			if (!currentHeader) {
				const error = /* @__PURE__ */ new Error("No active tar entry.");
				onError(error);
				throw error;
			}
			if (finalized) {
				const error = /* @__PURE__ */ new Error("Cannot write data after finalize.");
				onError(error);
				throw error;
			}
			const newTotal = bytesWritten + chunk.length;
			if (newTotal > currentHeader.size) {
				const error = /* @__PURE__ */ new Error(`"${currentHeader.name}" exceeds given size of ${currentHeader.size} bytes.`);
				onError(error);
				throw error;
			}
			try {
				bytesWritten = newTotal;
				onData(chunk);
			} catch (error) {
				onError(error);
			}
		},
		endEntry() {
			if (!currentHeader) {
				const error = /* @__PURE__ */ new Error("No active entry to end.");
				onError(error);
				throw error;
			}
			if (finalized) {
				const error = /* @__PURE__ */ new Error("Cannot end entry after finalize.");
				onError(error);
				throw error;
			}
			try {
				if (bytesWritten !== currentHeader.size) {
					const error = /* @__PURE__ */ new Error(`Size mismatch for "${currentHeader.name}".`);
					onError(error);
					throw error;
				}
				const paddingSize = -currentHeader.size & BLOCK_SIZE_MASK;
				if (paddingSize > 0) onData(new Uint8Array(paddingSize));
				currentHeader = null;
				bytesWritten = 0;
			} catch (error) {
				onError(error);
				throw error;
			}
		},
		finalize() {
			if (finalized) {
				const error = /* @__PURE__ */ new Error("Archive has already been finalized");
				onError(error);
				throw error;
			}
			if (currentHeader !== null) {
				const error = /* @__PURE__ */ new Error("Cannot finalize while an entry is still active");
				onError(error);
				throw error;
			}
			try {
				onData(EOF_BUFFER);
				finalized = true;
				if (onFinalize) onFinalize();
			} catch (error) {
				onError(error);
			}
		}
	};
}

//#endregion
//#region src/tar/options.ts
function transformHeader(header, options) {
	const { strip, filter, map } = options;
	if (!strip && !filter && !map) return header;
	const h = { ...header };
	if (strip && strip > 0) {
		const components = h.name.split("/").filter(Boolean);
		if (strip >= components.length) return null;
		const newName = components.slice(strip).join("/");
		h.name = h.type === "directory" && !newName.endsWith("/") ? `${newName}/` : newName;
		if (h.linkname?.startsWith("/")) {
			const linkComponents = h.linkname.split("/").filter(Boolean);
			h.linkname = strip >= linkComponents.length ? "/" : `/${linkComponents.slice(strip).join("/")}`;
		}
	}
	if (filter?.(h) === false) return null;
	const result = map ? map(h) : h;
	if (result && (!result.name || !result.name.trim() || result.name === "." || result.name === "/")) return null;
	return result;
}

//#endregion
//#region src/tar/unpacker.ts
const STATE_HEADER = 0;
const STATE_BODY = 1;
const STATE_PADDING = 2;
const STATE_AWAIT_EOF = 3;
function createTarUnpacker(handler, options = {}) {
	const strict = options.strict ?? false;
	const chunkQueue = [];
	let totalAvailable = 0;
	let state = STATE_HEADER;
	let waitingForData = true;
	let currentEntry = null;
	const paxGlobals = {};
	let nextEntryOverrides = {};
	function consume(size, callback) {
		let remaining = Math.min(size, totalAvailable);
		const initialRemaining = remaining;
		while (remaining > 0 && chunkQueue.length > 0) {
			const chunkNode = chunkQueue[0];
			const available = chunkNode.data.length - chunkNode.consumed;
			const toProcess = Math.min(remaining, available);
			if (callback) callback(chunkNode.data.subarray(chunkNode.consumed, chunkNode.consumed + toProcess));
			chunkNode.consumed += toProcess;
			remaining -= toProcess;
			if (chunkNode.consumed >= chunkNode.data.length) chunkQueue.shift();
		}
		totalAvailable -= initialRemaining - remaining;
		return initialRemaining - remaining;
	}
	function read(size) {
		const toRead = Math.min(size, totalAvailable);
		if (toRead === 0) return null;
		const chunk = chunkQueue[0];
		if (chunk) {
			if (chunk.data.length - chunk.consumed >= toRead) {
				const result$1 = chunk.data.subarray(chunk.consumed, chunk.consumed + toRead);
				chunk.consumed += toRead;
				totalAvailable -= toRead;
				if (chunk.consumed >= chunk.data.length) chunkQueue.shift();
				return result$1;
			}
		}
		const result = new Uint8Array(toRead);
		let offset = 0;
		consume(toRead, (data) => {
			result.set(data, offset);
			offset += data.length;
		});
		return result;
	}
	function process() {
		while (true) switch (state) {
			case STATE_HEADER: {
				if (totalAvailable < BLOCK_SIZE) {
					waitingForData = true;
					return;
				}
				const headerBlock = read(BLOCK_SIZE);
				if (!headerBlock) {
					waitingForData = true;
					return;
				}
				if (isZeroBlock(headerBlock)) {
					state = STATE_AWAIT_EOF;
					continue;
				}
				waitingForData = false;
				try {
					const internalHeader = parseUstarHeader(headerBlock, strict);
					const header = {
						...internalHeader,
						name: internalHeader.name
					};
					const metaParser = getMetaParser(header.type);
					if (metaParser) {
						const paddedSize = header.size + BLOCK_SIZE_MASK & ~BLOCK_SIZE_MASK;
						if (totalAvailable < paddedSize) {
							waitingForData = true;
							chunkQueue.unshift({
								data: headerBlock,
								consumed: 0
							});
							totalAvailable += BLOCK_SIZE;
							return;
						}
						const metaBlock = read(paddedSize);
						if (!metaBlock) {
							waitingForData = true;
							return;
						}
						const overrides = metaParser(metaBlock.subarray(0, header.size));
						if (header.type === "pax-global-header") Object.assign(paxGlobals, overrides);
						else Object.assign(nextEntryOverrides, overrides);
						continue;
					}
					if (internalHeader.prefix) header.name = `${internalHeader.prefix}/${header.name}`;
					applyOverrides(header, paxGlobals);
					applyOverrides(header, nextEntryOverrides);
					nextEntryOverrides = {};
					handler.onHeader(header);
					if (header.size > 0) {
						currentEntry = {
							remaining: header.size,
							padding: -header.size & BLOCK_SIZE_MASK
						};
						state = STATE_BODY;
					} else handler.onEndEntry();
				} catch (error) {
					handler.onError(error);
					return;
				}
				continue;
			}
			case STATE_BODY: {
				if (!currentEntry) throw new Error("No current entry for body");
				const toForward = Math.min(currentEntry.remaining, totalAvailable);
				if (toForward > 0) {
					const consumed = consume(toForward, handler.onData);
					currentEntry.remaining -= consumed;
				}
				if (currentEntry.remaining === 0) {
					state = currentEntry.padding > 0 ? STATE_PADDING : STATE_HEADER;
					if (state === STATE_HEADER) {
						handler.onEndEntry();
						currentEntry = null;
					}
				} else if (totalAvailable === 0) {
					waitingForData = true;
					return;
				}
				continue;
			}
			case STATE_PADDING:
				if (!currentEntry) throw new Error("No current entry for padding");
				if (totalAvailable < currentEntry.padding) {
					waitingForData = true;
					return;
				}
				if (currentEntry.padding > 0) consume(currentEntry.padding);
				handler.onEndEntry();
				currentEntry = null;
				state = STATE_HEADER;
				continue;
			case STATE_AWAIT_EOF: {
				if (totalAvailable < BLOCK_SIZE) {
					waitingForData = true;
					return;
				}
				const secondBlock = read(BLOCK_SIZE);
				if (!secondBlock) {
					waitingForData = true;
					return;
				}
				if (isZeroBlock(secondBlock)) return;
				if (strict) {
					handler.onError(/* @__PURE__ */ new Error("Invalid EOF"));
					return;
				}
				chunkQueue.unshift({
					data: secondBlock,
					consumed: 0
				});
				totalAvailable += BLOCK_SIZE;
				state = STATE_HEADER;
				continue;
			}
			default: throw new Error("Invalid state in tar unpacker.");
		}
	}
	return {
		write(chunk) {
			if (chunk.length === 0) return;
			chunkQueue.push({
				data: chunk,
				consumed: 0
			});
			totalAvailable += chunk.length;
			if (waitingForData) {
				waitingForData = false;
				try {
					process();
				} catch (error) {
					handler.onError(error);
				}
			}
		},
		end() {
			try {
				if (!waitingForData) process();
				if (strict) {
					if (currentEntry && currentEntry.remaining > 0) {
						const error = /* @__PURE__ */ new Error("Tar archive is truncated.");
						handler.onError(error);
						throw error;
					}
					if (totalAvailable > 0) {
						if (read(totalAvailable)?.some((b) => b !== 0)) {
							const error = /* @__PURE__ */ new Error("Invalid EOF.");
							handler.onError(error);
							throw error;
						}
					}
					if (waitingForData) {
						const error = /* @__PURE__ */ new Error("Tar archive is truncated.");
						handler.onError(error);
						throw error;
					}
				} else if (currentEntry) {
					handler.onEndEntry();
					currentEntry = null;
				}
			} catch (error) {
				handler.onError(error);
			}
		}
	};
}
function isZeroBlock(block) {
	if (block.byteOffset % 8 === 0) {
		const view = new BigUint64Array(block.buffer, block.byteOffset, block.length / 8);
		for (let i = 0; i < view.length; i++) if (view[i] !== 0n) return false;
		return true;
	}
	for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
	return true;
}

//#endregion
export { normalizeBody as a, isBodyless as i, transformHeader as n, streamToBuffer as o, createTarPacker as r, createTarUnpacker as t };