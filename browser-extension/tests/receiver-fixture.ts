import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
export const receiverToken = "blackbox-capture-v1";
export async function receiverFixture() {
  const directory = await mkdtemp(join(tmpdir(), "capture-receiver-"));
  let child: ChildProcess;
  async function start() {
    child = spawn(
      process.env.PYTHON ?? "python3",
      [
        resolve("../server.py"),
        "--no-analysis",
        "--host",
        "127.0.0.1",
        "--data-dir",
        directory,
        "--port",
        "0",
      ],
      {
        env: {
          ...process.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Receiver startup timed out"));
      }, 10000);
      let data = "",
        errors = "";
      child.stderr!.on("data", (chunk) => {
        errors += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(Error(`Receiver exited ${code}: ${errors}`));
      });
      child.stdout!.on("data", (chunk) => {
        data += String(chunk);
        if (data.includes("\n")) {
          clearTimeout(timer);
          resolve(JSON.parse(data.split("\n")[0]).url);
        }
      });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const done = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    await done;
  }
  const url = await start();
  return {
    settings: { url, project: "default" },
    directory,
    stop,
    start,
    close: async () => {
      await stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
