import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nextBin = fileURLToPath(new URL("./node_modules/next/dist/bin/next", import.meta.url));
const child = spawn(process.execPath, [nextBin, "dev"], {
  env: process.env,
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
