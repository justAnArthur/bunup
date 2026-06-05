import path from "node:path";
import type { BuildMetafile } from "bun";

const BUN_METAFILE_PATH_PREFIX_RE = /^\.(?:\/\.)?\//;

/*
	This function assumes the `metafile` option is enabled in Bun.build
	and also assumes the path is a entrypoint path.
*/
export function getOriginalEntrypointFromOutputPath(
	metafile: BuildMetafile | undefined,
	outputPath: string,
	rootDir: string,
): string {
	const output = metafile?.outputs[outputPath] ?? findOutputByPath(metafile, outputPath);
	const entryPoint = output?.entryPoint as string | undefined;
	if (!entryPoint) return "";

	const absoluteEntryPoint = path.isAbsolute(entryPoint) ? entryPoint : path.resolve(entryPoint);
	return path.relative(rootDir, absoluteEntryPoint);
}

function findOutputByPath(
	metafile: BuildMetafile | undefined,
	outputPath: string,
): BuildMetafile["outputs"][string] | undefined {
	if (!metafile) return undefined;

	const normalizedOutputPath = cleanPath(outputPath);

	for (const [key, output] of Object.entries(metafile.outputs)) {
		// Bun metafile keys can be emitted as "./file" or "././file" when outdir is set.
		const normalizedKey = cleanPath(key).replace(BUN_METAFILE_PATH_PREFIX_RE, "");
		if (normalizedOutputPath.endsWith(normalizedKey)) {
			return output;
		}
	}
}

function cleanPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}
