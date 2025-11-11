import { a as normalizeBody, i as isBodyless, n as transformHeader, o as streamToBuffer, r as createTarPacker$1, t as createTarUnpacker } from "../unpacker-BD-PHhbh.js";

//#region src/web/compression.ts
function createGzipEncoder() {
	return new CompressionStream("gzip");
}
function createGzipDecoder() {
	return new DecompressionStream("gzip");
}

//#endregion
//#region src/web/pack.ts
function createTarPacker() {
	let streamController;
	let packer;
	return {
		readable: new ReadableStream({ start(controller) {
			streamController = controller;
			packer = createTarPacker$1(controller.enqueue.bind(controller), controller.error.bind(controller), controller.close.bind(controller));
		} }),
		controller: {
			add(header) {
				const bodyless = isBodyless(header);
				const h = { ...header };
				if (bodyless) h.size = 0;
				packer.add(h);
				if (bodyless) packer.endEntry();
				return new WritableStream({
					write(chunk) {
						packer.write(chunk);
					},
					close() {
						if (!bodyless) packer.endEntry();
					},
					abort(reason) {
						streamController.error(reason);
					}
				});
			},
			finalize() {
				packer.finalize();
			},
			error(err) {
				streamController.error(err);
			}
		}
	};
}

//#endregion
//#region src/web/unpack.ts
function createTarDecoder(options = {}) {
	let unpacker;
	let streamController = null;
	return new TransformStream({
		start(controller) {
			const closeCurrentBody = (err) => {
				if (streamController) {
					try {
						if (err) streamController.error(err);
						else streamController.close();
					} catch {}
					streamController = null;
				}
			};
			unpacker = createTarUnpacker({
				onHeader(header) {
					closeCurrentBody();
					const body = new ReadableStream({ start: (c) => streamController = c });
					controller.enqueue({
						header,
						body
					});
					if (header.size === 0) closeCurrentBody();
				},
				onData(chunk) {
					try {
						streamController?.enqueue(chunk);
					} catch {}
				},
				onEndEntry: () => closeCurrentBody(),
				onError(error) {
					closeCurrentBody(error);
					controller.error(error);
				}
			}, options);
		},
		transform(chunk, controller) {
			try {
				unpacker.write(chunk);
			} catch (e) {
				controller.error(e);
			}
		},
		flush(controller) {
			try {
				unpacker.end();
			} catch (e) {
				controller.error(e);
			}
		}
	});
}

//#endregion
//#region src/web/helpers.ts
async function packTar(entries) {
	const { readable, controller } = createTarPacker();
	await (async () => {
		for (const entry of entries) {
			const entryStream = controller.add(entry.header);
			const body = "body" in entry ? entry.body : entry.data;
			if (!body) {
				await entryStream.close();
				continue;
			}
			if (body instanceof ReadableStream) await body.pipeTo(entryStream);
			else if (body instanceof Blob) await body.stream().pipeTo(entryStream);
			else try {
				const chunk = await normalizeBody(body);
				if (chunk.length > 0) {
					const writer = entryStream.getWriter();
					await writer.write(chunk);
					await writer.close();
				} else await entryStream.close();
			} catch {
				throw new TypeError(`Unsupported content type for entry "${entry.header.name}".`);
			}
		}
	})().then(() => controller.finalize()).catch((err) => controller.error(err));
	return new Uint8Array(await streamToBuffer(readable));
}
async function unpackTar(archive, options = {}) {
	const { streamTimeout = 5e3,...restOptions } = options;
	const sourceStream = archive instanceof ReadableStream ? archive : new ReadableStream({ start(controller) {
		controller.enqueue(archive instanceof Uint8Array ? archive : new Uint8Array(archive));
		controller.close();
	} });
	const results = [];
	const processingPromise = (async () => {
		const reader = sourceStream.pipeThrough(createTarDecoder(restOptions)).getReader();
		let lastBodyStream = null;
		try {
			while (true) {
				const { done, value: entry } = await reader.read();
				if (done) break;
				lastBodyStream = entry.body;
				let processedHeader;
				try {
					processedHeader = transformHeader(entry.header, restOptions);
				} catch (error) {
					await entry.body.cancel();
					throw error;
				}
				if (processedHeader === null) {
					await entry.body.cancel();
					continue;
				}
				if (isBodyless(processedHeader)) {
					await entry.body.cancel();
					results.push({
						header: processedHeader,
						data: void 0
					});
				} else results.push({
					header: processedHeader,
					data: await streamToBuffer(entry.body)
				});
				lastBodyStream = null;
			}
		} catch (error) {
			if (lastBodyStream) try {
				await lastBodyStream.cancel();
			} catch {}
			throw error;
		} finally {
			try {
				reader.releaseLock();
			} catch {}
		}
		return results;
	})();
	if (streamTimeout !== Infinity) {
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => {
				reject(/* @__PURE__ */ new Error(`Stream timed out after ${streamTimeout}ms of inactivity.`));
			}, streamTimeout);
		});
		return Promise.race([processingPromise, timeoutPromise]);
	}
	return processingPromise;
}

//#endregion
export { createGzipDecoder, createGzipEncoder, createTarDecoder, createTarPacker, packTar, unpackTar };