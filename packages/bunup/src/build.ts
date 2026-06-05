import path from "node:path";
import { generateDts, logIsolatedDeclarationErrors } from "@bunup/dts";
import pc from "picocolors";
import { ensureMinimumBunVersion } from "./ensure-bun-version";
import {
	BunupBuildError,
	BunupDTSBuildError,
	formatBunBuildError,
	formatInvalidEntryPointsError,
	formatNoEntryPointsFoundError,
	parseErrorMessage,
} from "./errors";
import { getBundledDepsForDtsResolve } from "./helpers/external";
import { executeOnSuccess } from "./helpers/on-success";
import { loadPackageJson } from "./loaders";
import {
	type BuildOptions,
	DEFAULT_ENTYPOINTS,
	getCompileNaming,
	getDefaultChunkNaming,
	getResolvedDefine,
	getResolvedDtsSplitting,
	getResolvedEnv,
	getResolvedMinify,
	getResolvedSourcemap,
	getResolvedSplitting,
	getResolvedTarget,
	resolveBuildOptions,
	resolvePlugins,
} from "./options";
import type { BuildOutputFile, BuildResult } from "./plugins/types";
import {
	filterBunPlugins,
	filterBunupPlugins,
	runPluginBuildDoneHooks,
	runPluginBuildStartHooks,
} from "./plugins/utils";
import { logger } from "./printer/logger";
import { getOriginalEntrypointFromOutputPath } from "./utils/bun";
import { ensureArray } from "./utils/common";
import {
	getDefaultDtsOutputExtention,
	getDefaultJsOutputExtension,
	replaceExtension,
} from "./utils/extension";
import { cleanOutDir, getFilesFromGlobs, isJavascriptFile } from "./utils/file";
import { formatListWithAnd } from "./utils/format";
import { cleanPath } from "./utils/path";

