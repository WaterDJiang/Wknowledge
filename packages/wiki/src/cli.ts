import path from "node:path";
import { lintWikiDirectory } from "./index";

const dataRoot = path.resolve(process.env.WKNOWLEDGE_DATA_ROOT ?? "../../data/spaces");
const target = process.argv[2];
if (!target) {
  console.error("用法: pnpm --filter @wknowledge/wiki wiki:lint <space-id>");
  process.exitCode = 2;
} else {
  const issues = await lintWikiDirectory(path.join(dataRoot, target, "wiki"));
  if (issues.length > 0) {
    console.error(JSON.stringify(issues, null, 2));
    process.exitCode = 1;
  } else {
    console.log(`Wiki lint passed: ${target}`);
  }
}
