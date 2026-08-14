import { spawn } from "node:child_process";

const mode = process.argv[2];
const args =
  mode === "dev"
    ? ["--import", "tsx", "--watch", "src/index.ts"]
    : ["--import", "tsx", "src/index.ts"];
const child = spawn(process.execPath, args, { env: process.env, stdio: "inherit" });

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
