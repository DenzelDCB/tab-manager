
import { build } from "esbuild";

const files = [
  "popup.js",
  "service_worker.js",
  "enroll.js"
];

for (const file of files) {
  await build({
    entryPoints: [file],
    bundle: true,
    outfile: `dist/${file}`,
    platform: "browser",
    format: "esm",
    target: "chrome120"
  });

  console.log(`Built ${file}`);
}
