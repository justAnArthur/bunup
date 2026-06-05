import { createProject, runBuild } from "./test/utils.ts";

const projectDir = "/tmp/test-barrel-issue";

// Clean up if exists
try {
  await Bun.spawn(["rm", "-rf", projectDir]).exited;
} catch (e) {}

// Create project
createProject({
  "package.json": JSON.stringify({
    name: "test-barrel",
    version: "1.0.0",
  }),
  "src/fields/MetaField.ts": 'export const MetaField = "meta";',
  "src/fields/TitleField.ts": 'export const TitleFieldComponent = "title";',
  "src/fields/GenerateButton.ts": 'export const GenerateButton = "generate";',
  "src/fields/MetaPreview.ts": 'export const MetaPreview = "preview";',
  "src/fields/DescriptionField.ts": 'export const DescriptionFieldComponent = "description";',
  "src/exports/fields.ts": `
export { MetaField } from '../fields/MetaField';
export { TitleFieldComponent } from '../fields/TitleField';
export { GenerateButton } from '../fields/GenerateButton';
export { MetaPreview } from '../fields/MetaPreview';
export { DescriptionFieldComponent } from '../fields/DescriptionField';
  `,
});

const result = await runBuild({
  entry: "src/exports/fields.ts",
  format: "esm",
});

console.log("Build success:", result.success);

// Find the output file
const outputFile = result.files.find(f => f.path.includes("fields"));
if (outputFile) {
  console.log("\n=== OUTPUT FILE CONTENT ===");
  console.log(outputFile.content);
}