export async function build(
	userOptions: Partial<BuildOptions>,
	rootDir: string = process.cwd(),
	ac?: AbortController,
): Promise<BuildResult> {
	ensureMinimumBunVersion();

	const localAc = ac ?? new AbortController();

	const options = resolveBuildOptions(userOptions);

	if (options.silent) {
		logger.setSilent(options.silent);
	}

	if (options.clean) {
		cleanOutDir(rootDir, options.outDir);
	}

	const packageJson = await loadPackageJson(rootDir);

	const packageType = packageJson.data?.type as string | undefined;

	const allPlugins = resolvePlugins(options, packageJson.data);

	const bunupPlugins = filterBunupPlugins(allPlugins);

	const bunPlugins = filterBunPlugins(allPlugins);

	await runPluginBuildStartHooks(bunupPlugins, { options });

	const entryArray = ensureArray(options.entry);

	const entrypoints = getFilesFromGlobs(entryArray, rootDir);

	if (!entrypoints.length) {
		if (!ensureArray(userOptions.entry).length) {
			throw new BunupBuildError(formatNoEntryPointsFoundError(DEFAULT_ENTYPOINTS));
		}
		throw new BunupBuildError(formatInvalidEntryPointsError(entryArray));
	}

	const buildOutputFiles: BuildOutputFile[] = [];

	if (!options.dtsOnly) {
		const absoluteEntrypoints = entrypoints.map((file) => `${rootDir}/${file}`);
		const resolvedDefine = getResolvedDefine(options.define, options.env);
		const resolvedMinify = getResolvedMinify(options);
		const resolvedTarget = getResolvedTarget(options.target);
		const resolvedSourcemap = getResolvedSourcemap(options.sourcemap);
		const resolvedEnv = getResolvedEnv(options.env);
		const chunkNaming = getDefaultChunkNaming(options.name);
		const absoluteOutDir = path.resolve(rootDir, options.outDir);
		const bunBuildOptions = {
			entrypoints: absoluteEntrypoints,
			splitting: undefined,
			define: resolvedDefine,
			minify: resolvedMinify,
			target: resolvedTarget,
			sourcemap: resolvedSourcemap,
			loader: options.loader,
			drop: options.drop,
			conditions: options.conditions,
			banner: options.banner,
			footer: options.footer,
			publicPath: options.publicPath,
			root: options.sourceBase ? path.resolve(rootDir, options.sourceBase) : undefined,
			env: resolvedEnv,
			ignoreDCEAnnotations: options.ignoreDCEAnnotations,
			emitDCEAnnotations: options.emitDCEAnnotations,
			jsx: options.jsx,
			compile: options.compile,
			throw: false,
			plugins: bunPlugins,
			tsconfig: options.preferredTsconfig ? path.resolve(rootDir, options.preferredTsconfig) : undefined,
			metafile: true,
		};

		const buildPromises = ensureArray(options.format).map(async (fmt) => {
			const entryNaming = options.compile
				? getCompileNaming(entryArray, options.compile, fmt)
				: `[dir]/[name]${getDefaultJsOutputExtension(fmt, packageType)}`;

			let result = await Bun.build({
				...bunBuildOptions,
				format: fmt,
				splitting: getResolvedSplitting(options.splitting, fmt),
				naming: {
					chunk: chunkNaming,
					entry: entryNaming,
				},
				outdir: absoluteOutDir,
			});

			let requiresManualWriting = false;
			// Bun applies entry naming to CSS assets, which can either rename CSS to JS extensions
			// or fail with this diagnostic when CSS is emitted beside a JS entry.
			const shouldFallbackToManualOutput =
				!options.compile &&
				(result.outputs.some((file) => file.type.startsWith("text/css")) ||
					result.logs.some(
						(log) =>
							log.level === "error" &&
							log.message.includes("Multiple files share the same output path"),
					));

			if (shouldFallbackToManualOutput) {
				result = await Bun.build({
					...bunBuildOptions,
					format: fmt,
					splitting: getResolvedSplitting(options.splitting, fmt),
					naming: {
						chunk: chunkNaming,
					},
				});
				requiresManualWriting = true;
			}

			for (const log of result.logs) {
				if (log.level === "error") {
					throw new BunupBuildError(formatBunBuildError(log));
				}
				if (log.level === "warning") logger.warn(log.message);
				if (log.level === "verbose") logger.log(log.message);
				else if (log.level === "info") logger.info(log.message);
			}

			for (const file of result.outputs) {
				if (options.compile) {
					const fullPath = file.path;

					const pathRelativeToRootDir = path.relative(rootDir, fullPath);

					const pathRelativeToOutdir = path.relative(absoluteOutDir, fullPath);

					buildOutputFiles.push({
						fullPath,
						pathRelativeToRootDir,
						pathRelativeToOutdir,
						dts: false,
						format: fmt,
						kind: "executable",
						entrypoint: entryArray[0],
						// using Bun.file instead of file.size because file.size is not giving the actual executable size
						size: Bun.file(fullPath).size,
					});

					continue;
				}

				const content = requiresManualWriting ? await file.text() : undefined;

				const pathRelativeToOutdir = requiresManualWriting
					? cleanPath(
							isJavascriptFile(file.path) && file.kind === "entry-point"
								? replaceExtension(file.path, getDefaultJsOutputExtension(fmt, packageType))
								: file.path,
						)
					: cleanPath(path.relative(absoluteOutDir, file.path));
				const pathRelativeToRootDir = cleanPath(path.join(options.outDir, pathRelativeToOutdir));

				const fullPath = path.resolve(rootDir, pathRelativeToRootDir);

				if (content !== undefined) {
					await Bun.write(fullPath, content);
				}

				if (!buildOutputFiles.some((f) => f.fullPath === fullPath)) {
					buildOutputFiles.push({
						fullPath,
						pathRelativeToRootDir,
						pathRelativeToOutdir,
						dts: false,
						format: fmt,
						kind: file.kind,
						entrypoint:
							file.kind === "entry-point"
								? cleanPath(
										getOriginalEntrypointFromOutputPath(result.metafile, file.path, rootDir),
									)
								: undefined,
						size: file.size,
					});
				}
			}
		});

		await Promise.all(buildPromises);
	}

	if (
		(options.dts || options.dtsOnly) &&
		// no need to generate dts when compile is provided
		!options.compile
	) {
		try {
			const {
				entry,
				splitting,
				resolve: userDtsResolve,
				...dtsOptions
			} = typeof options.dts === "object" ? options.dts : {};

			const bundledDeps = getBundledDepsForDtsResolve(options, packageJson.data);
			const dtsResolve =
				userDtsResolve === false
					? false
					: !bundledDeps?.length
						? userDtsResolve
						: userDtsResolve === true
							? true
							: [...bundledDeps, ...(Array.isArray(userDtsResolve) ? userDtsResolve : [])];

			const dtsResult = await generateDts(ensureArray(entry ?? entrypoints), {
				cwd: rootDir,
				preferredTsconfig: options.preferredTsconfig,
				splitting: getResolvedDtsSplitting(options.splitting, splitting),
				naming: {
					chunk: getDefaultChunkNaming(options.name),
				},
				root: options.sourceBase ? path.resolve(rootDir, options.sourceBase) : undefined,
				...dtsOptions,
				resolve: dtsResolve,
			});

			if (dtsResult.errors.length && !logger.isSilent()) {
				logIsolatedDeclarationErrors(dtsResult.errors);
			}

			for (const fmt of ensureArray(options.format)) {
				for (const file of dtsResult.files) {
					const dtsExtension = getDefaultDtsOutputExtention(fmt, packageType, file.kind);

					const pathRelativeToOutdir = cleanPath(
						`${file.pathInfo.outputPathWithoutExtension}${dtsExtension}`,
					);

					const pathRelativeToRootDir = cleanPath(`${options.outDir}/${pathRelativeToOutdir}`);

					const fullPath = path.join(rootDir, pathRelativeToRootDir);

					await Bun.write(fullPath, file.dts);

					buildOutputFiles.push({
						fullPath,
						pathRelativeToRootDir,
						pathRelativeToOutdir,
						dts: true,
						format: fmt,
						kind: file.kind,
						entrypoint: file.entrypoint,
						size: file.dts.length,
					});
				}
			}
		} catch (error) {
			throw new BunupDTSBuildError(parseErrorMessage(error));
		}
	}

	const buildResult: BuildResult = {
		files: buildOutputFiles,
		build: {
			options,
			meta: {
				packageJson,
				rootDir,
			},
		},
	};

	await runPluginBuildDoneHooks(bunupPlugins, {
		files: buildOutputFiles,
		options,
		meta: {
			packageJson,
			rootDir,
		},
	});

	if (options.onSuccess) {
		await executeOnSuccess(options.onSuccess, options, localAc.signal);
	}

	logger.log("");

	logger.log(
		`${options.name ? `  ${pc.bgBlueBright(` ${options.name} `)} ` : "  "}${logger.formatMessage({
			message: formatListWithAnd(entrypoints),
			muted: true,
			noIcon: true,
		})}`,
	);

	logger.log("");

	return buildResult;
}
